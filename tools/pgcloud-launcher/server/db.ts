import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { paths } from './env.js';
import { encrypt, decrypt, randomToken } from './crypto.js';
import {
  DEFAULT_CONFIG,
  type ClusterEdge,
  type ClusterEvent,
  type ClusterNode,
  type Deployment,
  type NodeType,
  type SettingsInput,
  type SettingsView,
  type SshInput,
} from '../shared/types.js';

// SQLite (built into Node 22) keeps the topology, settings, events and deployment logs.

export const db = new DatabaseSync(paths.db);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL UNIQUE,
    address TEXT NOT NULL DEFAULT '',
    x REAL NOT NULL DEFAULT 0,
    y REAL NOT NULL DEFAULT 0,
    ssh TEXT NOT NULL,
    config TEXT NOT NULL,
    deployed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    target TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    UNIQUE (source, target)
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    node_id TEXT,
    level TEXT NOT NULL,
    message TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS deployments (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    log TEXT NOT NULL DEFAULT ''
  );
`);

// ---------------------------------------------------------------- key/value

function kvGet<T>(key: string): T | undefined {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : undefined;
}

function kvSet(key: string, value: unknown): void {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    JSON.stringify(value),
  );
}

export const kv = { get: kvGet, set: kvSet };

// ---------------------------------------------------------------- settings

interface SettingsStored {
  cluster: {
    database: string;
    user: string;
    password: string;
    replicaUser: string;
    replicaPassword: string;
    pcpUser: string;
    pcpPassword: string;
    allowedCidrs: string;
  };
  images: SettingsView['images'];
  runtime: SettingsView['runtime'];
  remoteDir: string;
  monitorIntervalSec: number;
}

function defaultSettings(): SettingsStored {
  // Strong random passwords so a fresh install works without editing anything.
  return {
    cluster: {
      database: 'db_pgcloud',
      user: 'u_pgcloud',
      password: encrypt(randomToken(18)),
      replicaUser: 'pgrepuser',
      replicaPassword: encrypt(randomToken(18)),
      pcpUser: 'pcp_admin',
      pcpPassword: encrypt(randomToken(18)),
      allowedCidrs: '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16',
    },
    images: {
      source: 'local',
      registry: '',
      tag: 'latest',
      names: { postgres: 'pgcloud/db', pgpool: 'pgcloud/pgpool', pgbouncer: 'pgcloud/pgbouncer' },
      tarballs: [],
    },
    runtime: 'auto',
    remoteDir: '~/pgcloud',
    monitorIntervalSec: 3,
  };
}

function storedSettings(): SettingsStored {
  let s = kvGet<SettingsStored>('settings');
  if (!s) {
    s = defaultSettings();
    kvSet('settings', s);
  }
  const d = defaultSettings();
  return {
    ...d,
    ...s,
    cluster: { ...d.cluster, ...s.cluster },
    images: { ...d.images, ...s.images, names: { ...d.images.names, ...s.images?.names } },
  };
}

export interface ClusterSecrets {
  password: string;
  replicaPassword: string;
  pcpPassword: string;
}

export function getSettings(): SettingsView {
  const s = storedSettings();
  const { password, replicaPassword, pcpPassword, ...cluster } = s.cluster;
  return {
    ...s,
    cluster: {
      ...cluster,
      hasPassword: !!password,
      hasReplicaPassword: !!replicaPassword,
      hasPcpPassword: !!pcpPassword,
    },
  };
}

export function getClusterSecrets(): ClusterSecrets {
  const c = storedSettings().cluster;
  return {
    password: decrypt(c.password),
    replicaPassword: decrypt(c.replicaPassword),
    pcpPassword: decrypt(c.pcpPassword),
  };
}

export function updateSettings(input: SettingsInput): SettingsView {
  const s = storedSettings();
  if (input.cluster) {
    const { password, replicaPassword, pcpPassword, hasPassword, hasReplicaPassword, hasPcpPassword, ...rest } =
      input.cluster as Record<string, unknown>;
    void hasPassword;
    void hasReplicaPassword;
    void hasPcpPassword;
    Object.assign(s.cluster, rest);
    if (typeof password === 'string' && password) s.cluster.password = encrypt(password);
    if (typeof replicaPassword === 'string' && replicaPassword) s.cluster.replicaPassword = encrypt(replicaPassword);
    if (typeof pcpPassword === 'string' && pcpPassword) s.cluster.pcpPassword = encrypt(pcpPassword);
  }
  if (input.images) {
    s.images = { ...s.images, ...input.images, names: { ...s.images.names, ...input.images.names } };
  }
  if (input.runtime) s.runtime = input.runtime;
  if (typeof input.remoteDir === 'string' && input.remoteDir.trim()) s.remoteDir = input.remoteDir.trim();
  if (typeof input.monitorIntervalSec === 'number') {
    s.monitorIntervalSec = Math.min(60, Math.max(1, Math.round(input.monitorIntervalSec)));
  }
  kvSet('settings', s);
  return getSettings();
}

// ---------------------------------------------------------------- nodes

interface SshStored {
  host: string;
  port: number;
  user: string;
  auth: 'password' | 'key';
  sudo: boolean;
  password: string;
  privateKey: string;
  passphrase: string;
}

export interface SshSecretConfig {
  host: string;
  port: number;
  user: string;
  auth: 'password' | 'key';
  sudo: boolean;
  password: string;
  privateKey: string;
  passphrase: string;
}

interface NodeRow {
  id: string;
  type: NodeType;
  name: string;
  address: string;
  x: number;
  y: number;
  ssh: string;
  config: string;
  deployed_at: string | null;
}

function toNode(row: NodeRow): ClusterNode {
  const ssh = JSON.parse(row.ssh) as SshStored;
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    address: row.address || ssh.host,
    x: row.x,
    y: row.y,
    ssh: {
      host: ssh.host,
      port: ssh.port,
      user: ssh.user,
      auth: ssh.auth,
      sudo: ssh.sudo,
      hasPassword: !!ssh.password,
      hasPrivateKey: !!ssh.privateKey,
    },
    config: { ...DEFAULT_CONFIG[row.type], ...(JSON.parse(row.config) as Record<string, unknown>) },
    deployedAt: row.deployed_at,
  };
}

export function listNodes(): ClusterNode[] {
  return (db.prepare('SELECT * FROM nodes ORDER BY created_at, name').all() as unknown as NodeRow[]).map(toNode);
}

export function getNode(id: string): ClusterNode | undefined {
  const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as unknown as NodeRow | undefined;
  return row ? toNode(row) : undefined;
}

export function getNodeSsh(id: string): SshSecretConfig {
  const row = db.prepare('SELECT ssh FROM nodes WHERE id = ?').get(id) as { ssh: string } | undefined;
  if (!row) throw new Error('Node not found');
  const s = JSON.parse(row.ssh) as SshStored;
  return { ...s, password: decrypt(s.password), privateKey: decrypt(s.privateKey), passphrase: decrypt(s.passphrase) };
}

function mergeSsh(previous: SshStored | undefined, input: Partial<SshInput> | undefined): SshStored {
  const base: SshStored = previous ?? {
    host: '',
    port: 22,
    user: 'root',
    auth: 'password',
    sudo: false,
    password: '',
    privateKey: '',
    passphrase: '',
  };
  if (!input) return base;
  return {
    host: (input.host ?? base.host).trim(),
    port: Number(input.port ?? base.port) || 22,
    user: (input.user ?? base.user).trim(),
    auth: input.auth ?? base.auth,
    sudo: input.sudo ?? base.sudo,
    password: input.password ? encrypt(input.password) : base.password,
    privateKey: input.privateKey ? encrypt(input.privateKey) : base.privateKey,
    passphrase: input.passphrase ? encrypt(input.passphrase) : base.passphrase,
  };
}

export interface NodeInput {
  type?: NodeType;
  name?: string;
  address?: string;
  x?: number;
  y?: number;
  ssh?: Partial<SshInput>;
  config?: Record<string, unknown>;
}

export function createNode(input: NodeInput & { type: NodeType; name: string }): ClusterNode {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO nodes (id, type, name, address, x, y, ssh, config) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    input.type,
    input.name,
    input.address ?? '',
    input.x ?? 0,
    input.y ?? 0,
    JSON.stringify(mergeSsh(undefined, input.ssh)),
    JSON.stringify({ ...DEFAULT_CONFIG[input.type], ...(input.config ?? {}) }),
  );
  return getNode(id)!;
}

export function updateNode(id: string, input: NodeInput): ClusterNode {
  const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as unknown as NodeRow | undefined;
  if (!row) throw new Error('Node not found');
  const ssh = mergeSsh(JSON.parse(row.ssh) as SshStored, input.ssh);
  const config = { ...(JSON.parse(row.config) as Record<string, unknown>), ...(input.config ?? {}) };
  db.prepare('UPDATE nodes SET name = ?, address = ?, x = ?, y = ?, ssh = ?, config = ? WHERE id = ?').run(
    input.name ?? row.name,
    input.address ?? row.address,
    input.x ?? row.x,
    input.y ?? row.y,
    JSON.stringify(ssh),
    JSON.stringify(config),
    id,
  );
  return getNode(id)!;
}

export function setNodeDeployed(id: string, deployed: boolean): void {
  db.prepare('UPDATE nodes SET deployed_at = ? WHERE id = ?').run(deployed ? new Date().toISOString() : null, id);
}

export function deleteNode(id: string): void {
  db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
}

// ---------------------------------------------------------------- edges

export function listEdges(): ClusterEdge[] {
  return db.prepare('SELECT id, source, target FROM edges').all() as unknown as ClusterEdge[];
}

export function createEdge(source: string, target: string): ClusterEdge {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO edges (id, source, target) VALUES (?, ?, ?)').run(id, source, target);
  return { id, source, target };
}

export function deleteEdge(id: string): void {
  db.prepare('DELETE FROM edges WHERE id = ?').run(id);
}

// ---------------------------------------------------------------- events

export function addEvent(level: ClusterEvent['level'], message: string, nodeId: string | null = null): ClusterEvent {
  const info = db.prepare('INSERT INTO events (node_id, level, message) VALUES (?, ?, ?)').run(nodeId, level, message);
  db.prepare('DELETE FROM events WHERE id <= ?').run(Number(info.lastInsertRowid) - 5000);
  return db
    .prepare('SELECT id, ts, node_id AS nodeId, level, message FROM events WHERE id = ?')
    .get(info.lastInsertRowid) as unknown as ClusterEvent;
}

export function listEvents(limit = 300): ClusterEvent[] {
  return db
    .prepare('SELECT id, ts, node_id AS nodeId, level, message FROM events ORDER BY id DESC LIMIT ?')
    .all(limit) as unknown as ClusterEvent[];
}

// ---------------------------------------------------------------- deployments

export function createDeployment(action: string, target: string): Deployment {
  const d: Deployment = {
    id: crypto.randomUUID(),
    action,
    target,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  db.prepare('INSERT INTO deployments (id, action, target, status, started_at) VALUES (?, ?, ?, ?, ?)').run(
    d.id,
    d.action,
    d.target,
    d.status,
    d.startedAt,
  );
  return d;
}

export function appendDeploymentLog(id: string, line: string): void {
  db.prepare('UPDATE deployments SET log = log || ? WHERE id = ?').run(line + '\n', id);
}

export function finishDeployment(id: string, status: 'success' | 'failed'): Deployment {
  db.prepare('UPDATE deployments SET status = ?, finished_at = ? WHERE id = ?').run(status, new Date().toISOString(), id);
  return getDeployment(id)!;
}

export function getDeployment(id: string): Deployment | undefined {
  return db
    .prepare(
      'SELECT id, action, target, status, started_at AS startedAt, finished_at AS finishedAt FROM deployments WHERE id = ?',
    )
    .get(id) as unknown as Deployment | undefined;
}

export function getDeploymentLog(id: string): string {
  const row = db.prepare('SELECT log FROM deployments WHERE id = ?').get(id) as { log: string } | undefined;
  return row?.log ?? '';
}

export function listDeployments(limit = 50): Deployment[] {
  return db
    .prepare(
      'SELECT id, action, target, status, started_at AS startedAt, finished_at AS finishedAt FROM deployments ORDER BY started_at DESC LIMIT ?',
    )
    .all(limit) as unknown as Deployment[];
}

// Deployments interrupted by a launcher restart can never finish.
db.prepare("UPDATE deployments SET status = 'failed', finished_at = ? WHERE status = 'running'").run(
  new Date().toISOString(),
);
