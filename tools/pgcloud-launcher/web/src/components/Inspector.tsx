import { useEffect, useMemo, useState } from 'react';
import type { ClusterNode, NodeType, ValidationIssue } from '../../../shared/types';
import { api, del, formatDuration, patch, post, timeAgo } from '../api';
import { useStore } from '../store';
import { CloseIcon, CrownIcon, FileIcon, PlayIcon, PlugIcon, RestartIcon, RocketIcon, StopIcon, SwitchIcon, TerminalIcon, TrashIcon, TYPE_LABEL, TypeIcon } from './icons';
import { Confirm, Modal, RoleBadge, StatusBadge, Terminal } from './ui';

type FieldKind = 'number' | 'text' | 'bool' | 'select';
interface FieldDef {
  key: string;
  label: string;
  kind: FieldKind;
  options?: string[];
  help?: string;
  /** only shown for backup nodes */
  backupOnly?: boolean;
}

const FIELDS: Record<NodeType, FieldDef[]> = {
  postgres: [
    { key: 'port', label: 'Port', kind: 'number' },
    { key: 'synchronous', label: 'Synchronous replication (primary)', kind: 'bool', help: 'FIRST 1 (*): commits wait for one replica' },
    { key: 'maxConnections', label: 'max_connections', kind: 'number' },
    { key: 'sharedBuffers', label: 'shared_buffers', kind: 'text', help: '25–40% of RAM' },
    { key: 'workMem', label: 'work_mem', kind: 'text' },
    { key: 'effectiveCacheSize', label: 'effective_cache_size', kind: 'text', help: '50–75% of RAM' },
    { key: 'maintenanceWorkMem', label: 'maintenance_work_mem', kind: 'text' },
    { key: 'weight', label: 'Pgpool load-balance weight', kind: 'number', help: '0 = no read traffic' },
    { key: 'promoteMinDelay', label: 'Max replay delay to promote (s)', kind: 'number', help: '0 = always promote' },
    { key: 'backup', label: 'Backup node (streams from the primary, serves no traffic)', kind: 'bool' },
    { key: 'backupReplace', label: 'Keep the number of replicas: replace a node that is down', kind: 'bool', backupOnly: true },
    { key: 'backupLastResort', label: 'Last resort: become the primary if every other node is down', kind: 'bool', backupOnly: true },
    { key: 'backupPriority', label: 'Backup priority', kind: 'number', help: 'higher acts first', backupOnly: true },
    { key: 'backupGraceSec', label: 'Act after a node is down for (s)', kind: 'number', backupOnly: true },
    {
      key: 'backupReturn',
      label: 'Return to backup when the cluster recovers (off: it becomes a system node the first time it acts)',
      kind: 'bool',
      backupOnly: true,
    },
  ],
  pgpool: [
    { key: 'port', label: 'Port', kind: 'number' },
    { key: 'pcpPort', label: 'PCP port', kind: 'number' },
    { key: 'balance', label: 'Load balance reads to replicas', kind: 'bool' },
    { key: 'numInitChildren', label: 'num_init_children', kind: 'number', help: 'Max concurrent client sessions' },
    { key: 'maxPool', label: 'max_pool', kind: 'number' },
    { key: 'healthCheckPeriod', label: 'Health check period (s)', kind: 'number' },
    { key: 'recoverReplica', label: 'Auto-recover failed replicas', kind: 'bool' },
    { key: 'wdPort', label: 'Watchdog port', kind: 'number' },
    { key: 'heartbeatPort', label: 'Heartbeat port', kind: 'number' },
    { key: 'heartbeatDevice', label: 'Heartbeat device', kind: 'text', help: 'e.g. eth0 (empty = default)' },
  ],
  pgbouncer: [
    { key: 'port', label: 'Port', kind: 'number' },
    { key: 'poolMode', label: 'Pool mode', kind: 'select', options: ['transaction', 'session', 'statement'] },
    { key: 'maxClientConn', label: 'max_client_conn', kind: 'number' },
    { key: 'defaultPoolSize', label: 'default_pool_size', kind: 'number' },
  ],
};

type Tab = 'config' | 'ssh' | 'live' | 'files';

export function Inspector({ node, issues, role, onClose }: { node: ClusterNode; issues: ValidationIssue[]; role?: string; onClose: () => void }) {
  const { live, toast, current, nodes } = useStore();
  const [tab, setTab] = useState<Tab>('config');
  const nodeLive = live[node.id];
  const busy = !!current;
  const [confirm, setConfirm] = useState<null | 'destroy' | 'remove' | 'delete' | 'switchover' | 'leader' | 'rejoin' | 'rebuild'>(null);
  const rejoinIssue = issues.find((i) => i.code === 'stale-primary' || i.code === 'not-replicating');
  const pgCfg = node.config as { backup?: boolean; backupServing?: string; backupFor?: string; promotedFromBackup?: string };
  const servingFor = pgCfg.backupFor ? nodes.find((n) => n.id === pgCfg.backupFor)?.name : undefined;
  const dismissPromoted = () =>
    patch(`/api/nodes/${node.id}`, { config: { promotedFromBackup: null } }).catch((e) => toast((e as Error).message, 'error'));

  // PostgreSQL switchover: offered on a running replica while exactly one primary runs
  const livePrimary = nodes.filter((n) => n.type === 'postgres' && live[n.id]?.status === 'up' && live[n.id]?.role === 'primary');
  const canSwitchover = node.type === 'postgres' && nodeLive?.status === 'up' && nodeLive.role === 'replica' && livePrimary.length === 1;

  // Pgpool-II watchdog: only with two or more deployed Pgpool-II nodes
  const deployedPools = nodes.filter((n) => n.type === 'pgpool' && n.deployedAt);
  const watchdogOn = node.type === 'pgpool' && !!node.deployedAt && deployedPools.length > 1;
  const [watchdog, setWatchdog] = useState<{ leader: string | null; nodes: Array<{ host: string; status: string }> } | null>(null);
  const [watchdogError, setWatchdogError] = useState('');
  useEffect(() => {
    if (!watchdogOn || current) return;
    let alive = true;
    const load = () =>
      api<{ leader: string | null; nodes: Array<{ host: string; status: string }> }>('/api/watchdog')
        .then((w) => alive && (setWatchdog(w), setWatchdogError('')))
        .catch((e) => alive && setWatchdogError((e as Error).message));
    void load();
    const t = window.setInterval(load, 10000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [watchdogOn, node.id, current]);
  const isLeader = !!watchdog && watchdog.leader === node.address;

  const run = async (path: string, what: string, body: unknown = {}) => {
    try {
      await post(path, body);
      toast(`${what} started — follow it in the Deploy tab`, 'info');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const action = async (a: string) => {
    try {
      await post(`/api/nodes/${node.id}/actions/${a}`);
      toast(`${a} ${node.name} started — follow it in the Deploy tab`, 'info');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <aside className="inspector">
      <div className="inspector-head">
        <div className="pg-node-icon" style={{ ['--c' as string]: `var(--${node.type === 'postgres' ? 'pg' : node.type === 'pgpool' ? 'pool' : 'bouncer'})` }}>
          <TypeIcon type={node.type} size={15} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>
            {node.name} <span className="muted" style={{ fontWeight: 400, fontSize: 10.5 }}>{TYPE_LABEL[node.type]}</span>
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
            <StatusBadge status={nodeLive?.status} />
            <RoleBadge role={nodeLive?.status === 'up' && nodeLive.role ? nodeLive.role : role} />
          </div>
        </div>
        <button className="btn icon ghost" onClick={onClose} aria-label="Close inspector">
          <CloseIcon />
        </button>
      </div>
      <div className="inspector-tabs">
        {(['config', 'ssh', 'live', 'files'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      <div className="inspector-body">
        {issues.map((i, k) => (
          <div key={k} className={`issue ${i.level}`}>
            {i.level === 'error' ? '✖' : '▲'} <span>{i.message}</span>
            {i.code === 'backup-promoted' && (
              <button className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={dismissPromoted}>
                Dismiss
              </button>
            )}
          </div>
        ))}

        {tab === 'config' && <ConfigForm node={node} onDeleted={onClose} />}
        {tab === 'ssh' && <SshForm node={node} />}
        {tab === 'live' && <LivePanel node={node} />}
        {tab === 'files' && <FilesPanel node={node} />}

        <div className="hr" />
        <div className="label" style={{ marginBottom: 8 }}>
          Operations {node.deployedAt && <span className="faint">· deployed {timeAgo(node.deployedAt)}</span>}
        </div>
        {node.type === 'postgres' && node.deployedAt && (
          <div className="ha-box">
            <div className="ha-title">High availability</div>
            {rejoinIssue ? (
              <>
                <p className={rejoinIssue.code === 'stale-primary' ? 'err' : 'faint'}>
                  {rejoinIssue.code === 'stale-primary'
                    ? 'Old primary: it runs as a primary next to the current one. Make it a replica again:'
                    : 'This replica does not stream from the primary. Make it follow the primary again:'}
                </p>
                <div className="btn-row">
                  <button className="btn primary" disabled={busy} onClick={() => setConfirm('rejoin')}>
                    <SwitchIcon /> Rejoin as replica
                  </button>
                  <button className="btn" disabled={busy} onClick={() => setConfirm('rebuild')}>
                    <RestartIcon /> Rebuild (fresh copy)
                  </button>
                </div>
              </>
            ) : pgCfg.backup ? (
              <p className="faint">
                {pgCfg.backupServing
                  ? `Backup in service: it works as ${pgCfg.backupServing}${servingFor ? ` in place of ${servingFor}` : ''} and hands the work back when the cluster recovers.`
                  : 'Backup node: it serves no traffic and cannot be made primary by hand.'}{' '}
                It only becomes primary by itself (last resort). To use it as a normal node, uncheck “Backup node”.
              </p>
            ) : canSwitchover ? (
              <>
                <p className="faint">
                  Planned switchover: <b>{node.name}</b> becomes the primary and <b>{livePrimary[0].name}</b> one of its replicas. No committed
                  transaction is lost; the entry point pauses for about a minute.
                </p>
                <button className="btn primary" disabled={busy} onClick={() => setConfirm('switchover')}>
                  <SwitchIcon /> Make primary
                </button>
              </>
            ) : nodeLive?.role === 'primary' ? (
              <p className="faint">This is the primary. To move the role, select a replica and press “Make primary”.</p>
            ) : (
              <p className="faint">A switchover needs this node running as a replica and exactly one running primary.</p>
            )}
          </div>
        )}
        {node.type === 'pgpool' && issues.some((i) => i.code === 'detached') && (
          <div className="ha-box">
            <div className="ha-title">Detached backends</div>
            <p className="faint">
              Pgpool-II keeps these PostgreSQL nodes detached although they are running (for example after a server restart). Re-attach
              them with PCP; with the watchdog every Pgpool-II node gets the change.
            </p>
            <button className="btn primary" disabled={busy} onClick={() => run(`/api/nodes/${node.id}/reattach`, `Re-attach in ${node.name}`)}>
              <PlugIcon /> Re-attach
            </button>
          </div>
        )}
        {watchdogOn && (
          <div className="ha-box">
            <div className="ha-title">
              Pgpool-II watchdog{' '}
              {watchdog && <span className={`badge ${isLeader ? 'ok' : ''}`}>{isLeader ? 'LEADER' : 'STANDBY'}</span>}
            </div>
            {watchdogError && <p className="err">{watchdogError}</p>}
            {watchdog && !isLeader && (
              <p className="faint">
                Leader now: <b>{nodes.find((n) => n.type === 'pgpool' && n.address === watchdog.leader)?.name ?? watchdog.leader ?? 'none'}</b>
              </p>
            )}
            <button className="btn" disabled={busy || isLeader || !watchdog} onClick={() => setConfirm('leader')}>
              <CrownIcon /> Make watchdog leader
            </button>
          </div>
        )}
        <div className="btn-row">
          <button className="btn primary" disabled={busy} onClick={() => action('deploy')}>
            <RocketIcon /> {node.deployedAt ? 'Redeploy' : 'Deploy'}
          </button>
          <button className="btn" disabled={busy || !node.deployedAt} onClick={() => action('start')}>
            <PlayIcon /> Start
          </button>
          <button className="btn" disabled={busy || !node.deployedAt} onClick={() => action('stop')}>
            <StopIcon /> Stop
          </button>
          <button className="btn" disabled={busy || !node.deployedAt} onClick={() => action('restart')}>
            <RestartIcon /> Restart
          </button>
          <button className="btn danger" disabled={busy || !node.deployedAt} onClick={() => setConfirm('remove')}>
            <TrashIcon /> Remove container
          </button>
          <button className="btn danger" disabled={busy} onClick={() => setConfirm('destroy')}>
            <TrashIcon /> Destroy (data)
          </button>
        </div>
      </div>
      {confirm === 'switchover' && livePrimary[0] && (
        <Confirm
          title="Switchover"
          message={
            <>
              <p style={{ marginTop: 0 }}>
                <b>{node.name}</b> becomes the primary and <b>{livePrimary[0].name}</b> becomes its replica. The launcher:
              </p>
              <ol style={{ margin: '0 0 0 30px', padding: 0, lineHeight: 1.6 }}>
                <li>pauses Pgpool-II, so no failover starts on its own;</li>
                <li>stops {livePrimary[0].name} cleanly and waits until {node.name} replayed all its WAL;</li>
                <li>promotes {node.name} and points the other replicas at it;</li>
                <li>resyncs {livePrimary[0].name} with pg_rewind and starts it as a replica;</li>
                <li>updates the topology, redeploys Pgpool-II and restores synchronous replication.</li>
              </ol>
              <p className="faint" style={{ marginBottom: 0 }}>Writes are not accepted for about a minute. Clients must reconnect.</p>
            </>
          }
          confirmText="Switch over"
          onConfirm={() => run(`/api/nodes/${node.id}/switchover`, `Switchover to ${node.name}`)}
          onClose={() => setConfirm(null)}
        />
      )}
      {(confirm === 'rejoin' || confirm === 'rebuild') && (
        <Confirm
          title={confirm === 'rejoin' ? 'Rejoin as replica' : 'Rebuild from the primary'}
          message={
            confirm === 'rejoin' ? (
              <>
                <b>{node.name}</b> is stopped, synchronised with the current primary using <b>pg_rewind</b> (only the changed blocks; a
                full copy if that fails) and started as its replica. Writes made on {node.name} after the failover are discarded.
                Pgpool-II pauses for the duration.
              </>
            ) : (
              <>
                The data of <b>{node.name}</b> is <b>deleted</b> and copied again from the current primary (pg_basebackup), then it
                starts as a replica. Slower than a rejoin, but it always works. Pgpool-II pauses for the duration.
              </>
            )
          }
          confirmText={confirm === 'rejoin' ? 'Rejoin' : 'Rebuild'}
          danger={confirm === 'rebuild'}
          onConfirm={() =>
            run(`/api/nodes/${node.id}/rejoin`, `${confirm === 'rejoin' ? 'Rejoin' : 'Rebuild'} ${node.name}`, { mode: confirm === 'rejoin' ? 'rewind' : 'clone' })
          }
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm === 'leader' && (
        <Confirm
          title="Watchdog leader"
          message={
            <>
              The current leader is restarted so that the other Pgpool-II nodes elect a new one, until <b>{node.name}</b> leads. Clients connected
              to the restarted node lose their connection for a few seconds.
            </>
          }
          confirmText="Make leader"
          onConfirm={() => run(`/api/nodes/${node.id}/watchdog-leader`, `Watchdog leader ${node.name}`)}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm === 'remove' && (
        <Confirm
          title="Remove container"
          message={
            <>
              Stops and removes the <b>{node.name}</b> container. Data volumes and configuration stay on the host; deploy again to recreate it.
            </>
          }
          confirmText="Remove"
          danger
          onConfirm={() => action('remove')}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm === 'destroy' && (
        <Confirm
          title="Destroy node"
          message={
            <>
              Removes the container, <b>its data volume</b> and its configuration directory on <b>{node.address}</b>. This cannot be undone.
            </>
          }
          confirmText="Destroy"
          danger
          requireText={node.name}
          onConfirm={() => action('destroy')}
          onClose={() => setConfirm(null)}
        />
      )}
    </aside>
  );
}

function ConfigForm({ node, onDeleted }: { node: ClusterNode; onDeleted: () => void }) {
  const { toast } = useStore();
  const [name, setName] = useState(node.name);
  const [address, setAddress] = useState(node.address === node.ssh.host ? '' : node.address);
  const [cfg, setCfg] = useState<Record<string, unknown>>(node.config);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setName(node.name);
    setAddress(node.address === node.ssh.host ? '' : node.address);
    setCfg(node.config);
  }, [node.id, node.name, node.address, node.ssh.host, node.config]);

  const dirty = useMemo(
    () =>
      name !== node.name ||
      address !== (node.address === node.ssh.host ? '' : node.address) ||
      JSON.stringify(cfg) !== JSON.stringify(node.config),
    [name, address, cfg, node],
  );

  const save = async () => {
    setSaving(true);
    try {
      await patch(`/api/nodes/${node.id}`, { name, address, config: cfg });
      toast(`${name} saved`, 'ok');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <label className="field">
        <span>Name</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} />
        <small>a-z, 0-9, _ · used as application_name and volume name</small>
      </label>
      <label className="field">
        <span>Cluster address</span>
        <input className="input" placeholder={node.ssh.host || 'same as SSH host'} value={address} onChange={(e) => setAddress(e.target.value)} />
        <small>IP/hostname other nodes use to reach it (defaults to the SSH host)</small>
      </label>
      <div className="hr" />
      <div className="label" style={{ marginBottom: 10 }}>
        {TYPE_LABEL[node.type]} settings
      </div>
      {FIELDS[node.type].filter((f) => !f.backupOnly || cfg.backup).map((f) =>
        f.kind === 'bool' ? (
          <label key={f.key} className="check">
            <input type="checkbox" checked={!!cfg[f.key]} onChange={(e) => setCfg({ ...cfg, [f.key]: e.target.checked })} />
            <span>{f.label}</span>
          </label>
        ) : (
          <label key={f.key} className="field">
            <span>{f.label}</span>
            {f.kind === 'select' ? (
              <select className="input" value={String(cfg[f.key])} onChange={(e) => setCfg({ ...cfg, [f.key]: e.target.value })}>
                {f.options!.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            ) : (
              <input
                className="input"
                type={f.kind === 'number' ? 'number' : 'text'}
                value={String(cfg[f.key] ?? '')}
                onChange={(e) => setCfg({ ...cfg, [f.key]: f.kind === 'number' ? Number(e.target.value) : e.target.value })}
              />
            )}
            {f.help && <small>{f.help}</small>}
          </label>
        ),
      )}
      <div className="btn-row">
        <button className="btn primary" disabled={!dirty || saving} onClick={save}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button className="btn danger" onClick={() => setConfirmDelete(true)}>
          <TrashIcon /> Delete node
        </button>
      </div>
      {confirmDelete && (
        <Confirm
          title="Delete node"
          message={
            <>
              Removes <b>{node.name}</b> and its links from the topology.
              {node.deployedAt && (
                <div className="warn" style={{ marginTop: 8 }}>
                  It is deployed: its container keeps running on {node.address}. Use “Remove container” or “Destroy” first if you want it gone.
                </div>
              )}
            </>
          }
          confirmText="Delete"
          danger
          onConfirm={async () => {
            await del(`/api/nodes/${node.id}`);
            onDeleted();
          }}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}

function SshForm({ node }: { node: ClusterNode }) {
  const { toast } = useStore();
  const [host, setHost] = useState(node.ssh.host);
  const [port, setPort] = useState(node.ssh.port);
  const [user, setUser] = useState(node.ssh.user);
  const [auth, setAuth] = useState(node.ssh.auth);
  const [sudo, setSudo] = useState(node.ssh.sudo);
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [test, setTest] = useState<{ ok: boolean; message: string; os?: string } | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    setHost(node.ssh.host);
    setPort(node.ssh.port);
    setUser(node.ssh.user);
    setAuth(node.ssh.auth);
    setSudo(node.ssh.sudo);
    setPassword('');
    setPrivateKey('');
    setPassphrase('');
    setTest(null);
  }, [node.id, node.ssh]);

  const save = async () => {
    await patch(`/api/nodes/${node.id}`, { ssh: { host, port, user, auth, sudo, password, privateKey, passphrase } });
    setPassword('');
    setPrivateKey('');
    setPassphrase('');
  };

  return (
    <div>
      <div className="row">
        <label className="field">
          <span>Host</span>
          <input className="input" placeholder="10.0.0.11" value={host} onChange={(e) => setHost(e.target.value)} />
        </label>
        <label className="field">
          <span>Port</span>
          <input className="input" type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} />
        </label>
      </div>
      <label className="field">
        <span>User</span>
        <input className="input" value={user} onChange={(e) => setUser(e.target.value)} />
      </label>
      <div className="field">
        <span>Authentication</span>
        <div className="segmented">
          <button className={auth === 'password' ? 'on' : ''} onClick={() => setAuth('password')}>
            password
          </button>
          <button className={auth === 'key' ? 'on' : ''} onClick={() => setAuth('key')}>
            private key
          </button>
        </div>
      </div>
      {auth === 'password' ? (
        <label className="field">
          <span>Password</span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            placeholder={node.ssh.hasPassword ? '•••••••• stored (leave empty to keep)' : ''}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <small>Also used by pgpool for automatic failover recovery</small>
        </label>
      ) : (
        <>
          <label className="field">
            <span>Private key (OpenSSH / PEM)</span>
            <textarea
              className="input"
              spellCheck={false}
              placeholder={node.ssh.hasPrivateKey ? 'key stored (paste a new one to replace it)' : '-----BEGIN OPENSSH PRIVATE KEY-----'}
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Passphrase</span>
            <input className="input" type="password" autoComplete="new-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
          </label>
        </>
      )}
      <label className="check">
        <input type="checkbox" checked={sudo} onChange={(e) => setSudo(e.target.checked)} />
        <span>Run container commands with sudo (passwordless)</span>
      </label>
      <div className="btn-row">
        <button
          className="btn primary"
          onClick={() =>
            save()
              .then(() => toast('SSH settings saved', 'ok'))
              .catch((e) => toast((e as Error).message, 'error'))
          }
        >
          Save
        </button>
        <button
          className="btn"
          disabled={testing}
          onClick={async () => {
            setTesting(true);
            setTest(null);
            try {
              await save();
              setTest(await post(`/api/nodes/${node.id}/test`));
            } catch (e) {
              setTest({ ok: false, message: (e as Error).message });
            } finally {
              setTesting(false);
            }
          }}
        >
          <PlugIcon /> {testing ? 'Connecting…' : 'Save & test'}
        </button>
      </div>
      {test && (
        <div className="test-result" style={{ color: test.ok ? 'var(--accent)' : 'var(--danger)' }}>
          {test.ok ? '✔ ' : '✖ '}
          {test.message}
          {test.os && <div className="muted">{test.os}</div>}
        </div>
      )}
      <p className="faint" style={{ fontSize: 11, marginTop: 14 }}>
        Credentials are stored encrypted (AES-256-GCM) and never sent back to the browser.
      </p>
    </div>
  );
}

function LivePanel({ node }: { node: ClusterNode }) {
  const { live } = useStore();
  const l = live[node.id];
  const [logs, setLogs] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const m = l?.metrics ?? {};
  const rows: Array<[string, string]> = [
    ['Container', l?.container ?? '—'],
    ['Latency', l?.latencyMs != null ? `${l.latencyMs} ms` : '—'],
    ['Last check', l ? timeAgo(l.checkedAt) : '—'],
    ...Object.entries(m).map(([k, v]) => [k, k === 'uptimeSec' ? formatDuration(v) : v === null ? '—' : String(v)] as [string, string]),
  ];
  return (
    <div>
      {l?.error && <div className="issue error">✖ <span>{l.error}</span></div>}
      <table className="table">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td className="muted">{k}</td>
              <td className="mono-num" style={{ textAlign: 'right' }}>
                {v}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {Object.entries(l?.tables ?? {}).map(([name, data]) => (
        <div key={name} style={{ marginTop: 14 }}>
          <div className="label" style={{ marginBottom: 6 }}>
            {name}
          </div>
          {data.length === 0 ? (
            <div className="faint">empty</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    {Object.keys(data[0]).map((k) => (
                      <th key={k}>{k}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.map((r, i) => (
                    <tr key={i}>
                      {Object.values(r).map((v, j) => (
                        <td key={j}>{String(v ?? '—')}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
      <div className="btn-row" style={{ marginTop: 14 }}>
        <button
          className="btn"
          disabled={!node.deployedAt || loading}
          onClick={async () => {
            setLoading(true);
            try {
              setLogs((await api<{ logs: string }>(`/api/nodes/${node.id}/logs?lines=300`)).logs);
            } catch (e) {
              setLogs(`Error: ${(e as Error).message}`);
            } finally {
              setLoading(false);
            }
          }}
        >
          <TerminalIcon /> {loading ? 'Loading…' : 'Container logs'}
        </button>
      </div>
      {logs !== null && (
        <Modal title={`${node.name} · container logs`} onClose={() => setLogs(null)}>
          <Terminal lines={logs.split('\n').map((line) => ({ line, level: /error|fatal/i.test(line) ? 'error' : /warn/i.test(line) ? 'warn' : 'info' }))} height="65vh" />
        </Modal>
      )}
    </div>
  );
}

function FilesPanel({ node }: { node: ClusterNode }) {
  const [files, setFiles] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { nodes, edges, settings } = useStore();
  useEffect(() => {
    api<{ files: Record<string, string> }>(`/api/nodes/${node.id}/files`)
      .then((r) => {
        setFiles(r.files);
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  }, [node.id, nodes, edges, settings]);
  if (error) return <div className="issue error">{error}</div>;
  if (!files) return <div className="muted">Generating…</div>;
  return (
    <div>
      <p className="muted" style={{ marginTop: 0, fontSize: 11.5 }}>
        <FileIcon /> Files written to <code>{settings.remoteDir}/{node.name}/</code> on deploy (secrets masked).
      </p>
      {Object.entries(files)
        .filter(([k]) => !k.endsWith('.keep'))
        .map(([path, content]) => (
          <div key={path} style={{ marginBottom: 12 }}>
            <div className="label" style={{ marginBottom: 5 }}>
              {path}
            </div>
            <Terminal lines={content.trim().split('\n').map((line) => ({ line, level: 'info' }))} />
          </div>
        ))}
    </div>
  );
}
