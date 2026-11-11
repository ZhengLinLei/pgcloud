import net from 'node:net';
import pg from 'pg';
import { CONTAINER_NAME, type ClusterNode, type NodeLive, type NodeStatus } from '../shared/types.js';
import { getClusterSecrets, getNodeSsh, getSettings, listNodes } from './db.js';
import { broadcast, emitEvent } from './hub.js';
import { SshSession } from './ssh.js';
import { runtimeOf } from './deploy.js';

// Real-time monitoring loop: TCP latency + SQL metrics every tick, container state over SSH every few ticks.

const HISTORY = 120;
const live = new Map<string, NodeLive>();
const counters = new Map<string, { t: number; value: number }>();
const sshCache = new Map<string, { key: string; session: SshSession }>();
let tick = 0;
let timer: NodeJS.Timeout | null = null;

export function liveSnapshot(): Record<string, NodeLive> {
  return Object.fromEntries(live);
}

function tcpProbe(host: string, port: number, timeoutMs = 1500): Promise<number | null> {
  return new Promise((resolve) => {
    const start = performance.now();
    const socket = net.connect({ host, port });
    const done = (v: number | null) => {
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(timeoutMs, () => done(null));
    socket.once('connect', () => done(Math.round((performance.now() - start) * 10) / 10));
    socket.once('error', () => done(null));
  });
}

async function withClient<T>(node: ClusterNode, database: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const settings = getSettings();
  const client = new pg.Client({
    host: node.address,
    port: Number((node.config as Record<string, unknown>).port),
    user: settings.cluster.user,
    password: getClusterSecrets().password,
    database,
    connectionTimeoutMillis: 2500,
    query_timeout: 4000,
    application_name: 'pgcloud-launcher',
  });
  client.on('error', () => undefined);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Per-second rate from a monotonically increasing counter. */
function rate(key: string, value: number | null): number | null {
  if (value === null || Number.isNaN(value)) return null;
  const now = Date.now();
  const prev = counters.get(key);
  counters.set(key, { t: now, value });
  if (!prev || value < prev.value) return null;
  return Math.round(((value - prev.value) / ((now - prev.t) / 1000)) * 10) / 10;
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

async function sqlMetrics(node: ClusterNode, result: NodeLive): Promise<void> {
  const database = getSettings().cluster.database;
  if (node.type === 'postgres') {
    await withClient(node, database, async (c) => {
      const r = await c.query(`
        SELECT pg_is_in_recovery() AS recovery,
               (SELECT count(*) FROM pg_stat_activity)::int AS connections,
               current_setting('max_connections')::int AS max_connections,
               (SELECT sum(xact_commit + xact_rollback) FROM pg_stat_database)::bigint AS xacts,
               pg_database_size(current_database())::bigint AS db_size,
               CASE WHEN pg_is_in_recovery() THEN
                 CASE WHEN pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn() THEN 0
                      ELSE coalesce(extract(epoch FROM now() - pg_last_xact_replay_timestamp()), 0) END
               END AS lag_seconds,
               extract(epoch FROM now() - pg_postmaster_start_time())::bigint AS uptime`);
      const row = r.rows[0];
      result.role = row.recovery ? 'replica' : 'primary';
      result.metrics = {
        connections: num(row.connections),
        maxConnections: num(row.max_connections),
        tps: rate(`${node.id}:xacts`, num(row.xacts)),
        dbSizeMb: row.db_size ? Math.round(Number(row.db_size) / 1048576) : null,
        lagSeconds: row.lag_seconds === null ? null : Math.round(Number(row.lag_seconds) * 10) / 10,
        uptimeSec: num(row.uptime),
      };
      if (!row.recovery) {
        const rep = await c.query(`
          SELECT application_name AS name, coalesce(client_addr::text, 'local') AS address, state, sync_state,
                 coalesce(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn), 0)::bigint AS lag_bytes
          FROM pg_stat_replication ORDER BY application_name`);
        result.tables.replication = rep.rows;
        result.metrics.replicas = rep.rowCount;
        result.metrics.maxLagBytes = rep.rows.reduce((m, x) => Math.max(m, Number(x.lag_bytes)), 0);
      } else {
        const wr = await c.query(`SELECT status, sender_host, sender_port, slot_name FROM pg_stat_wal_receiver`);
        result.tables.walReceiver = wr.rows;
      }
    });
  } else if (node.type === 'pgpool') {
    await withClient(node, database, async (c) => {
      const r = await c.query('SHOW pool_nodes');
      result.tables.poolNodes = r.rows.map((x) => ({
        node_id: x.node_id,
        hostname: x.hostname,
        port: x.port,
        status: x.status,
        pg_status: x.pg_status ?? null,
        role: x.role,
        lb_weight: x.lb_weight,
        select_cnt: x.select_cnt,
        replication_delay: x.replication_delay,
      }));
      const selects = r.rows.reduce((s, x) => s + Number(x.select_cnt ?? 0), 0);
      result.metrics = {
        backends: r.rowCount,
        backendsUp: r.rows.filter((x) => x.status === 'up' || x.status === 'waiting').length,
        tps: rate(`${node.id}:selects`, selects),
        connections: null,
      };
      result.role = 'balancer';
    });
  } else {
    await withClient(node, 'pgbouncer', async (c) => {
      const pools = await c.query('SHOW POOLS');
      const stats = await c.query('SHOW STATS');
      result.tables.pools = pools.rows
        .filter((x) => x.database !== 'pgbouncer')
        .map((x) => ({
          database: x.database,
          user: x.user,
          cl_active: x.cl_active,
          cl_waiting: x.cl_waiting,
          sv_active: x.sv_active,
          sv_idle: x.sv_idle,
          maxwait: x.maxwait,
          pool_mode: x.pool_mode,
        }));
      const xacts = stats.rows
        .filter((x) => x.database !== 'pgbouncer')
        .reduce((s, x) => s + Number(x.total_xact_count ?? 0), 0);
      result.metrics = {
        connections: pools.rows.reduce((s, x) => s + Number(x.cl_active ?? 0) + Number(x.cl_waiting ?? 0), 0),
        serverConnections: pools.rows.reduce((s, x) => s + Number(x.sv_active ?? 0) + Number(x.sv_idle ?? 0), 0),
        tps: rate(`${node.id}:xacts`, xacts),
      };
      result.role = 'pooler';
    });
  }
}

async function containerState(node: ClusterNode): Promise<string | null> {
  const rt = runtimeOf(node.id);
  if (!rt) return null;
  const cfg = getNodeSsh(node.id);
  const key = JSON.stringify([cfg.host, cfg.port, cfg.user, cfg.auth, cfg.sudo]);
  let entry = sshCache.get(node.id);
  try {
    if (!entry || entry.key !== key) {
      entry?.session.close();
      entry = { key, session: await new SshSession(cfg).connect(8000) };
      sshCache.set(node.id, entry);
    }
    const r = await entry.session.exec(`${rt} inspect -f '{{.State.Status}}' ${CONTAINER_NAME[node.type]} 2>/dev/null || echo missing`, {
      sudo: true,
      timeoutMs: 8000,
    });
    return r.stdout.trim() || 'missing';
  } catch {
    entry?.session.close();
    sshCache.delete(node.id);
    return 'ssh-unreachable';
  }
}

async function checkNode(node: ClusterNode, withContainer: boolean): Promise<NodeLive> {
  const prev = live.get(node.id);
  const result: NodeLive = {
    status: 'unknown',
    container: prev?.container ?? null,
    latencyMs: null,
    checkedAt: Date.now(),
    metrics: {},
    tables: {},
    history: prev?.history ?? [],
    role: prev?.role,
  };
  const port = Number((node.config as Record<string, unknown>).port);
  const [latency, container] = await Promise.all([
    tcpProbe(node.address, port),
    withContainer && node.deployedAt ? containerState(node) : Promise.resolve(result.container),
  ]);
  result.latencyMs = latency;
  result.container = container;
  let status: NodeStatus;
  if (latency === null) {
    status = node.deployedAt ? 'down' : 'unknown';
    if (node.deployedAt) result.error = `TCP ${node.address}:${port} unreachable`;
  } else {
    try {
      await sqlMetrics(node, result);
      status = 'up';
    } catch (e) {
      status = 'degraded';
      result.error = (e as Error).message;
    }
  }
  result.status = status;
  result.history = [
    ...result.history,
    {
      t: result.checkedAt,
      latency,
      connections: (result.metrics.connections as number | null) ?? null,
      tps: (result.metrics.tps as number | null) ?? null,
      lag: (result.metrics.lagSeconds as number | null) ?? null,
    },
  ].slice(-HISTORY);

  if (prev && prev.status !== status && !(prev.status === 'unknown' && status === 'down')) {
    const level = status === 'up' ? 'success' : status === 'degraded' ? 'warn' : status === 'down' ? 'error' : 'info';
    emitEvent(level, `${node.name} is ${status.toUpperCase()}${result.error ? ` — ${result.error}` : ''}`, node.id);
  }
  if (prev?.role && result.role && prev.role !== result.role && status === 'up') {
    emitEvent('warn', `${node.name} changed role: ${prev.role} → ${result.role}`, node.id);
  }
  return result;
}

async function runTick(): Promise<void> {
  const nodes = listNodes();
  const ids = new Set(nodes.map((n) => n.id));
  for (const id of live.keys()) if (!ids.has(id)) live.delete(id);
  const withContainer = tick % 5 === 0;
  tick++;
  const results = await Promise.all(nodes.map((n) => checkNode(n, withContainer).catch(() => null)));
  results.forEach((r, i) => r && live.set(nodes[i].id, r));
  broadcast({ type: 'live', nodes: liveSnapshot() });
  for (const fn of snapshotListeners) {
    try {
      await fn();
    } catch {
      /* a listener must never stop the monitor */
    }
  }
}

const snapshotListeners: Array<() => void | Promise<void>> = [];
/** Run `fn` after every monitoring round (used to follow failovers in the topology). */
export function onSnapshot(fn: () => void | Promise<void>): void {
  snapshotListeners.push(fn);
}

export function startMonitor(): void {
  const loop = async () => {
    try {
      await runTick();
    } finally {
      timer = setTimeout(loop, getSettings().monitorIntervalSec * 1000);
    }
  };
  void loop();
}

export function stopMonitor(): void {
  if (timer) clearTimeout(timer);
  for (const { session } of sshCache.values()) session.close();
}
