import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { CONTAINER_NAME, type ClusterNode, type Deployment } from '../shared/types.js';
import {
  appendDeploymentLog,
  createDeployment,
  createEdge,
  deleteEdge,
  finishDeployment,
  getClusterSecrets,
  getNode,
  getNodeSsh,
  getSettings,
  kv,
  listEdges,
  listNodes,
  setNodeDeployed,
} from './db.js';
import { broadcast, emitEvent } from './hub.js';
import { detectRuntime, q, withSsh, type SshSession } from './ssh.js';
import { computeRoles, generateFiles, imageRef, targetsOf, validate, type Topology } from './topology.js';
import { paths } from './env.js';
import { liveSnapshot } from './monitor.js';
import { buildContext, SERVICE_DIR } from './sources.js';

export type NodeAction = 'deploy' | 'start' | 'stop' | 'restart' | 'remove' | 'destroy';

let running: Deployment | null = null;

export function currentDeployment(): Deployment | null {
  return running;
}

export function topology(): Topology {
  return { nodes: listNodes(), edges: listEdges() };
}

export function validateTopology() {
  const live = liveSnapshot();
  const roles = Object.fromEntries(Object.entries(live).filter(([, l]) => l.status === 'up').map(([id, l]) => [id, l.role]));
  const v = validate(topology(), getSettings(), getNodeSsh, getClusterSecrets(), roles);
  // Deployed nodes whose configuration no longer matches the topology (e.g. a node added later)
  for (const n of topology().nodes) {
    const stored = kv.get<string>(`cfg:${n.id}`);
    if (!n.deployedAt || !stored) continue;
    let current: string;
    try {
      current = configHash(n);
    } catch {
      continue;
    }
    if (current !== stored) {
      v.issues.push({
        level: 'warning',
        nodeId: n.id,
        code: 'stale',
        message:
          n.type === 'pgpool'
            ? `${n.name}: deployed with an older topology (backends or watchdog members changed). Redeploy it: all Pgpool-II nodes must share the same configuration.`
            : `${n.name}: the topology changed since it was deployed. Redeploy it to apply the change.`,
      });
    }
  }
  return v;
}

/** Hash of the configuration files the topology generates for a node (compared with the deployed one). */
function configHash(node: ClusterNode): string {
  const t = topology();
  const { files } = generateFiles(node, { topology: t, settings: getSettings(), secrets: getClusterSecrets(), sshOf: getNodeSsh, dbRuntime: dbRuntimeFor(t) });
  return hashFiles(files);
}
function hashFiles(files: Record<string, string>): string {
  const h = crypto.createHash('sha256');
  for (const k of Object.keys(files).sort()) h.update(`${k}\0${files[k]}\0`);
  return h.digest('hex');
}

export function runtimeOf(nodeId: string): 'docker' | 'podman' | undefined {
  return kv.get<'docker' | 'podman'>(`runtime:${nodeId}`);
}

class Logger {
  constructor(private readonly deploymentId: string) {}
  line(text: string, level: 'info' | 'cmd' | 'ok' | 'warn' | 'error' | 'out' = 'info'): void {
    const stamp = new Date().toISOString().slice(11, 19);
    const line = `${stamp} ${text}`;
    appendDeploymentLog(this.deploymentId, `[${level}] ${line}`);
    broadcast({ type: 'log', deploymentId: this.deploymentId, line, level });
  }
  /** Stream remote command output line by line. */
  stream(): (chunk: string) => void {
    let buf = '';
    let last = 0;
    return (chunk: string) => {
      buf += chunk;
      const parts = buf.split(/\r?\n|\r/);
      buf = parts.pop() ?? '';
      for (const p of parts) {
        const text = p.trim();
        if (!text) continue;
        // pull progress bars are very chatty: keep at most ~5 lines per second
        const now = Date.now();
        if (/Downloading|Extracting|Waiting|Pulling fs layer/.test(text) && now - last < 200) continue;
        last = now;
        this.line(`  │ ${text}`, 'out');
      }
    };
  }
}

/** Run a job exclusively; the HTTP request returns immediately with the deployment id. */
function startJob(action: string, target: string, job: (log: Logger) => Promise<void>): Deployment {
  if (running) throw Object.assign(new Error(`Another operation is running (${running.action} ${running.target})`), { statusCode: 409 });
  const d = createDeployment(action, target);
  running = d;
  broadcast({ type: 'deployment', deployment: d });
  const log = new Logger(d.id);
  void (async () => {
    let status: 'success' | 'failed' = 'success';
    try {
      await job(log);
      log.line(`✔ ${action} ${target} finished`, 'ok');
    } catch (e) {
      status = 'failed';
      log.line(`✖ ${(e as Error).message}`, 'error');
      emitEvent('error', `${action} ${target} failed: ${(e as Error).message.split('\n')[0]}`);
    } finally {
      running = null;
      const done = finishDeployment(d.id, status);
      broadcast({ type: 'deployment', deployment: done });
      broadcast({ type: 'topology' });
    }
  })();
  return d;
}

// ------------------------------------------------------------------ helpers

async function nodeDir(s: SshSession, node: ClusterNode): Promise<string> {
  const base = await s.resolvePath(getSettings().remoteDir);
  return path.posix.join(base, node.name);
}

async function ensureImage(s: SshSession, rt: string, node: ClusterNode, log: Logger): Promise<string> {
  const settings = getSettings();
  const ref = imageRef(settings, node.type);
  const has = async () => (await s.exec(`${rt} image inspect ${q(ref)} >/dev/null 2>&1`, { sudo: true })).code === 0;

  if (settings.images.source === 'hub') {
    log.line(`Pulling ${ref}`, 'cmd');
    await s.run(`${rt} pull ${q(ref)}`, { sudo: true, onData: log.stream() });
    return ref;
  }
  if (settings.images.source === 'build') {
    return buildImage(s, rt, node, ref, log);
  }
  if (await has()) {
    log.line(`Image ${ref} is present on the host`, 'ok');
    return ref;
  }
  if (settings.images.source === 'local') {
    throw new Error(
      `Image ${ref} not found on the host. Build or load it there (docker/${node.type === 'postgres' ? 'db' : node.type}/BUILD.sh), or choose "Docker Hub" or "tar.gz" as image source.`,
    );
  }
  // tarball: upload the archives once (skipped when the same size is already there) and load them
  const imagesDir = path.posix.join(await s.resolvePath(settings.remoteDir), 'images');
  await s.run(`mkdir -p ${q(imagesDir)}`);
  for (const file of settings.images.tarballs) {
    const local = path.join(paths.images, path.basename(file));
    if (!fs.existsSync(local)) throw new Error(`Archive ${file} is missing in the launcher data directory`);
    const remote = path.posix.join(imagesDir, path.basename(file));
    const size = fs.statSync(local).size;
    if ((await s.remoteSize(remote)) !== size) {
      log.line(`Uploading ${file} (${(size / 1048576).toFixed(1)} MB)`, 'cmd');
      await s.uploadFile(local, remote, (pct) => log.line(`  │ upload ${file}: ${pct}%`, 'out'));
    } else {
      log.line(`${file} already uploaded`, 'ok');
    }
    log.line(`Loading ${file}`, 'cmd');
    await s.run(`${rt} load -i ${q(remote)}`, { sudo: true, onData: log.stream() });
    if (await has()) return ref;
  }
  if (await has()) return ref;
  throw new Error(`Image ${ref} is not inside the uploaded archives (${settings.images.tarballs.join(', ')}). Check image names/tag in Settings.`);
}

/**
 * "build" image source: copy the PgCloud build context bundled in the launcher to the host over
 * SFTP and run `docker|podman build` there. Images carry a label with the hash of their sources,
 * so they are rebuilt only when the sources change.
 */
async function buildImage(s: SshSession, rt: string, node: ClusterNode, ref: string, log: Logger): Promise<string> {
  const ctx = buildContext(node.type);
  const current = (
    await s.exec(`${rt} image inspect -f '{{ index .Config.Labels "pgcloud.src" }}' ${q(ref)} 2>/dev/null`, { sudo: true })
  ).stdout.trim();
  if (current === ctx.hash) {
    log.line(`Image ${ref} is up to date (sources ${ctx.hash})`, 'ok');
    return ref;
  }
  log.line(
    current ? `Sources changed (${current} → ${ctx.hash}): rebuilding ${ref}` : `Building ${ref} on the host (sources ${ctx.hash})`,
    'cmd',
  );
  const dir = path.posix.join(await s.resolvePath(getSettings().remoteDir), 'build', SERVICE_DIR[node.type]);
  await s.run(`rm -rf -- ${q(dir)} && mkdir -p ${q(dir)}`);
  const dirs = new Set(ctx.files.map((f) => path.posix.dirname(path.posix.join(dir, f))));
  await s.run(`mkdir -p ${[...dirs].map(q).join(' ')}`);
  for (const f of ctx.files) {
    await s.writeFile(path.posix.join(dir, f), fs.readFileSync(path.join(ctx.root, f), 'utf8'), 0o644);
  }
  log.line(`Uploaded ${ctx.files.length} files to ${dir}`);
  log.line(`${rt} build -t ${ref} -f ${ctx.dockerfile} (this can take a few minutes the first time)`, 'cmd');
  await s.run(
    `${rt} build --label pgcloud.src=${ctx.hash} -t ${q(ref)} -f ${q(path.posix.join(dir, ctx.dockerfile))} ${q(dir)}`,
    { sudo: true, onData: log.stream() },
  );
  log.line(`Image ${ref} built`, 'ok');
  return ref;
}

function healthCommand(rt: string, node: ClusterNode): string {
  const port = Number((node.config as Record<string, unknown>).port);
  return `${rt} exec ${CONTAINER_NAME[node.type]} pg_isready -q -h 127.0.0.1 -p ${port}`;
}

async function waitHealthy(s: SshSession, rt: string, node: ClusterNode, log: Logger, timeoutSec = 240): Promise<void> {
  const name = CONTAINER_NAME[node.type];
  log.line(`Waiting for ${node.name} to accept connections…`);
  const start = Date.now();
  while ((Date.now() - start) / 1000 < timeoutSec) {
    const state = (await s.exec(`${rt} inspect -f '{{.State.Status}}' ${name}`, { sudo: true })).stdout.trim();
    if (state === 'exited' || state === 'dead') {
      const logs = await s.exec(`${rt} logs --tail 30 ${name} 2>&1`, { sudo: true });
      logs.stdout.split('\n').filter(Boolean).forEach((l) => log.line(`  │ ${l}`, 'out'));
      throw new Error(`${node.name}: container stopped during startup (see logs above)`);
    }
    if ((await s.exec(healthCommand(rt, node), { sudo: true })).code === 0) {
      log.line(`${node.name} is up (${Math.round((Date.now() - start) / 1000)} s)`, 'ok');
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`${node.name}: not ready after ${timeoutSec} s`);
}

function runCommand(rt: string, node: ClusterNode, dir: string, ref: string, hostHasLocaltime: boolean): string {
  const z = rt.endsWith('podman') ? ':z' : '';
  const envPath = `${dir}/.env`;
  const base = [
    `${rt} run -d --name ${CONTAINER_NAME[node.type]}`,
    '--restart unless-stopped',
    '--network host',
    `--label pgcloud.node=${q(node.name)}`,
    `--env-file ${q(envPath)}`,
  ];
  // Share the host timezone only when the file exists (minimal hosts have none and the mount would fail)
  if (hostHasLocaltime) base.push('-v /etc/localtime:/etc/localtime:ro');
  if (node.type === 'postgres') {
    base.push('--stop-timeout 60', `-v pgcloud_${node.name}_data:/opt/pgdata`, `-v ${q(envPath)}:/opt/pgcloud/.env${z}`);
  } else if (node.type === 'pgpool') {
    for (const sub of ['pgpool', 'postgres', 'pgbouncer'])
      base.push(`-v ${q(`${dir}/conf/${sub}`)}:/opt/pgcloud/conf/${sub}:ro${z ? ',z' : ''}`);
  }
  base.push(q(ref));
  return base.join(' ');
}

/** Runtime binary that pgpool must use on the PostgreSQL hosts (shell fallback when unknown or mixed). */
function dbRuntimeFor(t: Topology): string {
  const rts = new Set(t.nodes.filter((n) => n.type === 'postgres').map((n) => runtimeOf(n.id) ?? 'unknown'));
  if (rts.size === 1 && !rts.has('unknown')) return [...rts][0];
  return '$(command -v docker || command -v podman)';
}

// ------------------------------------------------------------------ per node operations

async function deployNode(node: ClusterNode, log: Logger): Promise<void> {
  const settings = getSettings();
  const t = topology();
  const role = computeRoles(t)[node.id];
  log.line(`━━ ${node.name} · ${node.type} (${role}) → ${node.address}`, 'info');
  await withSsh(getNodeSsh(node.id), async (s) => {
    const runtime = await detectRuntime(s, settings.runtime);
    kv.set(`runtime:${node.id}`, runtime.bin);
    const rt = runtime.bin;
    log.line(`Runtime: ${runtime.bin} ${runtime.version}`, 'ok');

    const ref = await ensureImage(s, rt, node, log);

    const dir = await nodeDir(s, node);
    const { files } = generateFiles(node, {
      topology: t,
      settings,
      secrets: getClusterSecrets(),
      sshOf: getNodeSsh,
      dbRuntime: dbRuntimeFor(t),
    });
    const dirs = new Set(Object.keys(files).map((f) => path.posix.dirname(path.posix.join(dir, f))));
    await s.run(`mkdir -p ${[...dirs].map(q).join(' ')} && chmod 700 ${q(dir)}`);
    for (const [rel, content] of Object.entries(files)) {
      await s.writeFile(path.posix.join(dir, rel), content, 0o600);
      log.line(`Wrote ${path.posix.join(dir, rel)}`);
    }
    kv.set(`cfg:${node.id}`, hashFiles(files));

    await s.exec(`${rt} rm -f -v ${CONTAINER_NAME[node.type]} >/dev/null 2>&1`, { sudo: true });
    const hasLocaltime = (await s.exec('test -f /etc/localtime')).code === 0;
    const cmd = runCommand(rt, node, dir, ref, hasLocaltime);
    log.line(cmd.replace(/--env-file \S+/, '--env-file …'), 'cmd');
    await s.run(cmd, { sudo: true, onData: log.stream() });
    await waitHealthy(s, rt, node, log);
  });
  setNodeDeployed(node.id, true);
  emitEvent('success', `${node.name} deployed`, node.id);
}

async function containerAction(node: ClusterNode, action: Exclude<NodeAction, 'deploy'>, log: Logger): Promise<void> {
  const settings = getSettings();
  log.line(`━━ ${action} ${node.name} (${node.address})`);
  await withSsh(getNodeSsh(node.id), async (s) => {
    const rt = runtimeOf(node.id) ?? (await detectRuntime(s, settings.runtime)).bin;
    const name = CONTAINER_NAME[node.type];
    if (action === 'start' || action === 'stop' || action === 'restart') {
      log.line(`${rt} ${action} ${name}`, 'cmd');
      await s.run(`${rt} ${action} ${name}`, { sudo: true, onData: log.stream() });
      if (action !== 'stop') await waitHealthy(s, rt, node, log, 120);
    } else {
      log.line(`${rt} rm -f -v ${name}`, 'cmd');
      await s.exec(`${rt} rm -f -v ${name}`, { sudo: true, onData: log.stream() });
      if (action === 'destroy') {
        if (node.type === 'postgres') {
          log.line(`${rt} volume rm pgcloud_${node.name}_data`, 'cmd');
          await s.exec(`${rt} volume rm pgcloud_${node.name}_data`, { sudo: true, onData: log.stream() });
        }
        const dir = await nodeDir(s, node);
        log.line(`Removing ${dir}`, 'cmd');
        await s.run(`rm -rf -- ${q(dir)}`, { sudo: true });
      }
      setNodeDeployed(node.id, false);
    }
  });
  emitEvent(action === 'stop' || action === 'remove' || action === 'destroy' ? 'warn' : 'info', `${node.name}: ${action}`, node.id);
}

/**
 * Synchronous replication is switched off when a replica is promoted (no standby yet). After a cluster
 * deployment, restore what the topology asks for, but only if a replica is actually streaming.
 */
async function syncReplication(log: Logger): Promise<void> {
  const t = topology();
  const roles = computeRoles(t);
  const primary = t.nodes.find((n) => n.type === 'postgres' && roles[n.id] === 'primary');
  const replicas = t.nodes.filter((n) => n.type === 'postgres' && roles[n.id] === 'replica');
  if (!primary) return;
  const wanted = (primary.config as { synchronous?: boolean }).synchronous && replicas.length > 0 ? 'FIRST 1 (*)' : '';
  const settings = getSettings();
  await withSsh(getNodeSsh(primary.id), async (s) => {
    const rt = runtimeOf(primary.id) ?? (await detectRuntime(s, settings.runtime)).bin;
    const psql = (sql: string) =>
      `${rt} exec ${CONTAINER_NAME.postgres} psql -At -U ${q(settings.cluster.user)} -d ${q(settings.cluster.database)} -c ${q(sql)}`;
    const current = (await s.exec(psql('SHOW synchronous_standby_names'), { sudo: true })).stdout.trim();
    if (current === wanted) return;
    if (wanted) {
      const streaming = Number((await s.exec(psql("SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming'"), { sudo: true })).stdout.trim());
      if (!streaming) {
        log.line(`${primary.name}: no replica streaming yet; synchronous replication stays off`, 'warn');
        return;
      }
    }
    await s.run(psql(`ALTER SYSTEM SET synchronous_standby_names = '${wanted}'`), { sudo: true });
    await s.run(psql('SELECT pg_reload_conf()'), { sudo: true });
    log.line(`${primary.name}: synchronous_standby_names = '${wanted}'`, 'ok');
  });
}

/**
 * Planned work on PostgreSQL nodes (redeploy, restart) stops their containers for a moment.
 * A running Pgpool-II would take that for a crash and fail over (promote a replica while the old
 * primary comes back = two primaries), so the deployed Pgpool-II containers are paused meanwhile.
 */
async function withPgpoolPaused<T>(log: Logger, fn: () => Promise<T>): Promise<T> {
  const pools = listNodes().filter((n) => n.type === 'pgpool' && n.deployedAt);
  // All at once: one by one, a Pgpool-II still running could fail over while the others stop
  const results = await Promise.all(
    pools.map(async (p) => {
      try {
        await onNode(p, async (s, rt) => {
          log.line(`Pausing ${p.name} during planned maintenance (avoids an unwanted failover)`, 'cmd');
          await s.exec(`${rt} stop -t 10 ${CONTAINER_NAME.pgpool}`, { sudo: true });
        });
        return p;
      } catch (e) {
        log.line(`Could not pause ${p.name}: ${(e as Error).message}`, 'warn');
        return null;
      }
    }),
  );
  const paused = results.filter((p): p is ClusterNode => !!p);
  try {
    return await fn();
  } finally {
    await Promise.all(
      paused.map(async (p) => {
        try {
          await onNode(p, async (s, rt) => {
            const state = (await s.exec(`${rt} inspect -f '{{.State.Status}}' ${CONTAINER_NAME.pgpool}`, { sudo: true })).stdout.trim();
            if (state !== 'running') {
              log.line(`Resuming ${p.name}`, 'cmd');
              await s.run(`${rt} start ${CONTAINER_NAME.pgpool}`, { sudo: true });
            }
          });
        } catch (e) {
          log.line(`Could not resume ${p.name}: ${(e as Error).message}`, 'error');
        }
      }),
    );
  }
}

export function runNodeAction(nodeId: string, action: NodeAction): Deployment {
  const node = getNode(nodeId);
  if (!node) throw Object.assign(new Error('Node not found'), { statusCode: 404 });
  if (action === 'deploy') {
    const v = validateTopology();
    const blocking = v.issues.filter((i) => i.level === 'error' && (!i.nodeId || i.nodeId === nodeId));
    if (blocking.length) throw Object.assign(new Error(blocking.map((i) => i.message).join('\n')), { statusCode: 400 });
    if (node.type === 'pgpool') {
      // The watchdog only accepts members with the same configuration: (re)deploy every Pgpool-II node together
      const pools = [node, ...listNodes().filter((n) => n.type === 'pgpool' && n.deployedAt && n.id !== node.id)];
      return startJob('deploy', pools.map((p) => p.name).join(', '), async (log) => {
        if (pools.length > 1) log.line(`Pgpool-II nodes share the watchdog and backend configuration: deploying ${pools.map((p) => p.name).join(', ')}`);
        for (const p of pools) await deployNode(p, log);
      });
    }
    return startJob('deploy', node.name, (log) =>
      node.type === 'postgres' ? withPgpoolPaused(log, () => deployNode(node, log)) : deployNode(node, log),
    );
  }
  if (node.type === 'postgres' && action === 'restart') {
    return startJob(action, node.name, (log) => withPgpoolPaused(log, () => containerAction(node, action, log)));
  }
  return startJob(action, node.name, (log) => containerAction(node, action, log));
}

export function deployAll(): Deployment {
  const v = validateTopology();
  if (!v.ok)
    throw Object.assign(new Error(v.issues.filter((i) => i.level === 'error').map((i) => i.message).join('\n')), {
      statusCode: 400,
    });
  return startJob('deploy', 'cluster', async (log) => {
    log.line(`Deploying ${v.plan.length} nodes: ${v.plan.map((p) => `${p.name}(${p.role})`).join(' → ')}`);
    emitEvent('info', `Cluster deployment started (${v.plan.length} nodes)`);
    await withPgpoolPaused(log, async () => {
      for (const step of v.plan) {
        const node = getNode(step.nodeId);
        if (node) await deployNode(node, log);
      }
    });
    await syncReplication(log).catch((e) => log.line(`Could not set synchronous replication: ${(e as Error).message}`, 'warn'));
    emitEvent('success', 'Cluster deployment finished');
  });
}

/** Last lines of a node's container logs (for the inspector). */
export async function containerLogs(nodeId: string, lines = 200): Promise<string> {
  const node = getNode(nodeId);
  if (!node) throw Object.assign(new Error('Node not found'), { statusCode: 404 });
  return withSsh(getNodeSsh(nodeId), async (s) => {
    const rt = runtimeOf(nodeId) ?? (await detectRuntime(s, getSettings().runtime)).bin;
    const r = await s.exec(`${rt} logs --tail ${Math.min(2000, lines)} ${CONTAINER_NAME[node.type]} 2>&1`, { sudo: true });
    return r.stdout || r.stderr;
  });
}

/** Check SSH access and container runtime of a node. */
export async function testNode(nodeId: string): Promise<{ ok: boolean; message: string; runtime?: string; os?: string }> {
  try {
    return await withSsh(getNodeSsh(nodeId), async (s) => {
      const os = (await s.exec('. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || uname -sr')).stdout.trim();
      const runtime = await detectRuntime(s, getSettings().runtime);
      kv.set(`runtime:${nodeId}`, runtime.bin);
      return { ok: true, message: `Connected. ${runtime.bin} ${runtime.version}`, runtime: `${runtime.bin} ${runtime.version}`, os };
    });
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

// ------------------------------------------------------------------ manual switchover / watchdog leader

const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run `fn` over SSH on a node, with its container runtime binary. */
async function onNode<T>(node: ClusterNode, fn: (s: SshSession, rt: string) => Promise<T>): Promise<T> {
  return withSsh(getNodeSsh(node.id), async (s) => fn(s, runtimeOf(node.id) ?? (await detectRuntime(s, getSettings().runtime)).bin));
}

/** psql inside the PostgreSQL container of a node (local socket, cluster superuser). */
function psqlCmd(rt: string, sql: string): string {
  const c = getSettings().cluster;
  return `${rt} exec ${CONTAINER_NAME.postgres} psql -At -U ${q(c.user)} -d ${q(c.database)} -c ${q(sql)}`;
}

async function pgQuery(node: ClusterNode, sql: string): Promise<string> {
  return onNode(node, async (s, rt) => {
    const r = await s.exec(psqlCmd(rt, sql), { sudo: true });
    if (r.code !== 0) throw new Error(`${node.name}: ${(r.stderr || r.stdout).trim()}`);
    return r.stdout.trim();
  });
}

const pgPort = (n: ClusterNode) => Number((n.config as Record<string, unknown>).port);

/**
 * Make `primary` the only PostgreSQL primary in the topology: every other PostgreSQL node becomes its
 * replica and PgBouncer nodes that pointed straight at the old primary now point at the new one.
 */
export function adoptPrimary(primaryId: string): void {
  const t = topology();
  const pgs = t.nodes.filter((n) => n.type === 'postgres');
  const old = t.nodes.filter((n) => n.type === 'postgres' && computeRoles(t)[n.id] === 'primary' && n.id !== primaryId);
  for (const e of t.edges) {
    const s = pgs.find((n) => n.id === e.source);
    const d = pgs.find((n) => n.id === e.target);
    if (s && d) deleteEdge(e.id);
  }
  for (const n of pgs) if (n.id !== primaryId) createEdge(n.id, primaryId);
  for (const e of t.edges) {
    const src = t.nodes.find((n) => n.id === e.source);
    if (src?.type === 'pgbouncer' && old.some((o) => o.id === e.target)) {
      deleteEdge(e.id);
      if (!t.edges.some((x) => x.source === src.id && x.target === primaryId)) createEdge(src.id, primaryId);
    }
  }
}

/** Write the generated configuration of a node to its host without touching the container. */
async function writeNodeFiles(node: ClusterNode, log: Logger): Promise<void> {
  const t = topology();
  await onNode(node, async (s) => {
    const dir = await nodeDir(s, node);
    const { files } = generateFiles(node, { topology: t, settings: getSettings(), secrets: getClusterSecrets(), sshOf: getNodeSsh, dbRuntime: dbRuntimeFor(t) });
    for (const [rel, content] of Object.entries(files)) {
      if (rel.endsWith('.keep')) continue;
      await s.writeFile(path.posix.join(dir, rel), content, 0o600);
    }
    kv.set(`cfg:${node.id}`, hashFiles(files));
  });
  log.line(`${node.name}: configuration files updated`);
}

/**
 * Planned switchover: `targetId` (a streaming replica) becomes the primary and the current primary
 * becomes its replica, without losing committed transactions:
 *   pause Pgpool-II → stop the primary cleanly (its last WAL reaches the replicas) → wait until the
 *   target replayed it → promote the target → point the other replicas at it → resync the old primary
 *   with pg_rewind and start it as a replica → update the topology → redeploy Pgpool-II (and
 *   PgBouncer nodes connected straight to PostgreSQL) → restore synchronous replication.
 */
export function switchover(targetId: string): Deployment {
  const target = getNode(targetId);
  if (!target || target.type !== 'postgres') throw fail('Choose a PostgreSQL node');
  const live = liveSnapshot();
  const pgs = listNodes().filter((n) => n.type === 'postgres');
  const primaries = pgs.filter((n) => live[n.id]?.status === 'up' && live[n.id]?.role === 'primary');
  if (primaries.length !== 1) throw fail(`Expected exactly one running primary, found ${primaries.length}`);
  const oldPrimary = primaries[0];
  if (oldPrimary.id === target.id) throw fail(`${target.name} is already the primary`);
  if (live[target.id]?.status !== 'up' || live[target.id]?.role !== 'replica') throw fail(`${target.name} must be a running replica`);
  const down = pgs.filter((n) => n.deployedAt && live[n.id]?.status !== 'up');
  if (down.length) throw fail(`These PostgreSQL nodes are not running: ${down.map((n) => n.name).join(', ')}`);
  const others = pgs.filter((n) => n.id !== target.id && n.id !== oldPrimary.id && live[n.id]?.status === 'up');

  return startJob('switchover', `${oldPrimary.name} → ${target.name}`, async (log) => {
    emitEvent('info', `Switchover started: ${oldPrimary.name} → ${target.name}`, target.id);
    const lag = await pgQuery(target, "SELECT status FROM pg_stat_wal_receiver");
    if (lag !== 'streaming') throw new Error(`${target.name} is not streaming from the primary (${lag || 'no WAL receiver'})`);

    let promoted = false;
    await withPgpoolPaused(log, async () => {
      // 1. stop the primary cleanly: the shutdown checkpoint is streamed to the replicas
      let checkpoint = '';
      await onNode(oldPrimary, async (s, rt) => {
        log.line(`${oldPrimary.name}: stopping cleanly (no writes are accepted from now on)`, 'cmd');
        await s.run(`${rt} stop -t 60 ${CONTAINER_NAME.postgres}`, { sudo: true });
        const image = (await s.exec(`${rt} inspect -f '{{.Config.Image}}' ${CONTAINER_NAME.postgres}`, { sudo: true })).stdout.trim();
        const ctl = await s.run(
          `${rt} run --rm --volumes-from ${CONTAINER_NAME.postgres} --entrypoint pg_controldata ${q(image)} -D /opt/pgdata`,
          { sudo: true },
        );
        checkpoint = /Latest checkpoint location:\s*(\S+)/.exec(ctl)?.[1] ?? '';
      });
      if (!checkpoint) throw new Error(`${oldPrimary.name}: could not read its last checkpoint`);
      log.line(`${oldPrimary.name}: stopped at WAL ${checkpoint}`, 'ok');

      try {
        // 2. wait until the target replayed everything
        const start = Date.now();
        for (;;) {
          const caught = await pgQuery(target, `SELECT pg_wal_lsn_diff(pg_last_wal_replay_lsn(), '${checkpoint}') >= 0`);
          if (caught === 't') break;
          if (Date.now() - start > 60_000) throw new Error(`${target.name} did not replay WAL ${checkpoint} within 60 s`);
          await sleep(1000);
        }
        log.line(`${target.name}: replayed every transaction of ${oldPrimary.name}`, 'ok');

        // 3. promote the target
        await onNode(target, async (s, rt) => {
          log.line(`${target.name}: pgcloud_promote`, 'cmd');
          await s.run(
            `${rt} exec ${CONTAINER_NAME.postgres} pgcloud_promote ${target.address} ${pgPort(target)} ${oldPrimary.address} ${pgPort(oldPrimary)}`,
            { sudo: true, onData: log.stream() },
          );
        });
        for (let i = 0; i < 30 && (await pgQuery(target, 'SELECT pg_is_in_recovery()')) !== 'f'; i++) await sleep(1000);
        if ((await pgQuery(target, 'SELECT pg_is_in_recovery()')) !== 'f') throw new Error(`${target.name} did not leave recovery`);
        promoted = true;
        log.line(`${target.name} is the new primary`, 'ok');
      } catch (e) {
        if (!promoted) {
          log.line(`Rolling back: starting ${oldPrimary.name} again as the primary`, 'warn');
          await onNode(oldPrimary, (s, rt) => s.run(`${rt} start ${CONTAINER_NAME.postgres}`, { sudo: true }));
        }
        throw e;
      }

      // 4. the other replicas follow the new primary
      for (const r of others) {
        await onNode(r, async (s, rt) => {
          log.line(`${r.name}: pgcloud_redirect → ${target.name}`, 'cmd');
          await s.run(
            `${rt} exec ${CONTAINER_NAME.postgres} pgcloud_redirect ${target.address} ${pgPort(target)} ${oldPrimary.address} ${pgPort(oldPrimary)}`,
            { sudo: true, onData: log.stream() },
          );
        });
      }

      // 5. the old primary becomes a replica of the new one
      await onNode(oldPrimary, async (s, rt) => {
        const image = (await s.exec(`${rt} inspect -f '{{.Config.Image}}' ${CONTAINER_NAME.postgres}`, { sudo: true })).stdout.trim();
        log.line(`${oldPrimary.name}: pgcloud_rewind → replica of ${target.name}`, 'cmd');
        await s.run(
          `${rt} run --rm --network host --volumes-from ${CONTAINER_NAME.postgres} --entrypoint pgcloud_rewind ${q(image)} ${target.address} ${pgPort(target)}`,
          { sudo: true, onData: log.stream() },
        );
        await s.run(`${rt} start ${CONTAINER_NAME.postgres}`, { sudo: true });
        await waitHealthy(s, rt, oldPrimary, log, 180);
      });
      for (let i = 0; i < 30; i++) {
        if ((await pgQuery(oldPrimary, "SELECT status FROM pg_stat_wal_receiver").catch(() => '')) === 'streaming') break;
        await sleep(1000);
      }
      log.line(`${oldPrimary.name} is streaming from ${target.name}`, 'ok');

      // 6. topology + configuration files follow the new roles
      adoptPrimary(target.id);
      broadcast({ type: 'topology' });
      for (const n of listNodes().filter((x) => x.type === 'postgres' && x.deployedAt)) await writeNodeFiles(n, log);

      // 7. Pgpool-II (and PgBouncer nodes in front of PostgreSQL) get the new backend list
      const t = topology();
      for (const n of t.nodes.filter((x) => x.deployedAt && (x.type === 'pgpool' || (x.type === 'pgbouncer' && targetsOf(t, x.id).some((d) => d.type === 'postgres'))))) {
        await deployNode(n, log);
      }
    });
    await syncReplication(log).catch((e) => log.line(`Could not set synchronous replication: ${(e as Error).message}`, 'warn'));
    emitEvent('success', `Switchover finished: ${target.name} is the primary, ${oldPrimary.name} a replica`, target.id);
  });
}

/** Watchdog state of the Pgpool-II cluster, as seen by one running Pgpool-II node. */
export async function watchdogInfo(): Promise<{ leader: string | null; nodes: Array<{ host: string; port: number; status: string }> }> {
  const pools = listNodes().filter((n) => n.type === 'pgpool' && n.deployedAt);
  let lastError = 'no deployed Pgpool-II node';
  for (const p of pools) {
    try {
      const out = await onNode(p, async (s, rt) => {
        const r = await s.exec(`${rt} exec ${CONTAINER_NAME.pgpool} ./script/getrole.sh`, { sudo: true });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || 'pcp_watchdog_info failed');
        return r.stdout;
      });
      return parseWatchdog(out);
    } catch (e) {
      lastError = `${p.name}: ${(e as Error).message}`;
    }
  }
  throw fail(lastError, 502);
}

/** Parse `pcp_watchdog_info -v`. */
export function parseWatchdog(out: string): { leader: string | null; nodes: Array<{ host: string; port: number; status: string }> } {
  const leader = /Leader Host Name\s*:\s*(\S+)/.exec(out)?.[1] ?? null;
  const nodes: Array<{ host: string; port: number; status: string }> = [];
  const section = out.split(/Watchdog Node Information/)[1] ?? '';
  for (const block of section.split(/\nNode Name\s*:/).slice(1)) {
    const host = /Host Name\s*:\s*(\S+)/.exec(block)?.[1];
    const port = Number(/Pgpool port\s*:\s*(\d+)/.exec(block)?.[1] ?? 0);
    const status = /Status Name\s*:\s*(\S+)/.exec(block)?.[1] ?? 'UNKNOWN';
    if (host) nodes.push({ host, port, status });
  }
  return { leader, nodes };
}

/**
 * Make a Pgpool-II node the watchdog leader: restart the current leader so the other nodes elect a new
 * one, until `targetId` wins (clients of the restarted node reconnect after a few seconds).
 */
export function makeWatchdogLeader(targetId: string): Deployment {
  const target = getNode(targetId);
  if (!target || target.type !== 'pgpool') throw fail('Choose a Pgpool-II node');
  const pools = listNodes().filter((n) => n.type === 'pgpool' && n.deployedAt);
  if (pools.length < 2) throw fail('The watchdog needs at least two deployed Pgpool-II nodes');
  if (!target.deployedAt) throw fail(`${target.name} is not deployed`);

  // Pgpool-II may still be starting (e.g. right after another operation resumed it)
  const readWatchdog = async () => {
    for (let i = 0; ; i++) {
      try {
        return await watchdogInfo();
      } catch (e) {
        if (i >= 15) throw e;
        await sleep(2000);
      }
    }
  };

  return startJob('watchdog leader', target.name, async (log) => {
    for (let attempt = 1; attempt <= pools.length; attempt++) {
      const info = await readWatchdog();
      const leaderNode = pools.find((p) => p.address === info.leader);
      log.line(`Watchdog leader: ${leaderNode?.name ?? info.leader ?? 'none'}`);
      if (leaderNode?.id === target.id) {
        emitEvent('success', `${target.name} is the Pgpool-II watchdog leader`, target.id);
        return;
      }
      if (!leaderNode) throw new Error('No watchdog leader found: is the watchdog enabled on every Pgpool-II node?');
      await onNode(leaderNode, async (s, rt) => {
        log.line(`${leaderNode.name}: restarting so that another node takes the lead`, 'cmd');
        await s.run(`${rt} restart -t 10 ${CONTAINER_NAME.pgpool}`, { sudo: true });
      });
      // election + rejoin of the restarted node
      for (let i = 0; i < 30; i++) {
        await sleep(2000);
        const now = await watchdogInfo().catch(() => null);
        if (now?.leader && now.leader !== leaderNode.address && now.nodes.every((n) => n.status === 'LEADER' || n.status === 'STANDBY')) break;
      }
    }
    const info = await readWatchdog();
    throw new Error(`${target.name} did not become the leader (leader: ${info.leader ?? 'none'})`);
  });
}
