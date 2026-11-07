import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NodeType } from '../shared/types.js';

// PgCloud build contexts (docker/<service>/ + static/<service>/) used by the "build on hosts"
// image source. They are bundled in the launcher image at /app/pgcloud-src; when running from
// the repository (development) the repository root is used.

export const SERVICE_DIR: Record<NodeType, string> = { postgres: 'db', pgpool: 'pgpool', pgbouncer: 'pgbouncer' };

const here = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATES = [
  process.env.PGCLOUD_SRC ?? '',
  '/app/pgcloud-src',
  path.resolve(here, '../../..'), // tools/pgcloud-launcher/server -> repo root (tsx)
  path.resolve(here, '../../../..'), // tools/pgcloud-launcher/dist/server -> repo root
].filter(Boolean);

export function sourcesRoot(): string | null {
  return CANDIDATES.find((d) => fs.existsSync(path.join(d, 'docker/db/Dockerfile')) && fs.existsSync(path.join(d, 'static/db'))) ?? null;
}

// Never ship local secrets or editor junk to the servers
const SKIP = /(^|\/)(\.env|\.DS_Store|node_modules)$/;

function walk(root: string, rel: string, out: string[]): void {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const r = path.posix.join(rel, entry.name);
    if (SKIP.test(r)) continue;
    if (entry.isDirectory()) walk(root, r, out);
    else if (entry.isFile()) out.push(r);
  }
}

export interface BuildContext {
  root: string;
  files: string[];
  dockerfile: string;
  /** Short content hash of the context: stored as an image label to know when a rebuild is needed. */
  hash: string;
}

export function buildContext(type: NodeType): BuildContext {
  const root = sourcesRoot();
  if (!root) throw new Error('PgCloud sources not found in the launcher (expected /app/pgcloud-src or the repository)');
  const svc = SERVICE_DIR[type];
  const files: string[] = [];
  walk(root, `docker/${svc}`, files);
  walk(root, `static/${svc}`, files);
  files.sort();
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(f + '\0');
    h.update(fs.readFileSync(path.join(root, f)));
  }
  return { root, files, dockerfile: `docker/${svc}/Dockerfile`, hash: h.digest('hex').slice(0, 16) };
}
