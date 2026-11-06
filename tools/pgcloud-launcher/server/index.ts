import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { env } from './env.js';
import { initAdmin, isValidSession, SESSION_COOKIE } from './auth.js';
import { registerRoutes } from './routes.js';
import { addClient } from './hub.js';
import { liveSnapshot, startMonitor, stopMonitor } from './monitor.js';

const app = Fastify({
  logger: { level: env.logLevel },
  bodyLimit: 2 * 1024 * 1024,
});

await app.register(cookie);
// Accept bodiless POSTs sent with a JSON content type (e.g. action buttons)
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  try {
    done(null, body ? JSON.parse(body as string) : {});
  } catch (e) {
    done(Object.assign(e as Error, { statusCode: 400 }), undefined);
  }
});
await app.register(multipart, { limits: { fileSize: 8 * 1024 * 1024 * 1024, files: 1 } });
await app.register(websocket);

app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
  const status = err.statusCode ?? 500;
  if (status >= 500) app.log.error(err);
  void reply.code(status).send({ error: err.message });
});

await registerRoutes(app);

app.get('/ws', { websocket: true }, (socket, req) => {
  if (!isValidSession(req.cookies[SESSION_COOKIE])) {
    socket.close(4401, 'Not authenticated');
    return;
  }
  addClient(socket);
  socket.send(JSON.stringify({ type: 'live', nodes: liveSnapshot() }));
});

// The built SPA (dist/web) with client-side routing fallback
const here = path.dirname(fileURLToPath(import.meta.url));
// dev (tsx server/index.ts): ../dist/web · production (node dist/server/index.js): ../web
const webDir = [path.resolve(here, '../dist/web'), path.resolve(here, '../web')].find(
  (d) => fs.existsSync(path.join(d, 'index.html')) && fs.existsSync(path.join(d, 'assets')),
);
if (webDir) {
  await app.register(fastifyStatic, { root: webDir, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/ws')) return reply.code(404).send({ error: 'Not found' });
    return reply.sendFile('index.html');
  });
} else {
  app.log.warn('Web UI not built (run "npm run build:web"); only the API is available');
}

initAdmin((msg) => app.log.info(msg));
startMonitor();

const shutdown = async () => {
  stopMonitor();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: env.host, port: env.port });
