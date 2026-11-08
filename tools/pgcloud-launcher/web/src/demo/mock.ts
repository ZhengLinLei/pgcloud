// Front-end only demo: answers the launcher API in the browser from a recorded snapshot of a real
// PgCloud cluster (snapshot.json) and simulates the live monitoring feed. Nothing leaves the page.
import type { ClusterEdge, ClusterEvent, ClusterNode, Deployment, NodeLive, NodeType, WsMessage } from '../../../shared/types';
import { ApiError } from '../api';
import raw from './snapshot.json';

interface Snapshot {
  capturedAt: number;
  state: {
    nodes: ClusterNode[];
    edges: ClusterEdge[];
    settings: Record<string, unknown> & { monitorIntervalSec: number };
    validation: unknown;
    deployments: Deployment[];
    current: Deployment | null;
    live: Record<string, NodeLive>;
    events: ClusterEvent[];
  };
  logs: Record<string, string>;
  files: Record<string, unknown>;
  nodeLogs: Record<string, unknown>;
  images: unknown[];
}

const READ_ONLY = 'Not available in the demo: this page only illustrates the launcher (no servers behind it).';

// ------------------------------------------------------------------ state (timestamps moved to "now")
const snap = structuredClone(raw) as unknown as Snapshot;
const shift = Date.now() - snap.capturedAt;
const iso = (s: string | null) => (s ? new Date(new Date(s).getTime() + shift).toISOString() : s);
const st = snap.state;
st.deployments.forEach((d) => {
  d.startedAt = iso(d.startedAt)!;
  d.finishedAt = iso(d.finishedAt);
});
st.events.forEach((e) => (e.ts = iso(e.ts)!));
for (const l of Object.values(st.live)) {
  l.checkedAt += shift;
  l.history.forEach((h) => (h.t += shift));
}
st.nodes.forEach((n) => (n.deployedAt = iso(n.deployedAt)));

let authenticated = true;
let nextEventId = Math.max(0, ...st.events.map((e) => e.id)) + 1;
const listeners = new Set<(m: WsMessage) => void>();
const emit = (m: WsMessage) => listeners.forEach((l) => l(m));

function event(level: ClusterEvent['level'], message: string, nodeId: string | null = null) {
  const e: ClusterEvent = { id: nextEventId++, ts: new Date().toISOString(), level, message, nodeId };
  st.events.unshift(e);
  emit({ type: 'event', event: e });
}

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
const PREFIX: Record<NodeType, string> = { postgres: 'pg', pgpool: 'pool', pgbouncer: 'bouncer' };

function nextName(type: NodeType) {
  for (let i = 0; ; i++) if (!st.nodes.some((n) => n.name === `${PREFIX[type]}${i}`)) return `${PREFIX[type]}${i}`;
}

function topologyChanged() {
  emit({ type: 'topology' });
}

// ------------------------------------------------------------------ API
type Init = { method?: string; body?: unknown };

export async function demoApi<T>(path: string, init: Init = {}): Promise<T> {
  await new Promise((r) => setTimeout(r, 80)); // feel like a network call
  return route(path.split('?')[0], (init.method ?? (init.body !== undefined ? 'POST' : 'GET')).toUpperCase(), init.body as never) as T;
}

function route(path: string, method: string, body: Record<string, unknown> | undefined): unknown {
  const m = (re: RegExp) => re.exec(path);
  let r: RegExpExecArray | null;

  if (path === '/api/session') return { authenticated, passwordFromEnv: false, demo: true };
  if (path === '/api/login') return (authenticated = true), { ok: true };
  if (path === '/api/logout') return (authenticated = false), { ok: true };
  if (path === '/api/state') return structuredClone(st);
  if (path === '/api/validate') return st.validation;
  if (path === '/api/deployments') return { deployments: st.deployments, current: st.current };
  if (path === '/api/events') return st.events;
  if (path === '/api/images') return snap.images;
  if (path === '/api/settings' && method === 'GET') return st.settings;
  if (path === '/api/settings' && method === 'PUT') {
    const b = body ?? {};
    Object.assign(st.settings, { ...b, cluster: { ...(st.settings.cluster as object), ...(b.cluster as object) }, images: { ...(st.settings.images as object), ...(b.images as object) } });
    return st.settings;
  }
  if ((r = m(/^\/api\/settings\/secret\/(\w+)$/))) return { value: 'demo-only-password' };
  if (path === '/api/watchdog') {
    const pools = st.nodes.filter((n) => n.type === 'pgpool');
    if (pools.length < 2) throw new ApiError('The watchdog needs at least two Pgpool-II nodes', 400);
    const leader = pools[0].address || pools[0].ssh.host;
    return { leader, nodes: pools.map((p) => ({ host: p.address || p.ssh.host, port: Number(p.config.port ?? 5434), status: (p.address || p.ssh.host) === leader ? 'LEADER' : 'STANDBY' })) };
  }
  if ((r = m(/^\/api\/deployments\/([^/]+)\/log$/))) return { log: snap.logs[r[1]] ?? '' };

  if (path === '/api/nodes' && method === 'POST') {
    const type = body?.type as NodeType;
    const node: ClusterNode = {
      id: uid(),
      type,
      name: (body?.name as string) || nextName(type),
      address: '',
      x: Number(body?.x ?? 0),
      y: Number(body?.y ?? 0),
      ssh: { host: '', port: 22, user: 'root', auth: 'password', sudo: false, hasPassword: false, hasPrivateKey: false },
      config: structuredClone(st.nodes.find((n) => n.type === type)?.config ?? {}),
      deployedAt: null,
    };
    st.nodes.push(node);
    event('info', `Node ${node.name} (${type}) added`, node.id);
    topologyChanged();
    return node;
  }
  if ((r = m(/^\/api\/nodes\/([^/]+)$/))) {
    const node = st.nodes.find((n) => n.id === r![1]);
    if (!node) throw new ApiError('Node not found', 404);
    if (method === 'DELETE') {
      st.nodes = st.nodes.filter((n) => n !== node);
      st.edges = st.edges.filter((e) => e.source !== node.id && e.target !== node.id);
      delete st.live[node.id];
      event('warn', `Node ${node.name} removed`);
      topologyChanged();
      return { ok: true };
    }
    const b = { ...(body ?? {}) };
    if (b.ssh) {
      const s = b.ssh as Record<string, unknown>;
      node.ssh = { ...node.ssh, ...(s as object), hasPassword: node.ssh.hasPassword || !!s.password, hasPrivateKey: node.ssh.hasPrivateKey || !!s.privateKey };
      delete b.ssh;
    }
    Object.assign(node, b);
    topologyChanged();
    return node;
  }
  if ((r = m(/^\/api\/nodes\/([^/]+)\/files$/))) return snap.files[r[1]] ?? { files: [] };
  if ((r = m(/^\/api\/nodes\/([^/]+)\/logs$/))) return snap.nodeLogs[r[1]] ?? { logs: '' };

  if (path === '/api/edges' && method === 'POST') {
    const edge: ClusterEdge = { id: uid(), source: String(body?.source), target: String(body?.target) };
    st.edges.push(edge);
    topologyChanged();
    return edge;
  }
  if ((r = m(/^\/api\/edges\/([^/]+)$/)) && method === 'DELETE') {
    st.edges = st.edges.filter((e) => e.id !== r![1]);
    topologyChanged();
    return { ok: true };
  }
  if (path === '/api/autolink') return { created: 0 };

  // Everything that would touch real servers
  throw new ApiError(READ_ONLY, 403);
}

// ------------------------------------------------------------------ live feed (replaces the WebSocket)
const jitter = (v: number | null, pct: number) => (v === null ? null : Math.max(0, v * (1 + (Math.random() * 2 - 1) * pct)));
const round = (v: number | null, d = 0) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);

function tick() {
  const now = Date.now();
  for (const [id, l] of Object.entries(st.live)) {
    if (!st.nodes.some((n) => n.id === id)) continue;
    const last = l.history[l.history.length - 1];
    const base = l.history[Math.floor(Math.random() * l.history.length)] ?? last;
    if (base) {
      l.history = [
        ...l.history.slice(-119),
        {
          t: now,
          latency: round(jitter(base.latency, 0.25), 1),
          connections: base.connections === null ? null : Math.round(jitter(base.connections, 0.1)!),
          tps: round(jitter(base.tps, 0.2), 1),
          lag: base.lag === null ? null : base.lag === 0 ? 0 : round(jitter(base.lag, 0.3), 0),
        },
      ];
    }
    l.latencyMs = l.history[l.history.length - 1]?.latency ?? l.latencyMs;
    l.checkedAt = now;
  }
  emit({ type: 'live', nodes: structuredClone(st.live) });
}

let timer: number | null = null;

export function subscribe(fn: (m: WsMessage) => void): () => void {
  listeners.add(fn);
  if (timer === null) timer = window.setInterval(tick, (st.settings.monitorIntervalSec || 3) * 1000);
  return () => {
    listeners.delete(fn);
    if (!listeners.size && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
}
