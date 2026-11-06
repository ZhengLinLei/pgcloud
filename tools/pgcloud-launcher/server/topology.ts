import type {
  ClusterEdge,
  ClusterNode,
  NodeType,
  PgbouncerConfig,
  PgpoolConfig,
  PlanStep,
  PostgresConfig,
  SettingsView,
  Validation,
  ValidationIssue,
} from '../shared/types.js';
import { CONTAINER_NAME } from '../shared/types.js';
import type { ClusterSecrets, SshSecretConfig } from './db.js';

// Topology rules (edge = source connects to / depends on target):
//   postgres  -> postgres   replica streams from primary (a postgres without such edge is the primary)
//   pgpool    -> postgres   load balancing / failover over these backends
//   pgbouncer -> pgpool | postgres   connection pooling in front of one backend

export const ALLOWED_LINKS: Record<NodeType, NodeType[]> = {
  postgres: ['postgres'],
  pgpool: ['postgres'],
  pgbouncer: ['pgpool', 'postgres'],
};

const NAME_RE = /^[a-z][a-z0-9_]{0,30}$/;

export interface Topology {
  nodes: ClusterNode[];
  edges: ClusterEdge[];
}

export function targetsOf(t: Topology, nodeId: string): ClusterNode[] {
  return t.edges
    .filter((e) => e.source === nodeId)
    .map((e) => t.nodes.find((n) => n.id === e.target))
    .filter((n): n is ClusterNode => !!n);
}

export function computeRoles(t: Topology): Record<string, string> {
  const roles: Record<string, string> = {};
  for (const n of t.nodes) {
    if (n.type === 'postgres') {
      const up = targetsOf(t, n.id).filter((x) => x.type === 'postgres');
      roles[n.id] = up.length ? 'replica' : 'primary';
    } else if (n.type === 'pgpool') {
      roles[n.id] = 'balancer';
    } else {
      roles[n.id] = 'pooler';
    }
  }
  return roles;
}

export function primaryOf(t: Topology): ClusterNode | undefined {
  const roles = computeRoles(t);
  return t.nodes.find((n) => n.type === 'postgres' && roles[n.id] === 'primary');
}

/** Postgres backends of a pgpool node, primary first (server0 must be the primary). */
export function pgpoolBackends(t: Topology, pgpoolId: string): ClusterNode[] {
  const roles = computeRoles(t);
  return targetsOf(t, pgpoolId)
    .filter((n) => n.type === 'postgres')
    .sort((a, b) => (roles[a.id] === 'primary' ? -1 : roles[b.id] === 'primary' ? 1 : a.name.localeCompare(b.name)));
}

export function nodePorts(n: ClusterNode): Array<[string, number]> {
  const c = n.config as Record<string, number>;
  if (n.type === 'postgres') return [['postgres', c.port]];
  if (n.type === 'pgpool')
    return [
      ['pgpool', c.port],
      ['pcp', c.pcpPort],
      ['watchdog', c.wdPort],
      ['heartbeat', c.heartbeatPort],
    ];
  return [['pgbouncer', c.port]];
}

export function validate(
  t: Topology,
  settings: SettingsView,
  sshOf: (id: string) => SshSecretConfig,
  secrets: ClusterSecrets,
): Validation {
  const issues: ValidationIssue[] = [];
  const err = (message: string, nodeId?: string) => issues.push({ level: 'error', message, nodeId });
  const warn = (message: string, nodeId?: string) => issues.push({ level: 'warning', message, nodeId });
  const roles = computeRoles(t);
  const byType = (type: NodeType) => t.nodes.filter((n) => n.type === type);

  if (!t.nodes.length) err('The topology is empty. Add at least one PostgreSQL node.');

  // Cluster settings
  if (!secrets.password) err('Cluster password is not set (Settings).');
  if (!secrets.replicaPassword) err('Replication password is not set (Settings).');
  if (byType('pgpool').length && !secrets.pcpPassword) err('PCP password is not set (Settings).');
  if (settings.images.source === 'tarball' && !settings.images.tarballs.length)
    err('Image source is "tar.gz" but no image archive has been uploaded (Settings).');
  if (!settings.cluster.allowedCidrs.trim()) err('Allowed networks (CIDR) cannot be empty (Settings).');

  // Names, SSH
  const names = new Set<string>();
  for (const n of t.nodes) {
    if (!NAME_RE.test(n.name))
      err(`"${n.name}": names must start with a letter and use only a-z, 0-9 and _ (max 31).`, n.id);
    if (names.has(n.name)) err(`Duplicated node name "${n.name}".`, n.id);
    names.add(n.name);
    const ssh = sshOf(n.id);
    if (!ssh.host) err(`${n.name}: SSH host is missing.`, n.id);
    if (!ssh.user) err(`${n.name}: SSH user is missing.`, n.id);
    if (ssh.auth === 'password' && !ssh.password) err(`${n.name}: SSH password is missing.`, n.id);
    if (ssh.auth === 'key' && !ssh.privateKey) err(`${n.name}: SSH private key is missing.`, n.id);
    for (const [label, port] of nodePorts(n)) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) err(`${n.name}: invalid ${label} port "${port}".`, n.id);
    }
  }

  // One container of each type per host, and no port clashes on a host (host networking)
  const hostKey = (n: ClusterNode) => sshOf(n.id).host;
  const seen = new Map<string, ClusterNode>();
  const ports = new Map<string, string>();
  for (const n of t.nodes) {
    if (!hostKey(n)) continue; // already reported as "SSH host is missing"
    const key = `${hostKey(n)}|${n.type}`;
    const other = seen.get(key);
    if (other)
      err(
        `${n.name} and ${other.name} are both ${n.type} nodes on host ${hostKey(n)}. Only one ${n.type} container (${CONTAINER_NAME[n.type]}) per host is supported.`,
        n.id,
      );
    seen.set(key, n);
    for (const [label, port] of nodePorts(n)) {
      const pk = `${hostKey(n)}:${port}`;
      const used = ports.get(pk);
      if (used) err(`Port ${port} on ${hostKey(n)} is used twice (${used} and ${n.name} ${label}).`, n.id);
      ports.set(pk, `${n.name} ${label}`);
    }
  }

  // Edges
  for (const e of t.edges) {
    const s = t.nodes.find((n) => n.id === e.source);
    const d = t.nodes.find((n) => n.id === e.target);
    if (!s || !d) continue;
    if (!ALLOWED_LINKS[s.type].includes(d.type)) err(`Invalid link ${s.name} (${s.type}) → ${d.name} (${d.type}).`, s.id);
  }

  // PostgreSQL
  const pgs = byType('postgres');
  const primaries = pgs.filter((n) => roles[n.id] === 'primary');
  if (pgs.length && primaries.length === 0) err('There is no primary: every PostgreSQL node points to another one (cycle).');
  if (primaries.length > 1)
    err(
      `There are ${primaries.length} primaries (${primaries.map((p) => p.name).join(', ')}). Connect every replica to the primary.`,
    );
  for (const n of pgs.filter((x) => roles[x.id] === 'replica')) {
    const up = targetsOf(t, n.id).filter((x) => x.type === 'postgres');
    if (up.length > 1) err(`${n.name}: a replica can only stream from one primary.`, n.id);
    if (up.some((u) => roles[u.id] !== 'primary')) err(`${n.name}: cascading replication is not supported; connect it to the primary.`, n.id);
  }
  const primary = primaries[0];
  if (primary && (primary.config as unknown as PostgresConfig).synchronous && pgs.length === 1)
    warn(`${primary.name}: synchronous replication is enabled but there are no replicas; it will be deployed as asynchronous.`, primary.id);

  // Pgpool
  const pools = byType('pgpool');
  const backendKey = (id: string) =>
    pgpoolBackends(t, id)
      .map((n) => n.id)
      .sort()
      .join(',');
  for (const p of pools) {
    const backends = pgpoolBackends(t, p.id);
    if (!backends.length) err(`${p.name}: connect it to the PostgreSQL nodes it must balance.`, p.id);
    else if (primary && !backends.some((b) => b.id === primary.id)) err(`${p.name}: it must be connected to the primary (${primary.name}).`, p.id);
    if (pools.length > 1 && backendKey(p.id) !== backendKey(pools[0].id))
      err(`${p.name}: all pgpool nodes of a watchdog cluster must be connected to the same PostgreSQL nodes.`, p.id);
    for (const b of backends) {
      const ssh = sshOf(b.id);
      if (ssh.auth !== 'password')
        warn(`${b.name}: automatic failover recovery from pgpool uses SSH passwords; with key auth pgpool will only detach the node.`, b.id);
    }
  }
  if (pools.length) {
    const sudo = new Set(pgs.map((n) => sshOf(n.id).sudo));
    if (sudo.size > 1) warn('Some PostgreSQL hosts use sudo and others do not: pgpool failover commands will use sudo on all of them.');
  }
  if (pools.length === 2) warn('A watchdog cluster with 2 pgpool nodes cannot form a quorum after a failure; use 1 or 3+.');

  // PgBouncer
  for (const b of byType('pgbouncer')) {
    const up = targetsOf(t, b.id);
    if (up.length !== 1) err(`${b.name}: connect it to exactly one backend (a pgpool or a PostgreSQL node).`, b.id);
    else if (up[0].type === 'postgres' && roles[up[0].id] === 'replica')
      warn(`${b.name}: it points to a replica, so it will only accept read-only queries.`, b.id);
  }

  const order: Record<string, number> = { primary: 0, replica: 1, balancer: 2, pooler: 3 };
  const plan: PlanStep[] = [...t.nodes]
    .sort((a, b) => order[roles[a.id]] - order[roles[b.id]] || a.name.localeCompare(b.name))
    .map((n) => ({ nodeId: n.id, name: n.name, type: n.type, role: roles[n.id], host: sshOf(n.id).host }));

  return { ok: !issues.some((i) => i.level === 'error'), issues, plan, roles };
}

// ------------------------------------------------------------------ generated files

/**
 * KEY=value lines. `docker --env-file` takes values literally (no quotes), while the
 * pgpool node files are loaded with bash `source`, so those are single-quoted.
 */
function envFile(vars: Record<string, string | number | boolean>, shellQuoted = false): string {
  return (
    Object.entries(vars)
      .map(([k, v]) => {
        const value = String(v);
        if (/[\r\n]/.test(value)) throw new Error(`Value of ${k} cannot contain line breaks`);
        return shellQuoted ? `${k}='${value.replace(/'/g, `'\\''`)}'` : `${k}=${value}`;
      })
      .join('\n') + '\n'
  );
}

export interface GeneratedFiles {
  /** Path relative to the node directory -> content */
  files: Record<string, string>;
}

export interface GenContext {
  topology: Topology;
  settings: SettingsView;
  secrets: ClusterSecrets;
  sshOf: (id: string) => SshSecretConfig;
  /** Runtime binary that pgpool failover commands use on the PostgreSQL hosts. */
  dbRuntime: string;
}

export function generateFiles(node: ClusterNode, ctx: GenContext): GeneratedFiles {
  const { topology: t, settings, secrets } = ctx;
  const cluster = settings.cluster;
  const roles = computeRoles(t);
  const common = {
    POSTGRES_DB: cluster.database,
    POSTGRES_USER: cluster.user,
    POSTGRES_PASSWORD: secrets.password,
  };

  if (node.type === 'postgres') {
    const c = node.config as unknown as PostgresConfig;
    const role = roles[node.id];
    const primary = primaryOf(t);
    const replicas = t.nodes.filter((n) => n.type === 'postgres' && roles[n.id] === 'replica');
    const sync = c.synchronous && replicas.length > 0;
    return {
      files: {
        '.env': envFile({
          ...common,
          POSTGRES_HOST_AUTH_METHOD: 'scram-sha-256',
          POSTGRES_INITDB_ARGS: '--data-checksums',
          PGDATA: '/opt/pgdata',
          PGPORT: c.port,
          ENABLE_LOGFILE: 'off',
          LOG_FILENAME: 'postgresql-%Y-%m-%d.log',
          LOG_ROTATE_AGE: '1d',
          ALLOWED_CIDRS: cluster.allowedCidrs,
          MAX_CONNECTIONS: c.maxConnections,
          SHARED_BUFFERS: c.sharedBuffers,
          WORK_MEM: c.workMem,
          EFFECTIVE_CACHE_SIZE: c.effectiveCacheSize,
          MAINTENANCE_WORK_MEM: c.maintenanceWorkMem,
          NODE_ROLE: role,
          BACKEND_NAME: node.name,
          REPLICA_USER: cluster.replicaUser,
          REPLICA_PASS: secrets.replicaPassword,
          SYNCHRONOUS_RULE: sync ? 'FIRST 1' : '',
          SYNCHRONOUS_NAME: sync ? '*' : '',
          PRIMARY_HOST: role === 'replica' && primary ? primary.address : '127.0.0.1',
          PRIMARY_PORT: role === 'replica' && primary ? (primary.config as unknown as PostgresConfig).port : c.port,
          PROMOTE_MIN_DELAY: c.promoteMinDelay,
        }),
      },
    };
  }

  if (node.type === 'pgpool') {
    const c = node.config as unknown as PgpoolConfig;
    const backends = pgpoolBackends(t, node.id);
    const pools = t.nodes.filter((n) => n.type === 'pgpool').sort((a, b) => a.name.localeCompare(b.name));
    const dbSudo = backends.some((b) => ctx.sshOf(b.id).sudo) ? 'sudo -n ' : '';
    const rt = `${dbSudo}${ctx.dbRuntime}`;
    const files: Record<string, string> = {
      '.env': envFile({
        ...common,
        PGDATA: '/opt/pgdata',
        PGPORT: 5432,
        PGPOOL_HOST: node.address,
        PGPOOL_PORT: c.port,
        PGPOOL_BALANCE_MODE: c.balance ? 'on' : 'off',
        NUM_INIT_CHILDREN: c.numInitChildren,
        MAX_POOL: c.maxPool,
        ENABLE_LOGFILE: 'off',
        LOG_NAME: 'pgpool.log',
        LOG_FILENAME: 'pgpool-%Y-%m-%d.log',
        ALLOWED_CIDRS: cluster.allowedCidrs,
        PCP_PORT: c.pcpPort,
        PCP_USER: cluster.pcpUser,
        PCP_PASS: secrets.pcpPassword,
        SERVER_CONF_PATH: '/opt/pgcloud/conf/postgres',
        BACKEND_CONF_PATH: '/opt/pgcloud/conf/pgpool',
        POOLER_CONF_PATH: '/opt/pgcloud/conf/pgbouncer',
        REPLICA_CHECK_PERIOD: 10,
        REPLICA_USER: cluster.replicaUser,
        REPLICA_PASS: secrets.replicaPassword,
        HEALTH_CHECK_PERIOD: c.healthCheckPeriod,
        HEALTH_CHECK_TIMEOUT: 20,
        WD_PORT: c.wdPort,
        WD_HEARTBEAT_PORT: c.heartbeatPort,
        WD_HEARTBEAT_INTERVAL: 10,
        WD_HEARTBEAT_KEEPALIVE: 2,
        WD_HEARTBEAT_DEADTIME: 30,
        PGPOOL_NUM: pools.length,
        FAILOVER_RECOVER_REPLICA: c.recoverReplica ? 'true' : 'false',
        // Do not start the old primary here (it would come back as a primary): just check the
        // container exists; FAILOVER_DEPROMOTE_CMD rewinds it and starts it as a replica.
        FAILOVER_RECOVERY_PRIMARY_CMD: `${rt} inspect ${CONTAINER_NAME.postgres} >/dev/null`,
        FAILOVER_RECOVERY_REPLICA_CMD: `${rt} restart ${CONTAINER_NAME.postgres}`,
        FAILOVER_PROMOTE_CMD: `${rt} container exec ${CONTAINER_NAME.postgres} bash -c 'pgcloud_promote %x %r'`,
        FAILOVER_REDIRECT_CMD: `${rt} container exec ${CONTAINER_NAME.postgres} bash -c 'pgcloud_redirect %h %p %x %r'`,
        // Old primary -> replica: stop it cleanly, pg_rewind it against the new primary in a one-off
        // container that shares its volumes, then start it again (it comes back as a standby).
        FAILOVER_DEPROMOTE_CMD:
          `${rt} stop -t 60 ${CONTAINER_NAME.postgres} && ` +
          `${rt} run --rm --network host --volumes-from ${CONTAINER_NAME.postgres} --entrypoint pgcloud_rewind ` +
          `$(${rt} inspect -f '{{.Config.Image}}' ${CONTAINER_NAME.postgres}) %h %p && ` +
          `${rt} start ${CONTAINER_NAME.postgres}`,
      }),
    };
    backends.forEach((b, i) => {
      const bc = b.config as unknown as PostgresConfig;
      const ssh = ctx.sshOf(b.id);
      files[`conf/postgres/server${i}.env`] = envFile({
        PSQL_HOST: b.address,
        PSQL_PORT: bc.port,
        PSQL_WEIGHT: bc.weight,
        PSQL_FAIL: 'ALLOW_TO_FAILOVER',
        PSQL_PATH: '/opt/pgdata',
        PSQL_ACTIVE: 'true',
        PSQL_NAME: b.name,
        SSH_USER: ssh.user,
        SSH_PORT: ssh.port,
        SSH_PASS: ssh.auth === 'password' ? ssh.password : '',
      }, true);
    });
    pools.forEach((p, i) => {
      const pc = p.config as unknown as PgpoolConfig;
      files[`conf/pgpool/backend${i}.env`] = envFile({
        NODE_PGPOOL_HOST: p.address,
        NODE_PGPOOL_PORT: pc.port,
        NODE_WD_PORT: pc.wdPort,
        NODE_HEARTBEAT_PORT: pc.heartbeatPort,
        NODE_HEARTBEAT_DEVICE: pc.heartbeatDevice,
      }, true);
    });
    files['conf/pgbouncer/.keep'] = '';
    return { files };
  }

  // pgbouncer
  const c = node.config as unknown as PgbouncerConfig;
  const backend = targetsOf(t, node.id)[0];
  const backendPort = backend ? Number((backend.config as Record<string, unknown>).port) : 5432;
  return {
    files: {
      '.env': envFile({
        ...common,
        BACKEND_HOST: backend?.address ?? '127.0.0.1',
        BACKEND_PORT: backendPort,
        PGB_PORT: c.port,
        PGB_AUTH: 'scram-sha-256',
        ENABLE_LOGFILE: 'off',
        LOG_NAME: 'pgbouncer.log',
        LOG_FILENAME: 'pgbouncer-%Y-%m-%d.log',
        POOL_MODE: c.poolMode,
        MAX_CONNECTIONS: c.maxClientConn,
        DEFAULT_POOL_SIZE: c.defaultPoolSize,
      }),
    },
  };
}

export function imageRef(settings: SettingsView, type: NodeType): string {
  const name = settings.images.names[type];
  const registry = settings.images.source === 'hub' ? settings.images.registry.replace(/\/+$/, '') : '';
  const withTag = name.includes(':') ? name : `${name}:${settings.images.tag || 'latest'}`;
  return registry ? `${registry}/${withTag}` : withTag;
}
