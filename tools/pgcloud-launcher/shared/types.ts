// Types shared by the backend (server/) and the web UI (web/).

export type NodeType = 'postgres' | 'pgpool' | 'pgbouncer';

export type SshAuth = 'password' | 'key';

/** SSH access as returned by the API: secrets are never sent back, only whether they are set. */
export interface SshView {
  host: string;
  port: number;
  user: string;
  auth: SshAuth;
  sudo: boolean;
  hasPassword: boolean;
  hasPrivateKey: boolean;
}

/** SSH access as sent by the UI. Empty/omitted secrets keep the stored value. */
export interface SshInput {
  host: string;
  port: number;
  user: string;
  auth: SshAuth;
  sudo: boolean;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export interface PostgresConfig {
  port: number;
  synchronous: boolean;
  maxConnections: number;
  sharedBuffers: string;
  workMem: string;
  effectiveCacheSize: string;
  maintenanceWorkMem: string;
  weight: number;
  promoteMinDelay: number;
}

export interface PgpoolConfig {
  port: number;
  pcpPort: number;
  balance: boolean;
  numInitChildren: number;
  maxPool: number;
  wdPort: number;
  heartbeatPort: number;
  heartbeatDevice: string;
  healthCheckPeriod: number;
  recoverReplica: boolean;
}

export interface PgbouncerConfig {
  port: number;
  poolMode: 'session' | 'transaction' | 'statement';
  maxClientConn: number;
  defaultPoolSize: number;
}

export type NodeConfig = PostgresConfig | PgpoolConfig | PgbouncerConfig;

export interface ClusterNode {
  id: string;
  type: NodeType;
  name: string;
  /** Address other nodes (and the launcher) use to reach this node. Defaults to the SSH host. */
  address: string;
  x: number;
  y: number;
  ssh: SshView;
  config: Record<string, unknown>;
  deployedAt: string | null;
}

export interface ClusterEdge {
  id: string;
  /** The node that connects to / depends on `target` (replica -> primary, pgpool -> postgres, pgbouncer -> backend). */
  source: string;
  target: string;
}

/** build: build on each server from the PgCloud sources bundled in the launcher (default). */
export type ImageSource = 'build' | 'hub' | 'local' | 'tarball';
export type RuntimeChoice = 'auto' | 'docker' | 'podman';

export interface SettingsView {
  cluster: {
    database: string;
    user: string;
    replicaUser: string;
    pcpUser: string;
    allowedCidrs: string;
    hasPassword: boolean;
    hasReplicaPassword: boolean;
    hasPcpPassword: boolean;
  };
  images: {
    source: ImageSource;
    registry: string;
    tag: string;
    names: Record<NodeType, string>;
    tarballs: string[];
  };
  runtime: RuntimeChoice;
  remoteDir: string;
  monitorIntervalSec: number;
}

export interface SettingsInput {
  cluster?: Partial<SettingsView['cluster']> & { password?: string; replicaPassword?: string; pcpPassword?: string };
  images?: Partial<SettingsView['images']>;
  runtime?: RuntimeChoice;
  remoteDir?: string;
  monitorIntervalSec?: number;
}

export interface ValidationIssue {
  level: 'error' | 'warning';
  nodeId?: string;
  message: string;
  /** 'roles' = the live roles differ from the topology (a failover happened). */
  code?: string;
}

export interface PlanStep {
  nodeId: string;
  name: string;
  type: NodeType;
  role: string;
  host: string;
}

export interface Validation {
  ok: boolean;
  issues: ValidationIssue[];
  plan: PlanStep[];
  roles: Record<string, string>;
}

export type NodeStatus = 'up' | 'degraded' | 'down' | 'unknown';

export interface NodeLive {
  status: NodeStatus;
  container: string | null;
  latencyMs: number | null;
  checkedAt: number;
  error?: string;
  role?: string;
  metrics: Record<string, number | null>;
  /** Type specific tables (replication, pool_nodes, pools...). */
  tables: Record<string, Array<Record<string, string | number | null>>>;
  history: Array<{ t: number; latency: number | null; connections: number | null; tps: number | null; lag: number | null }>;
}

export interface ClusterEvent {
  id: number;
  ts: string;
  nodeId: string | null;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
}

export interface Deployment {
  id: string;
  action: string;
  target: string;
  status: 'running' | 'success' | 'failed';
  startedAt: string;
  finishedAt: string | null;
}

export type WsMessage =
  | { type: 'live'; nodes: Record<string, NodeLive> }
  | { type: 'log'; deploymentId: string; line: string; level?: string }
  | { type: 'deployment'; deployment: Deployment }
  | { type: 'event'; event: ClusterEvent }
  | { type: 'topology' };

export const NODE_TYPES: NodeType[] = ['postgres', 'pgpool', 'pgbouncer'];

export const APP_VERSION = '1.0.1';

/** Image names used by the "build", "tar.gz" and "on hosts" sources. */
export const LOCAL_IMAGES = {
  names: { postgres: 'pgcloud/db', pgpool: 'pgcloud/pgpool', pgbouncer: 'pgcloud/pgbouncer' } as Record<NodeType, string>,
  tag: 'latest',
};

/** Official images on Docker Hub (published by .github/workflows/release-images.yml), default for the "registry" source. */
export const HUB_IMAGES = {
  registry: 'docker.io/zhenglinlei',
  names: { postgres: 'pgcloud-db', pgpool: 'pgcloud-pgpool', pgbouncer: 'pgcloud-pgbouncer' } as Record<NodeType, string>,
  tag: APP_VERSION,
};

export const DEFAULT_CONFIG: Record<NodeType, Record<string, unknown>> = {
  postgres: {
    port: 5432,
    synchronous: true,
    maxConnections: 1000,
    sharedBuffers: '256MB',
    workMem: '16MB',
    effectiveCacheSize: '512MB',
    maintenanceWorkMem: '64MB',
    weight: 1,
    promoteMinDelay: 0,
  } satisfies PostgresConfig,
  pgpool: {
    port: 5434,
    pcpPort: 9898,
    balance: true,
    numInitChildren: 64,
    maxPool: 4,
    wdPort: 9000,
    heartbeatPort: 9694,
    heartbeatDevice: '',
    healthCheckPeriod: 10,
    recoverReplica: true,
  } satisfies PgpoolConfig,
  pgbouncer: {
    port: 6432,
    poolMode: 'transaction',
    maxClientConn: 2000,
    defaultPoolSize: 100,
  } satisfies PgbouncerConfig,
};

/** Container names are fixed per node type: pgpool's failover commands address the db container by name. */
export const CONTAINER_NAME: Record<NodeType, string> = {
  postgres: 'pgcloud_db',
  pgpool: 'pgcloud_pool',
  pgbouncer: 'pgcloud_bouncer',
};
