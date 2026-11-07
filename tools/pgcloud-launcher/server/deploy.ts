import path from 'node:path';
import fs from 'node:fs';
import { CONTAINER_NAME, type ClusterNode, type Deployment } from '../shared/types.js';
import {
  appendDeploymentLog,
  createDeployment,
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
import { computeRoles, generateFiles, imageRef, validate, type Topology } from './topology.js';
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
  return validate(topology(), getSettings(), getNodeSsh, getClusterSecrets(), roles);
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

    await s.exec(`${rt} rm -f ${CONTAINER_NAME[node.type]} >/dev/null 2>&1`, { sudo: true });
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
      log.line(`${rt} rm -f ${name}`, 'cmd');
      await s.exec(`${rt} rm -f ${name}`, { sudo: true, onData: log.stream() });
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
  const paused: ClusterNode[] = [];
  for (const p of pools) {
    try {
      await withSsh(getNodeSsh(p.id), async (s) => {
        const rt = runtimeOf(p.id) ?? (await detectRuntime(s, getSettings().runtime)).bin;
        log.line(`Pausing ${p.name} during planned maintenance (avoids an unwanted failover)`, 'cmd');
        await s.exec(`${rt} stop -t 10 ${CONTAINER_NAME.pgpool}`, { sudo: true });
      });
      paused.push(p);
    } catch (e) {
      log.line(`Could not pause ${p.name}: ${(e as Error).message}`, 'warn');
    }
  }
  try {
    return await fn();
  } finally {
    for (const p of paused) {
      try {
        await withSsh(getNodeSsh(p.id), async (s) => {
          const rt = runtimeOf(p.id) ?? (await detectRuntime(s, getSettings().runtime)).bin;
          const state = (await s.exec(`${rt} inspect -f '{{.State.Status}}' ${CONTAINER_NAME.pgpool}`, { sudo: true })).stdout.trim();
          if (state !== 'running') {
            log.line(`Resuming ${p.name}`, 'cmd');
            await s.run(`${rt} start ${CONTAINER_NAME.pgpool}`, { sudo: true });
          }
        });
      } catch (e) {
        log.line(`Could not resume ${p.name}: ${(e as Error).message}`, 'error');
      }
    }
  }
}

export function runNodeAction(nodeId: string, action: NodeAction): Deployment {
  const node = getNode(nodeId);
  if (!node) throw Object.assign(new Error('Node not found'), { statusCode: 404 });
  if (action === 'deploy') {
    const v = validateTopology();
    const blocking = v.issues.filter((i) => i.level === 'error' && (!i.nodeId || i.nodeId === nodeId));
    if (blocking.length) throw Object.assign(new Error(blocking.map((i) => i.message).join('\n')), { statusCode: 400 });
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
