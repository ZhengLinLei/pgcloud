import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { NODE_TYPES, type NodeType, type SettingsInput } from '../shared/types.js';
import {
  createEdge,
  createNode,
  deleteEdge,
  deleteNode,
  getClusterSecrets,
  getDeploymentLog,
  getNode,
  getNodeSsh,
  getSettings,
  listDeployments,
  listEdges,
  listEvents,
  listNodes,
  updateNode,
  updateSettings,
  type NodeInput,
} from './db.js';
import { broadcast, emitEvent } from './hub.js';
import {
  SESSION_COOKIE,
  changePassword,
  cookieOptions,
  isValidSession,
  login,
  logout,
  passwordFromEnv,
  requireSession,
} from './auth.js';
import {
  adoptPrimary,
  containerLogs,
  currentDeployment,
  deployAll,
  makeWatchdogLeader,
  reattachBackends,
  runNodeAction,
  switchover,
  watchdogInfo,
  testNode,
  topology,
  validateTopology,
  type NodeAction,
} from './deploy.js';
import { ALLOWED_LINKS, computeRoles, generateFiles, targetsOf } from './topology.js';
import { liveSnapshot } from './monitor.js';
import { paths } from './env.js';

const badRequest = (message: string) => Object.assign(new Error(message), { statusCode: 400 });

const SECRET_KEY_RE = /(PASS|PASSWORD)$/;

function maskEnv(content: string): string {
  return content
    .split('\n')
    .map((line) => {
      const i = line.indexOf('=');
      return i > 0 && SECRET_KEY_RE.test(line.slice(0, i)) && line.slice(i + 1) ? `${line.slice(0, i)}=********` : line;
    })
    .join('\n');
}

function nextName(type: NodeType): string {
  const prefix = { postgres: 'pg', pgpool: 'pool', pgbouncer: 'bouncer' }[type];
  const used = new Set(listNodes().map((n) => n.name));
  for (let i = 0; ; i++) if (!used.has(`${prefix}${i}`)) return `${prefix}${i}`;
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------- public
  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/session', async (req) => ({
    authenticated: isValidSession(req.cookies[SESSION_COOKIE]),
    passwordFromEnv: passwordFromEnv(),
  }));

  app.post<{ Body: { password?: string } }>('/api/login', async (req, reply) => {
    const token = await login(String(req.body?.password ?? ''));
    if (!token) return reply.code(401).send({ error: 'Wrong password' });
    reply.setCookie(SESSION_COOKIE, token, cookieOptions());
    return { ok: true };
  });

  // ---------------------------------------------------------------- authenticated
  app.register(async (api) => {
    api.addHook('preHandler', requireSession);

    api.post('/api/logout', async (req, reply) => {
      logout(req.cookies[SESSION_COOKIE]);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    });

    api.post<{ Body: { current: string; next: string } }>('/api/admin/password', async (req) => {
      changePassword(String(req.body?.current ?? ''), String(req.body?.next ?? ''));
      return { ok: true };
    });

    api.get('/api/state', async () => ({
      nodes: listNodes(),
      edges: listEdges(),
      settings: getSettings(),
      validation: validateTopology(),
      deployments: listDeployments(),
      current: currentDeployment(),
      live: liveSnapshot(),
      events: listEvents(),
    }));

    // ---------------------------------------------- nodes
    api.post<{ Body: NodeInput }>('/api/nodes', async (req) => {
      const type = req.body?.type;
      if (!type || !NODE_TYPES.includes(type)) throw badRequest('Unknown node type');
      const node = createNode({ ...req.body, type, name: req.body.name?.trim() || nextName(type) });
      emitEvent('info', `Node ${node.name} (${node.type}) added`, node.id);
      broadcast({ type: 'topology' });
      return node;
    });

    api.patch<{ Params: { id: string }; Body: NodeInput }>('/api/nodes/:id', async (req) => {
      if (!getNode(req.params.id)) throw Object.assign(new Error('Node not found'), { statusCode: 404 });
      const body = { ...req.body };
      delete body.type;
      if (body.name !== undefined) body.name = body.name.trim();
      try {
        const node = updateNode(req.params.id, body);
        broadcast({ type: 'topology' });
        return node;
      } catch (e) {
        if (String(e).includes('UNIQUE')) throw badRequest('A node with that name already exists');
        throw e;
      }
    });

    api.delete<{ Params: { id: string } }>('/api/nodes/:id', async (req) => {
      const node = getNode(req.params.id);
      if (!node) return { ok: true };
      deleteNode(node.id);
      emitEvent('warn', `Node ${node.name} removed from the topology${node.deployedAt ? ' (its container keeps running)' : ''}`);
      broadcast({ type: 'topology' });
      return { ok: true };
    });

    api.post<{ Params: { id: string } }>('/api/nodes/:id/test', async (req) => testNode(req.params.id));

    /** Planned switchover: this replica becomes the primary, the current primary its replica. */
    api.post<{ Params: { id: string } }>('/api/nodes/:id/switchover', async (req) => switchover(req.params.id));

    /** Make this Pgpool-II node the watchdog leader. */
    api.post<{ Params: { id: string } }>('/api/nodes/:id/watchdog-leader', async (req) => makeWatchdogLeader(req.params.id));

    api.get('/api/watchdog', async () => watchdogInfo());

    /** Re-attach the running backends that this Pgpool-II node keeps detached. */
    api.post<{ Params: { id: string } }>('/api/nodes/:id/reattach', async (req) => reattachBackends(req.params.id));

    api.post<{ Params: { id: string; action: NodeAction } }>('/api/nodes/:id/actions/:action', async (req) => {
      const allowed: NodeAction[] = ['deploy', 'start', 'stop', 'restart', 'remove', 'destroy'];
      if (!allowed.includes(req.params.action)) throw badRequest('Unknown action');
      return runNodeAction(req.params.id, req.params.action);
    });

    api.get<{ Params: { id: string }; Querystring: { lines?: string } }>('/api/nodes/:id/logs', async (req) => ({
      logs: await containerLogs(req.params.id, Number(req.query.lines ?? 200)),
    }));

    api.get<{ Params: { id: string } }>('/api/nodes/:id/files', async (req) => {
      const node = getNode(req.params.id);
      if (!node) throw Object.assign(new Error('Node not found'), { statusCode: 404 });
      const { files } = generateFiles(node, {
        topology: topology(),
        settings: getSettings(),
        secrets: getClusterSecrets(),
        sshOf: getNodeSsh,
        dbRuntime: '<runtime>',
      });
      return { files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, maskEnv(v)])) };
    });

    // ---------------------------------------------- edges
    api.post<{ Body: { source: string; target: string } }>('/api/edges', async (req) => {
      const { source, target } = req.body ?? ({} as { source: string; target: string });
      const s = getNode(source);
      const d = getNode(target);
      if (!s || !d) throw badRequest('Unknown node');
      if (s.id === d.id) throw badRequest('A node cannot connect to itself');
      if (!ALLOWED_LINKS[s.type].includes(d.type))
        throw badRequest(`A ${s.type} node cannot connect to a ${d.type} node`);
      const t = topology();
      if (t.edges.some((e) => (e.source === s.id && e.target === d.id) || (e.source === d.id && e.target === s.id)))
        throw badRequest('These nodes are already connected');
      if (s.type === 'pgbouncer' && targetsOf(t, s.id).length)
        throw badRequest(`${s.name} already has a backend; remove that link first`);
      if (s.type === 'postgres' && targetsOf(t, s.id).some((n) => n.type === 'postgres'))
        throw badRequest(`${s.name} already streams from a primary`);
      const edge = createEdge(s.id, d.id);
      broadcast({ type: 'topology' });
      return edge;
    });

    api.delete<{ Params: { id: string } }>('/api/edges/:id', async (req) => {
      deleteEdge(req.params.id);
      broadcast({ type: 'topology' });
      return { ok: true };
    });

    /** Connect everything with sensible defaults: replicas -> primary, pgpool -> all postgres, pgbouncer -> pgpool (or primary). */
    api.post('/api/autolink', async () => {
      const t = topology();
      const has = (a: string, b: string) => t.edges.some((e) => e.source === a && e.target === b);
      const pgs = t.nodes.filter((n) => n.type === 'postgres');
      const roles = computeRoles(t);
      const primary =
        pgs.find((n) => roles[n.id] === 'primary' && t.edges.some((e) => e.target === n.id)) ??
        pgs.find((n) => roles[n.id] === 'primary') ??
        pgs[0];
      let created = 0;
      const link = (a: string, b: string) => {
        if (!has(a, b)) {
          createEdge(a, b);
          t.edges.push({ id: '', source: a, target: b });
          created++;
        }
      };
      for (const n of pgs) if (primary && n.id !== primary.id && !targetsOf(t, n.id).some((x) => x.type === 'postgres')) link(n.id, primary.id);
      const pools = t.nodes.filter((n) => n.type === 'pgpool');
      for (const p of pools) for (const n of pgs) link(p.id, n.id);
      for (const b of t.nodes.filter((n) => n.type === 'pgbouncer')) {
        if (targetsOf(t, b.id).length) continue;
        const target = pools[0] ?? primary;
        if (target) link(b.id, target.id);
      }
      broadcast({ type: 'topology' });
      return { created };
    });

    api.get('/api/validate', async () => validateTopology());

    /** After a failover: make every PostgreSQL node a replica of the node that is primary right now. */
    api.post('/api/adopt-live-roles', async () => {
      const t = topology();
      const live = liveSnapshot();
      const pgs = t.nodes.filter((n) => n.type === 'postgres');
      const primaries = pgs.filter((n) => live[n.id]?.status === 'up' && live[n.id]?.role === 'primary');
      if (primaries.length !== 1) throw badRequest(`Expected exactly one running primary, found ${primaries.length}`);
      const p = primaries[0];
      adoptPrimary(p.id);
      emitEvent('info', `Topology updated to the live roles: ${p.name} is the primary`, p.id);
      broadcast({ type: 'topology' });
      return { primary: p.name };
    });

    // ---------------------------------------------- deployments
    api.post('/api/deploy', async () => deployAll());
    api.get('/api/deployments', async () => ({ deployments: listDeployments(), current: currentDeployment() }));
    api.get<{ Params: { id: string } }>('/api/deployments/:id/log', async (req) => ({ log: getDeploymentLog(req.params.id) }));
    api.get('/api/events', async () => listEvents());

    // ---------------------------------------------- settings
    api.get('/api/settings', async () => getSettings());
    api.put<{ Body: SettingsInput }>('/api/settings', async (req) => {
      const s = updateSettings(req.body ?? {});
      broadcast({ type: 'topology' });
      return s;
    });
    api.get<{ Params: { name: string } }>('/api/settings/secret/:name', async (req) => {
      const secrets = getClusterSecrets() as unknown as Record<string, string>;
      if (!['password', 'replicaPassword', 'pcpPassword'].includes(req.params.name)) throw badRequest('Unknown secret');
      return { value: secrets[req.params.name] };
    });

    // ---------------------------------------------- image archives (tar / tar.gz from `docker save`)
    api.post('/api/images/upload', async (req) => {
      const file = await req.file();
      if (!file) throw badRequest('No file');
      const name = path.basename(file.filename).replace(/[^\w.\-]/g, '_');
      if (!/\.(tar|tar\.gz|tgz)$/.test(name)) throw badRequest('Upload a .tar, .tar.gz or .tgz created with "docker save"');
      await pipeline(file.file, fs.createWriteStream(path.join(paths.images, name)));
      if (file.file.truncated) throw badRequest('File too large');
      const s = getSettings();
      const tarballs = [...new Set([...s.images.tarballs, name])];
      updateSettings({ images: { tarballs } });
      emitEvent('info', `Image archive ${name} uploaded`);
      broadcast({ type: 'topology' });
      return { name, size: fs.statSync(path.join(paths.images, name)).size };
    });

    api.get('/api/images', async () =>
      getSettings().images.tarballs.map((name) => {
        const p = path.join(paths.images, name);
        return { name, size: fs.existsSync(p) ? fs.statSync(p).size : null };
      }),
    );

    api.delete<{ Params: { name: string } }>('/api/images/:name', async (req) => {
      const name = path.basename(req.params.name);
      fs.rmSync(path.join(paths.images, name), { force: true });
      updateSettings({ images: { tarballs: getSettings().images.tarballs.filter((t) => t !== name) } });
      broadcast({ type: 'topology' });
      return { ok: true };
    });
  });
}
