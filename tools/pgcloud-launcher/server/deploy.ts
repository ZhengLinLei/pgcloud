import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { CONTAINER_NAME, type AccessReport, type AccessSolution, type ClusterNode, type Deployment } from '../shared/types.js';
import {
  appendDeploymentLog,
  createDeployment,
  createEdge,
  createNode,
  deleteEdge,
  updateNode,
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
import { computeRoles, generateFiles, imageRef, isBackup, isServingBackup, STOPPED_MARKER, targetsOf, validate, type Topology } from './topology.js';
import { paths } from './env.js';
import { liveSnapshot, onSnapshot } from './monitor.js';
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
  const stale = new Set(stalePrimaries().map((n) => n.id));
  const roles = Object.fromEntries(
    Object.entries(live)
      .filter(([, l]) => l.status === 'up')
      .map(([id, l]) => [id, stale.has(id) ? 'stale-primary' : l.role]),
  );
  const v = validate(topology(), getSettings(), getNodeSsh, getClusterSecrets(), roles);
  const truth = truthPrimary();
  for (const n of stalePrimaries()) {
    v.ok = false;
    v.issues.push({
      level: 'error',
      nodeId: n.id,
      code: 'stale-primary',
      message: `${n.name} is running as a primary but ${truth?.name ?? 'another node'} is the current primary (old primary after a failover: two primaries). Select ${n.name} and press "Rejoin as replica" or "Rebuild".`,
    });
  }
  const risk = collapseRisk();
  if (risk.atRisk) {
    v.issues.push({ level: 'warning', code: 'collapse-risk', nodeId: risk.sourceId, message: `Cluster at risk: ${risk.reason}. Fast-swap copies the freshest data to a new server.` });
  }
  for (const n of notReplicating()) {
    v.issues.push({
      level: 'warning',
      nodeId: n.id,
      code: 'not-replicating',
      message: `${n.name} is a replica but does not stream from ${truth?.name ?? 'the primary'}. Select it and press "Rejoin as replica" or "Rebuild".`,
    });
  }
  // Pgpool-II keeps a backend detached even when it comes back (e.g. the primary started later than
  // Pgpool-II after a server restart): flag backends that are "down" in Pgpool-II but running
  // One warning per PostgreSQL node (with the watchdog every Pgpool-II node reports the same backend)
  const detached = detachedBackends();
  for (const node of [...new Map(detached.map((d) => [d.node.id, d.node])).values()]) {
    const ds = detached.filter((d) => d.node.id === node.id);
    const pools = ds.map((d) => d.pool.name).join(', ');
    v.issues.push({
      level: 'warning',
      nodeId: ds[0].pool.id,
      code: 'detached',
      message: `${node.name} is running${ds[0].isPrimary ? ' as the primary' : ''} but detached in Pgpool-II (${pools})${ds[0].isPrimary ? ', so writes fail' : ''}. Select ${ds[0].pool.name} and press Re-attach.`,
    });
  }
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
            ? `${n.name}: its configuration changed since it was deployed (settings, backends or watchdog members). Redeploy it: every Pgpool-II node is redeployed together.`
            : `${n.name}: its configuration changed since it was deployed (settings or topology). Redeploy it to apply the change.`,
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
    await restoreNodeFiles(s, node, dir, log);

    await s.exec(`${rt} rm -f -v ${CONTAINER_NAME[node.type]} >/dev/null 2>&1`, { sudo: true });
    if (node.type === 'postgres') await s.exec(`${rt} volume rm ${STOPPED_MARKER} >/dev/null 2>&1`, { sudo: true });
    const hasLocaltime = (await s.exec('test -f /etc/localtime')).code === 0;
    const cmd = runCommand(rt, node, dir, ref, hasLocaltime);
    log.line(cmd.replace(/--env-file \S+/, '--env-file …'), 'cmd');
    await s.run(cmd, { sudo: true, onData: log.stream() });
    await waitHealthy(s, rt, node, log);
  });
  setNodeDeployed(node.id, true);
  emitEvent('success', `${node.name} deployed`, node.id);
}

function nodeFiles(node: ClusterNode): Record<string, string> {
  const t = topology();
  return generateFiles(node, {
    topology: t,
    settings: getSettings(),
    secrets: getClusterSecrets(),
    sshOf: getNodeSsh,
    dbRuntime: dbRuntimeFor(t),
  }).files;
}

/**
 * Writes the node's generated configuration. When a bind-mounted file has vanished from the host (disk
 * wiped, directory deleted, server rebuilt), Docker recreates its path as an empty directory on the next
 * start; such directories are removed first so the files can be written again.
 */
async function restoreNodeFiles(s: SshSession, node: ClusterNode, dir: string, log: Logger): Promise<void> {
  const files = nodeFiles(node);
  const paths = Object.keys(files).map((rel) => path.posix.join(dir, rel));
  await s.run(`for f in ${paths.map(q).join(' ')}; do if [ -d "$f" ]; then rm -rf -- "$f"; fi; done; true`, { sudo: true });
  const dirs = new Set(paths.map((p) => path.posix.dirname(p)));
  await s.run(`mkdir -p ${[...dirs].map(q).join(' ')} && chmod 700 ${q(dir)}`);
  for (const [rel, content] of Object.entries(files)) {
    await s.writeFile(path.posix.join(dir, rel), content, 0o600);
    log.line(`Wrote ${path.posix.join(dir, rel)}`);
  }
  kv.set(`cfg:${node.id}`, hashFiles(files));
}

/** Paths of the node's configuration that are missing on the host or are not regular files. */
async function missingNodeFiles(s: SshSession, node: ClusterNode, dir: string): Promise<string[]> {
  const paths = Object.keys(nodeFiles(node)).map((rel) => path.posix.join(dir, rel));
  const r = await s.exec(`for f in ${paths.map(q).join(' ')}; do [ -f "$f" ] || echo "$f"; done`, { sudo: true });
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

async function containerAction(node: ClusterNode, action: Exclude<NodeAction, 'deploy'>, log: Logger): Promise<void> {
  const settings = getSettings();
  log.line(`━━ ${action} ${node.name} (${node.address})`);
  await withSsh(getNodeSsh(node.id), async (s) => {
    const rt = runtimeOf(node.id) ?? (await detectRuntime(s, settings.runtime)).bin;
    const name = CONTAINER_NAME[node.type];
    if (action === 'start' || action === 'restart') {
      // the container bind-mounts its configuration: if it vanished from the host, Docker cannot start it
      const dir = await nodeDir(s, node);
      const missing = await missingNodeFiles(s, node, dir);
      if (missing.length) {
        log.line(`Configuration missing on the host (${missing.join(', ')}): writing it again`, 'warn');
        emitEvent('warn', `${node.name}: configuration files were missing on ${node.address}; restored before ${action}`, node.id);
        await restoreNodeFiles(s, node, dir, log);
      }
    }
    if (node.type === 'postgres') {
      // stopped on purpose: Pgpool-II's failover recovery must not start it again
      if (action === 'stop') await s.exec(`${rt} volume create ${STOPPED_MARKER} >/dev/null`, { sudo: true });
      else await s.exec(`${rt} volume rm ${STOPPED_MARKER} >/dev/null 2>&1`, { sudo: true });
    }
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
        await stopPgpools(pools, log);
        for (const p of pools) await deployNode(p, log);
      });
    }
    // Pgpool-II only needs a pause for nodes it balances: not for a backup or a node deployed for the first time
    const pause = node.type === 'postgres' && !isBackup(node) && !!node.deployedAt;
    return startJob('deploy', node.name, (log) => (pause ? withPgpoolPaused(log, () => deployNode(node, log)) : deployNode(node, log)));
  }
  if (node.type === 'postgres' && action === 'restart' && !isBackup(node)) {
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
export async function onNode<T>(node: ClusterNode, fn: (s: SshSession, rt: string) => Promise<T>): Promise<T> {
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
  if (cfgOf(target).backup) throw fail(backupNotPrimary(target));
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

// ------------------------------------------------------------------ detached Pgpool-II backends

export interface DetachedBackend {
  pool: ClusterNode;
  node: ClusterNode;
  backendId: number;
  isPrimary: boolean;
}

/** Backends that a running Pgpool-II marks down while the PostgreSQL node itself is up. */
export function detachedBackends(): DetachedBackend[] {
  const live = liveSnapshot();
  const nodes = listNodes();
  const out: DetachedBackend[] = [];
  const seen = new Set<string>();
  for (const pool of nodes.filter((n) => n.type === 'pgpool' && live[n.id]?.status !== 'down')) {
    for (const row of live[pool.id]?.tables?.poolNodes ?? []) {
      if (row.status !== 'down') continue;
      const node = nodes.find(
        (n) => n.type === 'postgres' && (n.address === row.hostname || n.ssh.host === row.hostname) && String(pgPort(n)) === String(row.port),
      );
      if (!node || live[node.id]?.status !== 'up') continue;
      const key = `${pool.id}:${node.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ pool, node, backendId: Number(row.node_id), isPrimary: live[node.id]?.role === 'primary' });
    }
  }
  return out;
}

/**
 * Re-attach the running PostgreSQL backends that Pgpool-II keeps detached (pcp_attach_node). With the
 * watchdog the change reaches every Pgpool-II node; each one is checked anyway.
 */
export function reattachBackends(poolId: string): Deployment {
  const pool = getNode(poolId);
  if (!pool || pool.type !== 'pgpool') throw fail('Choose a Pgpool-II node');
  const todo = detachedBackends().filter((d) => d.pool.id === poolId);
  if (!todo.length) throw fail(`${pool.name} has no running backend to re-attach`);
  return startJob('re-attach', `${pool.name}: ${todo.map((d) => d.node.name).join(', ')}`, async (log) => {
    for (const d of todo) {
      await onNode(pool, async (s, rt) => {
        log.line(`${pool.name}: pcp_attach_node ${d.backendId} (${d.node.name}${d.isPrimary ? ', primary' : ''})`, 'cmd');
        await s.run(`${rt} exec ${CONTAINER_NAME.pgpool} ./tools/attach.sh ${d.backendId}`, { sudo: true, onData: log.stream() });
        // With the watchdog, a standby Pgpool-II forwards the request to the leader; if the leader already
        // has the node up nothing is sent back and this node stays out of sync. A restart makes it copy
        // the backend states from the leader when it joins the watchdog again.
        await sleep(3000);
        const info = await s.exec(
          `${rt} exec ${CONTAINER_NAME.pgpool} sh -c 'pcp_node_info -h 127.0.0.1 -p $PCP_PORT -U $PCP_USER -w -v -n ${d.backendId}'`,
          { sudo: true },
        );
        if (/Status Name\s*:\s*(down|quarantine)/i.test(info.stdout)) {
          log.line(`${pool.name} still sees ${d.node.name} down (out of sync with the watchdog leader): restarting ${pool.name}`, 'warn');
          await s.run(`${rt} restart -t 10 ${CONTAINER_NAME.pgpool}`, { sudo: true });
          await waitHealthy(s, rt, pool, log, 120);
        }
      });
      emitEvent('success', `${pool.name}: ${d.node.name} attached again`, pool.id);
    }
  });
}

// ------------------------------------------------------------------ failover follow-up / old primaries

/**
 * The primary that serves the cluster: the one Pgpool-II uses (it decides where writes go), or the only
 * running primary when there is no Pgpool-II.
 */
export function truthPrimary(): ClusterNode | undefined {
  const live = liveSnapshot();
  const nodes = listNodes();
  const pgs = nodes.filter((n) => n.type === 'postgres');
  for (const pool of nodes.filter((n) => n.type === 'pgpool' && live[n.id]?.status === 'up')) {
    const row = (live[pool.id]?.tables?.poolNodes ?? []).find((r) => r.role === 'primary' && r.status === 'up');
    if (!row) continue;
    const node = pgs.find((n) => (n.address === row.hostname || n.ssh.host === row.hostname) && String(pgPort(n)) === String(row.port));
    if (node && live[node.id]?.status === 'up' && live[node.id]?.role === 'primary') return node;
  }
  const primaries = pgs.filter((n) => live[n.id]?.status === 'up' && live[n.id]?.role === 'primary');
  return primaries.length === 1 ? primaries[0] : undefined;
}

/** PostgreSQL nodes running as primary that are not the serving primary (old primaries: split brain). */
export function stalePrimaries(): ClusterNode[] {
  const truth = truthPrimary();
  if (!truth) return [];
  const live = liveSnapshot();
  return listNodes().filter((n) => n.type === 'postgres' && n.id !== truth.id && live[n.id]?.status === 'up' && live[n.id]?.role === 'primary');
}

/** Running replicas without a streaming WAL receiver while the serving primary is up. */
export function notReplicating(): ClusterNode[] {
  const truth = truthPrimary();
  if (!truth) return [];
  const live = liveSnapshot();
  return listNodes().filter((n) => {
    const l = live[n.id];
    if (n.type !== 'postgres' || l?.status !== 'up' || l.role !== 'replica') return false;
    const wr = l.tables?.walReceiver ?? [];
    return !wr.some((r) => r.status === 'streaming');
  });
}

let lastFollowed = '';
/**
 * After a failover the drawing must follow the live roles: when the serving primary is not the topology's
 * primary, redraw the replication links to it and rewrite the configuration files of the PostgreSQL nodes
 * that can be reached (an old primary that is down gets NODE_ROLE=replica for its next start).
 */
async function followFailover(): Promise<void> {
  if (running) return;
  const truth = truthPrimary();
  const t = topology();
  const drawn = t.nodes.find((n) => n.type === 'postgres' && computeRoles(t)[n.id] === 'primary');
  if (!truth || !drawn || truth.id === drawn.id || !truth.deployedAt) return;
  if (lastFollowed === `${drawn.id}>${truth.id}`) return;
  lastFollowed = `${drawn.id}>${truth.id}`;
  adoptPrimary(truth.id);
  broadcast({ type: 'topology' });
  emitEvent('warn', `Failover detected: ${truth.name} is the primary, ${drawn.name} is now drawn as its replica. Topology updated.`, truth.id);
  const quiet = { line: () => undefined } as unknown as Logger;
  for (const n of listNodes().filter((x) => x.type === 'postgres' && x.deployedAt)) {
    await writeNodeFiles(n, quiet).catch(() => undefined);
  }
}
onSnapshot(followFailover);

/**
 * Turn a PostgreSQL node into a replica of the serving primary: "rewind" (pg_rewind, falls back to a
 * fresh copy) or "clone" (fresh copy with pg_basebackup). For an old primary after a failover, or a
 * replica that stopped streaming. Pgpool-II is paused meanwhile and the node is attached again after.
 */
export function rejoinNode(nodeId: string, mode: 'rewind' | 'clone'): Deployment {
  const node = getNode(nodeId);
  if (!node || node.type !== 'postgres') throw fail('Choose a PostgreSQL node');
  const primary = truthPrimary();
  if (!primary) throw fail('There is no single running primary to rejoin');
  if (primary.id === node.id) throw fail(`${node.name} is the current primary`);
  if (!node.deployedAt) throw fail(`${node.name} is not deployed`);
  const what = mode === 'clone' ? 'rebuild' : 'rejoin';
  return startJob(what, `${node.name} → replica of ${primary.name}`, async (log) => {
    emitEvent('info', `${node.name}: ${what} as a replica of ${primary.name} started`, node.id);
    await withPgpoolPaused(log, async () => {
      await onNode(node, async (s, rt) => {
        log.line(`${node.name}: stopping`, 'cmd');
        await s.exec(`${rt} stop -t 60 ${CONTAINER_NAME.postgres}`, { sudo: true });
        const image = (await s.exec(`${rt} inspect -f '{{.Config.Image}}' ${CONTAINER_NAME.postgres}`, { sudo: true })).stdout.trim();
        if (!image) throw new Error(`${node.name}: container ${CONTAINER_NAME.postgres} not found; deploy the node instead`);
        log.line(`${node.name}: pgcloud_rewind ${primary.address} ${pgPort(primary)}${mode === 'clone' ? ' --clone (fresh copy)' : ''}`, 'cmd');
        await s.run(
          `${rt} run --rm --network host --volumes-from ${CONTAINER_NAME.postgres} --entrypoint pgcloud_rewind ${q(image)} ${primary.address} ${pgPort(primary)}${mode === 'clone' ? ' --clone' : ''}`,
          { sudo: true, onData: log.stream() },
        );
        await s.run(`${rt} start ${CONTAINER_NAME.postgres}`, { sudo: true });
        await waitHealthy(s, rt, node, log, 180);
      });
      for (let i = 0; i < 30; i++) {
        if ((await pgQuery(node, 'SELECT status FROM pg_stat_wal_receiver').catch(() => '')) === 'streaming') break;
        await sleep(1000);
      }
      if ((await pgQuery(node, 'SELECT status FROM pg_stat_wal_receiver').catch(() => '')) !== 'streaming')
        throw new Error(`${node.name} started but does not stream from ${primary.name}`);
      log.line(`${node.name} is streaming from ${primary.name}`, 'ok');
      adoptPrimary(primary.id);
      broadcast({ type: 'topology' });
      await writeNodeFiles(node, log);
    });
    // Pgpool-II may keep the node detached: attach it again (once is enough with the watchdog)
    await sleep(8000);
    for (const d of detachedBackends().filter((x) => x.node.id === node.id).slice(0, 1)) {
      await onNode(d.pool, async (s, rt) => {
        log.line(`${d.pool.name}: pcp_attach_node ${d.backendId} (${node.name})`, 'cmd');
        await s.run(`${rt} exec ${CONTAINER_NAME.pgpool} ./tools/attach.sh ${d.backendId}`, { sudo: true, onData: log.stream() });
      });
    }
    emitEvent('success', `${node.name} is a replica of ${primary.name}`, node.id);
  });
}

// ------------------------------------------------------------------ full rebuild / auto-heal

/**
 * Destroy everything and deploy again from the drawing: every container, PostgreSQL data volume and
 * configuration directory of every node is deleted, then the cluster is deployed from scratch. For a
 * cluster that cannot be repaired (or a clean restart of a test environment). ALL DATA IS LOST.
 */
export function rebuildCluster(): Deployment {
  const v = validateTopology();
  // Live-state problems are exactly what a rebuild fixes: only the drawing itself must be valid
  const blocking = v.issues.filter((i) => i.level === 'error' && !['roles', 'stale-primary'].includes(i.code ?? ''));
  if (blocking.length) throw fail(blocking.map((i) => i.message).join('\n'));
  const nodes = listNodes();
  const order: Array<ClusterNode['type']> = ['pgbouncer', 'pgpool', 'postgres'];
  return startJob('rebuild', 'cluster', async (log) => {
    emitEvent('warn', 'Cluster rebuild started: destroying every node and its data');
    for (const type of order) {
      for (const n of nodes.filter((x) => x.type === type)) {
        try {
          await containerAction(n, 'destroy', log);
        } catch (e) {
          log.line(`${n.name}: could not destroy (${(e as Error).message}); it will be overwritten by the deploy`, 'warn');
        }
        kv.set(`cfg:${n.id}`, '');
      }
    }
    lastFollowed = '';
    const plan = validateTopology().plan;
    log.line(`Deploying ${plan.length} nodes from scratch: ${plan.map((p) => `${p.name}(${p.role})`).join(' → ')}`);
    for (const step of plan) {
      const node = getNode(step.nodeId);
      if (node) await deployNode(node, log);
    }
    await syncReplication(log).catch((e) => log.line(`Could not set synchronous replication: ${(e as Error).message}`, 'warn'));
    emitEvent('success', 'Cluster rebuilt from scratch');
  });
}

const healedAt = new Map<string, number>();
const HEAL_COOLDOWN_MS = 120_000;
const canHeal = (key: string) => Date.now() - (healedAt.get(key) ?? 0) > HEAL_COOLDOWN_MS;

/**
 * Auto-heal after an outage (Settings → Auto-heal), one safe action per monitoring round:
 *  - an old primary running next to the serving primary is rejoined as a replica (only with
 *    "Old primary that comes back: rejoin automatically");
 *  - a running node that Pgpool-II keeps detached is attached again when it is safe: the primary when
 *    Pgpool-II has no attached primary, or a replica that streams.
 */
async function autoHeal(): Promise<void> {
  const settings = getSettings();
  if (running || settings.autoHeal === false) return;
  const live = liveSnapshot();

  if (settings.oldPrimary !== 'wait') {
    const stale = stalePrimaries().find((n) => canHeal(`rejoin:${n.id}`));
    if (stale) {
      healedAt.set(`rejoin:${stale.id}`, Date.now());
      emitEvent('warn', `Auto-heal: ${stale.name} is an old primary running next to the current one; rejoining it as a replica`, stale.id);
      rejoinNode(stale.id, 'rewind');
      return;
    }
  }

  for (const d of detachedBackends()) {
    if (!canHeal(`attach:${d.node.id}`)) continue;
    const rows = live[d.pool.id]?.tables?.poolNodes ?? [];
    const poolHasPrimary = rows.some((r) => r.role === 'primary' && r.status === 'up');
    const streaming = (live[d.node.id]?.tables?.walReceiver ?? []).some((r) => r.status === 'streaming');
    const safe = d.isPrimary ? !poolHasPrimary && stalePrimaries().length === 0 : streaming;
    if (!safe) continue;
    healedAt.set(`attach:${d.node.id}`, Date.now());
    emitEvent('warn', `Auto-heal: ${d.node.name} is running but detached in Pgpool-II; attaching it again`, d.pool.id);
    try {
      reattachBackends(d.pool.id);
    } catch {
      /* nothing to do any more */
    }
    return;
  }
}
onSnapshot(autoHeal);

// ------------------------------------------------------------------ backup nodes

const downSince = new Map<string, number>();
/** Nodes that missed a redeploy because their server was down (backup activation): redeployed when back. */
const pendingRedeploy = {
  all: (): string[] => kv.get<string[]>('pendingRedeploy') ?? [],
  add(id: string) {
    kv.set('pendingRedeploy', [...new Set([...this.all(), id])]);
  },
  delete(id: string) {
    kv.set('pendingRedeploy', this.all().filter((x) => x !== id));
  },
};
const cfgOf = (n: ClusterNode) => n.config as Record<string, unknown>;
const streams = (n: ClusterNode) => (liveSnapshot()[n.id]?.tables?.walReceiver ?? []).some((r) => r.status === 'streaming');

/**
 * Backup nodes act on their own when PostgreSQL nodes stay down longer than their grace time
 * (one action per monitoring round, highest backupPriority first):
 *  - backupReplace: a node other than the serving primary is down → the backup becomes a normal
 *    replica, takes over its Pgpool-II / PgBouncer links, and the failed node becomes a backup;
 *  - backupLastResort: every normal PostgreSQL node is down → the backup is promoted to primary.
 */
async function backupWatch(): Promise<void> {
  const live = liveSnapshot();
  const pgs = listNodes().filter((n) => n.type === 'postgres' && n.deployedAt);
  for (const n of pgs) {
    if (live[n.id]?.status === 'down') {
      if (!downSince.has(n.id)) downSince.set(n.id, Date.now());
    } else downSince.delete(n.id);
  }
  if (running) return;
  for (const id of pendingRedeploy.all()) {
    const n = getNode(id);
    if (!n) {
      pendingRedeploy.delete(id);
      continue;
    }
    // the node itself may be stopped: what matters is that its server answers over SSH again
    if (live[id]?.status !== 'up' && live[id]?.status !== 'degraded') {
      if (!canHeal(`ssh:${id}`)) continue;
      healedAt.set(`ssh:${id}`, Date.now() - HEAL_COOLDOWN_MS + 30_000); // check every 30 s
      const ok = await onNode(n, (sh) => sh.exec('true').then((x) => x.code === 0)).catch(() => false);
      if (!ok) continue;
    }
    pendingRedeploy.delete(id);
    emitEvent('info', `${n.name} is reachable again: redeploying it with the current topology`, n.id);
    if (n.type === 'pgpool') {
      // Pgpool-II nodes must restart together with the same backend list
      const pools = listNodes().filter((x) => x.type === 'pgpool' && x.deployedAt);
      for (const p of pools) pendingRedeploy.delete(p.id);
      startJob('deploy', pools.map((p) => p.name).join(', '), async (log) => {
        await stopPgpools(pools, log);
        for (const p of pools) {
          await deployNode(p, log).catch((e) => {
            log.line(`${p.name}: ${(e as Error).message} (retried when its server answers)`, 'warn');
            pendingRedeploy.add(p.id);
          });
        }
      });
    } else startJob('deploy', n.name, (log) => deployNode(n, log));
    return;
  }
  const downFor = (n: ClusterNode) => (downSince.has(n.id) ? (Date.now() - downSince.get(n.id)!) / 1000 : 0);
  const grace = (b: ClusterNode) => Number(cfgOf(b).backupGraceSec ?? 60);

  // ---- a backup found running as the primary (promoted by Pgpool-II, or by hand before this was
  // forbidden) is a backup in service: it hands the role to a system node once one is ready
  const loosePrimary = pgs.find((n) => isBackup(n) && live[n.id]?.status === 'up' && live[n.id]?.role === 'primary');
  if (loosePrimary) {
    updateNode(loosePrimary.id, { config: { backupServing: 'primary' } });
    emitEvent('warn', `Backup ${loosePrimary.name} runs as the primary: it is a backup in service until a system node can take the role back`, loosePrimary.id);
    broadcast({ type: 'topology' });
    return;
  }

  // ---- backups standing in for a failed node
  for (const b of pgs.filter(isServingBackup)) {
    const c = cfgOf(b);
    const role = live[b.id]?.role;
    // keep the recorded role in line with what it runs as (Pgpool-II may have promoted it)
    if ((role === 'primary' || role === 'replica') && role !== c.backupServing) {
      updateNode(b.id, { config: { backupServing: role } });
      broadcast({ type: 'topology' });
      return;
    }
    // the user switched "return to backup" off while it was serving: it stays a system node
    if (c.backupReturn === false) {
      makeSystemNode(b);
      return;
    }
    const replaced = c.backupFor ? getNode(String(c.backupFor)) : undefined;
    if (role === 'primary') {
      // hand the primary role to a recovered system node first (planned switchover, nothing is lost);
      // as a replica afterwards, it returns to backup in a later round
      const candidates = [replaced, ...pgs.filter((n) => !cfgOf(n).backup)].filter(
        (n): n is ClusterNode => !!n && !cfgOf(n).backup && live[n.id]?.role === 'replica' && healthyFor(n) >= grace(b),
      );
      if (candidates[0] && canHeal(`standdown:${b.id}`)) {
        healedAt.set(`standdown:${b.id}`, Date.now());
        try {
          switchover(candidates[0].id);
          emitEvent('info', `Cluster recovered: backup ${b.name} hands the primary role to ${candidates[0].name}`, b.id);
        } catch (e) {
          log0(`stand-down of ${b.name} postponed: ${(e as Error).message}`);
        }
        return;
      }
      continue;
    }
    if (role !== 'replica') continue;
    // back when the node it replaced runs again and stays healthy for the grace time; if that node was
    // deleted, when every system replica is healthy
    const sysReplicas = pgs.filter((n) => !cfgOf(n).backup && live[n.id]?.role === 'replica');
    const recovered = replaced
      ? healthyFor(replaced) >= grace(b)
      : sysReplicas.length > 0 && sysReplicas.every((n) => healthyFor(n) >= grace(b));
    if (recovered && canHeal(`standdown:${b.id}`)) {
      healedAt.set(`standdown:${b.id}`, Date.now());
      standDownBackup(b, replaced);
      return;
    }
  }

  const actives = pgs.filter((n) => !isBackup(n));
  // nodes a backup already stands in for are not replaced twice
  const covered = new Set(pgs.filter(isServingBackup).map((n) => String(cfgOf(n).backupFor)));
  const backups = pgs
    .filter((n) => isBackup(n) && live[n.id]?.status === 'up')
    .sort((a, b) => Number(cfgOf(b).backupPriority ?? 0) - Number(cfgOf(a).backupPriority ?? 0));
  if (!actives.length || !backups.length) return;

  // every normal node down → last resort
  if (actives.every((a) => live[a.id]?.status === 'down')) {
    const minDown = Math.min(...actives.map(downFor));
    const b = backups.find((x) => cfgOf(x).backupLastResort && minDown >= grace(x) && canHeal(`backup:${x.id}`));
    if (b) {
      healedAt.set(`backup:${b.id}`, Date.now());
      const t = topology();
      const failed = actives.find((a) => computeRoles(t)[a.id] === 'primary') ?? actives[0];
      activateBackup(b, 'primary', failed);
    }
    return;
  }

  // a node is down while a primary serves → replace it
  const truth = truthPrimary();
  if (!truth) return;
  for (const failed of actives.filter((a) => a.id !== truth.id && !covered.has(a.id) && live[a.id]?.status === 'down')) {
    const b = backups.find((x) => cfgOf(x).backupReplace && downFor(failed) >= grace(x) && streams(x) && canHeal(`backup:${x.id}`));
    if (!b) continue;
    healedAt.set(`backup:${b.id}`, Date.now());
    activateBackup(b, 'replica', failed);
    return;
  }
}
onSnapshot(backupWatch);

/** Seconds a PostgreSQL node has been running in good health (primary, or replica streaming). */
const healthySince = new Map<string, number>();
function trackHealth(): void {
  const live = liveSnapshot();
  for (const n of listNodes().filter((x) => x.type === 'postgres')) {
    const l = live[n.id];
    const ok = l?.status === 'up' && (l.role === 'primary' || (l.role === 'replica' && streams(n)));
    if (!ok) healthySince.delete(n.id);
    else if (!healthySince.has(n.id)) healthySince.set(n.id, Date.now());
  }
}
onSnapshot(trackHealth);
const healthyFor = (n: ClusterNode) => (healthySince.has(n.id) ? (Date.now() - healthySince.get(n.id)!) / 1000 : 0);
const log0 = (m: string) => console.log(`[backup] ${m}`);

/** Move the Pgpool-II / PgBouncer links of `from` to `to` (or drop them when `to` is gone). */
function moveClientLinks(from: ClusterNode, to: ClusterNode | undefined, log: Logger): void {
  const t0 = topology();
  for (const e of t0.edges.filter((x) => x.target === from.id)) {
    const src = t0.nodes.find((n) => n.id === e.source);
    if (!src || src.type === 'postgres') continue;
    deleteEdge(e.id);
    if (to && !t0.edges.some((x) => x.source === src.id && x.target === to.id)) createEdge(src.id, to.id);
    log.line(to ? `${src.name} now connects to ${to.name} instead of ${from.name}` : `${src.name} no longer connects to ${from.name}`);
  }
}

/**
 * After the PostgreSQL nodes behind the entry points changed: rewrite the PostgreSQL configuration, then
 * redeploy every Pgpool-II node (all together) and the PgBouncer nodes that point to one of `ids`.
 */
async function redeployClients(ids: Set<string>, log: Logger): Promise<void> {
  for (const n of listNodes().filter((x) => x.type === 'postgres' && x.deployedAt)) await writeNodeFiles(n, log).catch(() => undefined);
  const t = topology();
  // All Pgpool-II nodes stop first: a node started with the new backend list must not copy the backend
  // states of a watchdog leader that still has the old list (states are matched by node number)
  // (which nodes are down is decided before stopping them, or they would all look down)
  const wasDown = new Set(t.nodes.filter((x) => liveSnapshot()[x.id]?.status === 'down').map((x) => x.id));
  await stopPgpools(t.nodes.filter((x) => x.type === 'pgpool' && x.deployedAt && !wasDown.has(x.id)), log);
  for (const n of t.nodes.filter((x) => x.deployedAt && (x.type === 'pgpool' || (x.type === 'pgbouncer' && targetsOf(t, x.id).some((d) => ids.has(d.id)))))) {
    // a server that is down (part of the outage) is skipped; redeploy it when it is back
    if (wasDown.has(n.id)) {
      log.line(`${n.name} is down: it will be redeployed as soon as its server is back`, 'warn');
      pendingRedeploy.add(n.id);
      continue;
    }
    await deployNode(n, log).catch((e) => {
      log.line(`${n.name}: ${(e as Error).message} (retried when it is reachable)`, 'warn');
      pendingRedeploy.add(n.id);
    });
  }
}

/**
 * A backup takes over from `failed` (as a replica, or as the new primary when nothing else runs) and
 * receives its Pgpool-II / PgBouncer links. With backupReturn (default) it stays a backup "in service"
 * and hands the work back once the cluster has recovered; without it, it becomes a system node for good.
 */
export function activateBackup(b: ClusterNode, mode: 'replica' | 'primary', failed: ClusterNode): Deployment {
  return startJob('backup', `${b.name} replaces ${failed.name}${mode === 'primary' ? ' as primary' : ''}`, async (log) => {
    emitEvent('warn', `Backup ${b.name} activated: ${failed.name} is down${mode === 'primary' ? ' and no other PostgreSQL node is up: promoting it' : ''}`, b.id);
    const bc = cfgOf(b);
    const permanent = bc.backupReturn === false;
    if (permanent) {
      makeSystemNode(b, failed);
    } else {
      updateNode(b.id, { config: { backupServing: mode, backupFor: failed.id } });
      log.line(`${b.name} serves as ${mode} until ${failed.name} is back; then it returns to backup`);
    }
    moveClientLinks(failed, getNode(b.id), log);
    if (mode === 'primary') {
      await onNode(b, async (s, rt) => {
        log.line(`${b.name}: pgcloud_promote`, 'cmd');
        await s.run(`${rt} exec ${CONTAINER_NAME.postgres} pgcloud_promote`, { sudo: true, onData: log.stream() });
      });
      for (let i = 0; i < 30 && (await pgQuery(b, 'SELECT pg_is_in_recovery()').catch(() => 't')) !== 'f'; i++) await sleep(1000);
      if ((await pgQuery(b, 'SELECT pg_is_in_recovery()')) !== 'f') throw new Error(`${b.name} did not leave recovery`);
      adoptPrimary(b.id);
      log.line(`${b.name} is the primary`, 'ok');
    }
    broadcast({ type: 'topology' });
    await redeployClients(new Set([b.id]), log);
    emitEvent(
      'success',
      `Backup ${b.name} replaced ${failed.name}${mode === 'primary' ? ' as the primary' : ' as a replica'}${
        permanent ? `; ${failed.name} is the backup now` : `; it returns to backup when ${failed.name} is back`
      }`,
      b.id,
    );
  });
}

/**
 * The backup becomes a normal (system) node for good: it keeps its role and links, a notice says so, and
 * the node it replaced (if any) becomes the backup, so the number of nodes of each kind stays the same.
 */
function makeSystemNode(b: ClusterNode, replaced?: ClusterNode): void {
  const bc = cfgOf(b);
  const was = replaced ?? (bc.backupFor ? getNode(String(bc.backupFor)) : undefined);
  updateNode(b.id, {
    config: { backup: false, fastSwap: false, backupServing: undefined, backupFor: undefined, promotedFromBackup: new Date().toISOString() },
  });
  if (was && !cfgOf(was).backup) {
    updateNode(was.id, {
      config: {
        backup: true,
        backupReplace: bc.backupReplace ?? true,
        backupLastResort: bc.backupLastResort ?? true,
        backupReturn: true,
        // a fast-swap node's emergency priority is not passed on
        backupPriority: bc.fastSwap ? 10 : (bc.backupPriority ?? 10),
        backupGraceSec: bc.fastSwap ? 60 : (bc.backupGraceSec ?? 60),
      },
    });
  }
  emitEvent(
    'warn',
    `${b.name}, previously a backup node, was promoted to a system node${was ? ` (in place of ${was.name}, which is the backup now)` : ''}`,
    b.id,
  );
  broadcast({ type: 'topology' });
}

/** The cluster has recovered: the serving backup gives its links back to `replaced` and is an idle backup again. */
function standDownBackup(b: ClusterNode, replaced: ClusterNode | undefined): Deployment {
  return startJob('backup', `${b.name} returns to backup`, async (log) => {
    emitEvent('info', `${replaced ? `${replaced.name} is back` : 'The replicas are back'}: backup ${b.name} hands the work back`, b.id);
    moveClientLinks(b, replaced, log);
    updateNode(b.id, { config: { backupServing: undefined, backupFor: undefined } });
    broadcast({ type: 'topology' });
    await redeployClients(new Set([b.id, ...(replaced ? [replaced.id] : [])]), log);
    emitEvent('success', `${b.name} is a backup again (no traffic)${replaced ? `; ${replaced.name} serves again` : ''}`, b.id);
  });
}

// ------------------------------------------------------------------ fast-swap

/** Cluster about to lose its data: at most one PostgreSQL node with data is up, or the primary has no copy left. */
export function collapseRisk(): { atRisk: boolean; reason: string; sourceId?: string } {
  const live = liveSnapshot();
  const pgs = listNodes().filter((n) => n.type === 'postgres' && n.deployedAt);
  if (pgs.length < 2) return { atRisk: false, reason: '' };
  const up = pgs.filter((n) => live[n.id]?.status === 'up');
  if (up.length === 0) return { atRisk: false, reason: '' }; // nothing to copy from
  if (up.length === 1)
    return { atRisk: true, reason: `only ${up[0].name} of ${pgs.length} PostgreSQL nodes is running and holds the data`, sourceId: up[0].id };
  const truth = truthPrimary();
  if (truth && !up.some((n) => n.id !== truth.id && streams(n)))
    return { atRisk: true, reason: `${truth.name} (primary) has no replica or backup streaming from it`, sourceId: truth.id };
  return { atRisk: false, reason: '' };
}

const lsnValue = (lsn: string) => {
  const [hi, lo] = lsn.split('/');
  return (BigInt(`0x${hi || '0'}`) << 32n) + BigInt(`0x${lo || '0'}`);
};

/** The running PostgreSQL node with the freshest data: the serving primary, else the highest timeline / WAL position. */
export async function freshestNode(): Promise<{ node: ClusterNode; role: string; timeline: number; lsn: string } | null> {
  const live = liveSnapshot();
  const up = listNodes().filter((n) => n.type === 'postgres' && n.deployedAt && live[n.id]?.status === 'up');
  const truth = truthPrimary();
  const rows: Array<{ node: ClusterNode; role: string; timeline: number; lsn: string }> = [];
  for (const n of up) {
    try {
      const out = await pgQuery(
        n,
        "SELECT pg_is_in_recovery()::text || ' ' || (SELECT timeline_id FROM pg_control_checkpoint()) || ' ' || CASE WHEN pg_is_in_recovery() THEN coalesce(pg_last_wal_replay_lsn(), '0/0') ELSE pg_current_wal_lsn() END",
      );
      const [rec, tl, lsn] = out.split(' ');
      rows.push({ node: n, role: rec === 'true' ? 'replica' : 'primary', timeline: Number(tl), lsn });
    } catch {
      /* not reachable over SQL */
    }
  }
  if (!rows.length) return null;
  const t = truth && rows.find((r) => r.node.id === truth.id);
  if (t) return t;
  rows.sort((a, b) => b.timeline - a.timeline || (lsnValue(b.lsn) > lsnValue(a.lsn) ? 1 : lsnValue(b.lsn) < lsnValue(a.lsn) ? -1 : 0));
  return rows[0];
}

/**
 * Fast-swap: a new server receives a copy of the freshest data with pg_basebackup over the replication
 * protocol (consistent while the source keeps running, and it keeps streaming afterwards, so nothing
 * written during the copy is lost). The node is created as a top-priority backup, so the backup logic
 * uses it right away to replace a failed node or to become the primary.
 */
export async function fastSwap(input: { name?: string; address?: string; ssh: Parameters<typeof createNode>[0]['ssh'] }): Promise<Deployment> {
  if (running) throw fail(`Another operation is running (${running.action} ${running.target})`, 409);
  if (!input.ssh?.host) throw fail('Enter the SSH access of the new server');
  const src = await freshestNode();
  if (!src) throw fail('No running PostgreSQL node to copy the data from');
  const names = new Set(listNodes().map((n) => n.name));
  let name = (input.name ?? '').trim();
  if (!name) for (let i = 1; !name || names.has(name); i++) name = `fastswap${i}`;
  if (names.has(name)) throw fail(`A node named ${name} already exists`);
  const node = createNode({
    type: 'postgres',
    name,
    address: input.address,
    x: src.node.x + 60,
    y: src.node.y + 140,
    ssh: input.ssh,
    config: { ...cfgOf(src.node), backup: true, fastSwap: true, backupReplace: true, backupLastResort: true, backupPriority: 1000, backupGraceSec: 30 },
  });
  createEdge(node.id, src.node.id);
  broadcast({ type: 'topology' });
  return startJob('fast-swap', `${node.name} ← ${src.node.name}`, async (log) => {
    emitEvent('warn', `Fast-swap: copying the freshest data (${src.node.name}, ${src.role}, timeline ${src.timeline}, WAL ${src.lsn}) to ${node.name}`, node.id);
    log.line(`Source: ${src.node.name} (${src.role}, timeline ${src.timeline}, WAL ${src.lsn}). Method: pg_basebackup over streaming replication`);
    await deployNode(getNode(node.id)!, log);
    for (let i = 0; i < 30 && !(await pgQuery(node, 'SELECT status FROM pg_stat_wal_receiver').catch(() => '')).includes('streaming'); i++) await sleep(1000);
    log.line(`${node.name} holds a copy of ${src.node.name} and keeps streaming from it`, 'ok');
    emitEvent('success', `Fast-swap: ${node.name} is ready (top-priority backup of ${src.node.name})`, node.id);
  });
}

/** Stop Pgpool-II containers in parallel (before redeploying them with a different backend list). */
async function stopPgpools(pools: ClusterNode[], log: Logger): Promise<void> {
  await Promise.all(
    pools.map((p) =>
      onNode(p, async (s, rt) => {
        log.line(`${p.name}: stopping (every Pgpool-II restarts with the same backend list)`, 'cmd');
        await s.exec(`${rt} stop -t 10 ${CONTAINER_NAME.pgpool}`, { sudo: true });
      }).catch(() => undefined),
    ),
  );
}

// ------------------------------------------------------------------ access to the cluster

/** Where applications connect: the PgBouncer nodes, else the Pgpool-II nodes, else the primary. */
export function entryPoints(): ClusterNode[] {
  const nodes = listNodes().filter((n) => n.deployedAt);
  const bouncers = nodes.filter((n) => n.type === 'pgbouncer');
  if (bouncers.length) return bouncers;
  const pools = nodes.filter((n) => n.type === 'pgpool');
  if (pools.length) return pools;
  const t = topology();
  return nodes.filter((n) => n.type === 'postgres' && computeRoles(t)[n.id] === 'primary');
}

/**
 * Why no entry point accepts connections, layer by layer (PostgreSQL → Pgpool-II → PgBouncer), and what
 * can be done: actions the launcher can apply (re-attach, rejoin, start, redeploy, promote), what it is
 * already doing by itself (backups, auto-heal) and the last resorts (fast-swap, rebuild).
 */
export async function diagnoseAccess(): Promise<AccessReport> {
  const live = liveSnapshot();
  const settings = getSettings();
  const entries = entryPoints().map((n) => ({ id: n.id, name: n.name, type: n.type, status: live[n.id]?.status ?? 'unknown', error: live[n.id]?.error }));
  const accessible = entries.some((e) => e.status === 'up');
  const causes: string[] = [];
  const solutions: AccessSolution[] = [];
  const add = (x: AccessSolution) => !solutions.some((y) => y.key === x.key) && solutions.push(x);
  const nodes = listNodes().filter((n) => n.deployedAt);
  const pgs = nodes.filter((n) => n.type === 'postgres');
  const pools = nodes.filter((n) => n.type === 'pgpool');
  const bouncers = nodes.filter((n) => n.type === 'pgbouncer');
  const st = (n: ClusterNode) => live[n.id]?.status ?? 'unknown';

  if (running) {
    causes.push(`An operation is running (${running.action} ${running.target}); the entry points may come back when it finishes.`);
  }

  // ---- PostgreSQL
  const truth = truthPrimary();
  const upPgs = pgs.filter((n) => st(n) === 'up');
  if (!pgs.length) {
    causes.push('No PostgreSQL node of the topology is deployed (nodes were added or replaced and not deployed yet).');
    add({ key: 'deploy', title: 'Deploy the cluster', detail: 'Deploy the topology as drawn (Deploy tab → Deploy cluster).', kind: 'action', action: { path: '/api/deploy', confirm: 'Deploy the cluster as drawn?' } });
  } else if (!truth) {
    if (!upPgs.length) {
      causes.push(`No PostgreSQL node is running (${pgs.map((n) => n.name).join(', ')}).`);
      for (const n of pgs) {
        add({ key: `start:${n.id}`, title: `Start ${n.name}`, detail: `Start the container of ${n.name} on ${n.address}. If its server is down, power it on first.`, kind: 'action', action: { path: `/api/nodes/${n.id}/actions/start` } });
      }
      add({ key: 'restore', title: 'Restore from a backup', detail: 'If the data of every node is lost, only an external backup (pgBackRest, pg_basebackup copies…) brings it back.', kind: 'info' });
    } else {
      const fresh = await freshestNode();
      const backup = upPgs.find((n) => isBackup(n) && cfgOf(n).backupLastResort);
      causes.push(`No PostgreSQL primary is running: ${upPgs.map((n) => n.name).join(', ')} ${upPgs.length > 1 ? 'are' : 'is'} up as replica.`);
      if (backup) {
        add({ key: 'backup-auto', title: `Backup ${backup.name} takes over`, detail: `${backup.name} is promoted by itself ${Number(cfgOf(backup).backupGraceSec ?? 60)} s after every other node went down ("last resort").`, kind: 'auto' });
      }
      if (fresh && fresh.role !== 'primary' && cfgOf(fresh.node).backup) {
        add({
          key: `backup-fresh:${fresh.node.id}`,
          title: `${fresh.node.name} has the newest data but is a backup`,
          detail: `A backup cannot be made primary by hand. ${cfgOf(fresh.node).backupLastResort ? 'It takes over by itself (last resort) once every other node has been down for its grace time.' : 'Turn on "Last resort" in its configuration, or uncheck "Backup node" to make it a system node, then promote it.'}`,
          kind: 'info',
        });
      } else if (fresh && fresh.role !== 'primary') {
        add({
          key: `promote:${fresh.node.id}`,
          title: `Promote ${fresh.node.name} (freshest data)`,
          detail: `${fresh.node.name} has the newest data (timeline ${fresh.timeline}, WAL ${fresh.lsn}). It becomes the primary, the other nodes follow it and Pgpool-II is redeployed.`,
          kind: 'action',
          action: { path: `/api/nodes/${fresh.node.id}/promote`, confirm: `Promote ${fresh.node.name} to primary?` },
        });
      }
    }
  }
  for (const n of stalePrimaries()) {
    causes.push(`${n.name} runs as a second primary.`);
    add({ key: `rejoin:${n.id}`, title: `Rejoin ${n.name} as replica`, detail: `pg_rewind against ${truth?.name}; writes made on ${n.name} after the failover are discarded.`, kind: 'action', action: { path: `/api/nodes/${n.id}/rejoin`, body: { mode: 'rewind' } } });
  }

  // ---- Pgpool-II
  if (pools.length) {
    const downPools = pools.filter((p) => st(p) === 'down');
    const degraded = pools.filter((p) => st(p) === 'degraded');
    if (downPools.length) causes.push(`Pgpool-II not reachable: ${downPools.map((p) => `${p.name} (${live[p.id]?.error ?? 'down'})`).join(', ')}.`);
    if (degraded.length) causes.push(`Pgpool-II answers but refuses connections: ${degraded.map((p) => `${p.name} (${live[p.id]?.error ?? 'degraded'})`).join(', ')}.`);
    const detached = detachedBackends();
    if (detached.length) {
      const d = detached[0];
      causes.push(`Pgpool-II keeps running nodes detached: ${[...new Set(detached.map((x) => x.node.name))].join(', ')}.`);
      add({ key: `reattach:${d.pool.id}`, title: `Re-attach ${d.node.name} in Pgpool-II`, detail: `pcp_attach_node${settings.autoHeal !== false ? ' (auto-heal does it by itself within a few seconds)' : ''}.`, kind: 'action', action: { path: `/api/nodes/${d.pool.id}/reattach` } });
    }
    if (downPools.length || degraded.length) {
      add({
        key: 'redeploy-pgpool',
        title: 'Redeploy every Pgpool-II node',
        detail: 'Writes the current backend list and restarts all Pgpool-II nodes together (they must agree on the backends and the primary).',
        kind: 'action',
        action: { path: `/api/nodes/${pools[0].id}/actions/deploy` },
      });
    }
  }

  // ---- PgBouncer
  for (const b of bouncers.filter((x) => st(x) !== 'up')) {
    causes.push(`PgBouncer ${b.name} is ${st(b)}${live[b.id]?.error ? ` (${live[b.id]?.error})` : ''}.`);
    add({ key: `restart:${b.id}`, title: `Restart ${b.name}`, detail: `Restart the PgBouncer container on ${b.address}.`, kind: 'action', action: { path: `/api/nodes/${b.id}/actions/restart` } });
  }

  // ---- last resorts
  if (collapseRisk().atRisk) {
    add({ key: 'fastswap', title: 'Fast-swap to a new server', detail: 'Copy the freshest data to a new server (pg_basebackup) before the last copy is lost.', kind: 'action', ui: 'fastswap' });
  }
  if (settings.autoHeal === false) {
    add({ key: 'autoheal', title: 'Turn on auto-heal', detail: 'Settings → Auto-heal: the launcher re-attaches healthy nodes and rejoins old primaries by itself.', kind: 'info' });
  }
  add({ key: 'network', title: 'Check the network', detail: `The launcher reaches the servers over SSH and the entry ports (${entries.map((e) => e.name).join(', ')}). A firewall, a full disk or a stopped Docker daemon also block access: check the servers directly.`, kind: 'info' });
  add({ key: 'rebuild', title: 'Destroy & rebuild the cluster', detail: 'Last resort for a test environment or a cluster beyond repair: every node and its data are deleted.', kind: 'danger', ui: 'rebuild' });
  return { accessible, entries, causes, solutions };
}

/**
 * Promote a running replica when no primary is left (the node with the freshest data): it becomes the
 * primary, the topology and the other nodes follow it, and Pgpool-II is redeployed with it.
 */
const backupNotPrimary = (n: ClusterNode) =>
  `${n.name} is a backup node: it cannot be made primary by hand. It takes over by itself (last resort), or uncheck "Backup node" to make it a system node first.`;

export function promoteNode(nodeId: string): Deployment {
  const node = getNode(nodeId);
  if (!node || node.type !== 'postgres') throw fail('Choose a PostgreSQL node');
  const live = liveSnapshot();
  if (live[node.id]?.status !== 'up') throw fail(`${node.name} is not running`);
  const truth = truthPrimary();
  if (truth) throw fail(`${truth.name} is already the primary: use "Make primary" (switchover) instead`);
  if (cfgOf(node).backup) throw fail(backupNotPrimary(node));
  return startJob('promote', node.name, async (log) => {
    emitEvent('warn', `${node.name}: promoting it to primary (no primary was running)`, node.id);
    await onNode(node, async (s, rt) => {
      log.line(`${node.name}: pgcloud_promote`, 'cmd');
      await s.run(`${rt} exec ${CONTAINER_NAME.postgres} pgcloud_promote`, { sudo: true, onData: log.stream() });
    });
    for (let i = 0; i < 30 && (await pgQuery(node, 'SELECT pg_is_in_recovery()').catch(() => 't')) !== 'f'; i++) await sleep(1000);
    if ((await pgQuery(node, 'SELECT pg_is_in_recovery()')) !== 'f') throw new Error(`${node.name} did not leave recovery`);
    log.line(`${node.name} is the primary`, 'ok');
    adoptPrimary(node.id);
    // Pgpool-II / PgBouncer links of the old primary move to it when it was not a backend yet
    const t0 = topology();
    const oldPrimaries = t0.nodes.filter((n) => n.type === 'postgres' && n.id !== node.id);
    for (const e of t0.edges) {
      const src = t0.nodes.find((n) => n.id === e.source);
      if (!src || src.type === 'postgres' || !oldPrimaries.some((o) => o.id === e.target)) continue;
      if (!t0.edges.some((x) => x.source === src.id && x.target === node.id)) createEdge(src.id, node.id);
    }
    broadcast({ type: 'topology' });
    for (const n of listNodes().filter((x) => x.type === 'postgres' && x.deployedAt)) await writeNodeFiles(n, log).catch(() => undefined);
    const t = topology();
    const wasDown = new Set(t.nodes.filter((x) => liveSnapshot()[x.id]?.status === 'down').map((x) => x.id));
    await stopPgpools(t.nodes.filter((x) => x.type === 'pgpool' && x.deployedAt && !wasDown.has(x.id)), log);
    for (const n of t.nodes.filter((x) => x.deployedAt && (x.type === 'pgpool' || (x.type === 'pgbouncer' && targetsOf(t, x.id).some((d) => d.type === 'postgres'))))) {
      if (wasDown.has(n.id)) {
        pendingRedeploy.add(n.id);
        continue;
      }
      await deployNode(n, log).catch((e) => {
        log.line(`${n.name}: ${(e as Error).message} (retried when it is reachable)`, 'warn');
        pendingRedeploy.add(n.id);
      });
    }
    emitEvent('success', `${node.name} is the primary`, node.id);
  });
}
