import type { ClusterNode, NodeLive } from '../../../shared/types';
import { formatBytes, formatDuration } from '../api';
import { useStore } from '../store';
import { TYPE_COLOR, TYPE_LABEL, TypeIcon } from '../components/icons';
import { RoleBadge, Sparkline, StatusBadge } from '../components/ui';
import './monitor.css';

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="kpi">
      <span>{label}</span>
      <b className={tone}>{value}</b>
    </div>
  );
}

function Chart({ title, values, color, unit }: { title: string; values: Array<number | null>; color: string; unit?: string }) {
  const last = [...values].reverse().find((v) => v !== null);
  return (
    <div className="chart">
      <div className="chart-head">
        <span>{title}</span>
        <b>
          {last ?? '—'}
          {last !== undefined && last !== null && unit ? <small> {unit}</small> : null}
        </b>
      </div>
      <Sparkline values={values} color={color} width={230} height={40} />
    </div>
  );
}

function NodeCard({ node, live, role }: { node: ClusterNode; live?: NodeLive; role?: string }) {
  const h = live?.history ?? [];
  const m = live?.metrics ?? {};
  const shownRole = live?.status === 'up' && live.role ? live.role : role;
  return (
    <div className={`panel mon-card ${live?.status ?? 'unknown'}`} style={{ ['--c' as string]: TYPE_COLOR[node.type] }}>
      <div className="mon-card-head">
        <span className="pg-node-icon">
          <TypeIcon type={node.type} size={17} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800 }}>{node.name}</div>
          <div className="muted" style={{ fontSize: 11 }}>
            {TYPE_LABEL[node.type]} · {node.address}:{String((node.config as { port: number }).port)}
          </div>
        </div>
        <div style={{ display: 'grid', gap: 4, justifyItems: 'end' }}>
          <StatusBadge status={live?.status} />
          <RoleBadge role={shownRole} />
        </div>
      </div>
      {live?.error && live.status !== 'up' && <div className="mon-error">{live.error}</div>}
      <div className="mon-kpis">
        {node.type === 'postgres' && (
          <>
            <Stat label="conn" value={m.connections != null ? `${m.connections}/${m.maxConnections}` : '—'} />
            <Stat label="db size" value={m.dbSizeMb != null ? formatBytes(Number(m.dbSizeMb) * 1048576) : '—'} />
            <Stat label="uptime" value={formatDuration(m.uptimeSec)} />
            {shownRole === 'primary' ? (
              <Stat label="replicas" value={m.replicas ?? '—'} />
            ) : (
              <Stat label="lag" value={m.lagSeconds != null ? `${m.lagSeconds}s` : '—'} tone={Number(m.lagSeconds) > 10 ? 'warn' : undefined} />
            )}
          </>
        )}
        {node.type === 'pgpool' && (
          <>
            <Stat label="backends up" value={m.backends != null ? `${m.backendsUp}/${m.backends}` : '—'} tone={m.backends != null && m.backendsUp !== m.backends ? 'err' : undefined} />
            <Stat label="selects/s" value={m.tps ?? '—'} />
            <Stat label="latency" value={live?.latencyMs != null ? `${live.latencyMs}ms` : '—'} />
            <Stat label="container" value={live?.container ?? '—'} />
          </>
        )}
        {node.type === 'pgbouncer' && (
          <>
            <Stat label="clients" value={m.connections ?? '—'} />
            <Stat label="server conn" value={m.serverConnections ?? '—'} />
            <Stat label="tps" value={m.tps ?? '—'} />
            <Stat label="container" value={live?.container ?? '—'} />
          </>
        )}
      </div>
      <div className="mon-charts">
        <Chart title="latency" unit="ms" values={h.map((x) => x.latency)} color="var(--cyan)" />
        <Chart title={node.type === 'pgpool' ? 'selects/s' : 'tps'} values={h.map((x) => x.tps)} color="var(--accent)" />
        {node.type !== 'pgpool' && <Chart title="connections" values={h.map((x) => x.connections)} color="var(--pool)" />}
        {node.type === 'postgres' && shownRole === 'replica' && <Chart title="replay lag" unit="s" values={h.map((x) => x.lag)} color="var(--warn)" />}
      </div>
    </div>
  );
}

function DataTable({ rows }: { rows: Array<Record<string, unknown>> }) {
  if (!rows.length) return <div className="faint" style={{ padding: 14 }}>no rows</div>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="table">
        <thead>
          <tr>
            {Object.keys(rows[0]).map((k) => (
              <th key={k}>{k}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {Object.entries(r).map(([k, v]) => {
                const s = String(v ?? '—');
                const tone = /^(up|streaming|sync|primary)$/.test(s) ? 'ok' : /^(down|quarantine)$/.test(s) ? 'err' : /^(async|potential|standby|waiting)$/.test(s) ? 'muted' : '';
                return (
                  <td key={k} className={tone}>
                    {k === 'lag_bytes' ? formatBytes(Number(v)) : s}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MonitorTab() {
  const { nodes, live, validation } = useStore();
  const lives = nodes.map((n) => live[n.id]);
  const up = lives.filter((l) => l?.status === 'up').length;
  const down = lives.filter((l) => l?.status === 'down').length;
  const degraded = lives.filter((l) => l?.status === 'degraded').length;
  const primary = nodes.find((n) => n.type === 'postgres' && live[n.id]?.status === 'up' && live[n.id]?.role === 'primary');
  const tps = nodes
    .filter((n) => n.type === 'postgres')
    .reduce((s, n) => s + Number(live[n.id]?.metrics?.tps ?? 0), 0);
  const maxLag = Math.max(0, ...nodes.filter((n) => n.type === 'postgres').map((n) => Number(live[n.id]?.metrics?.lagSeconds ?? 0)));

  const tables: Array<{ title: string; rows: Array<Record<string, unknown>> }> = [];
  for (const n of nodes) {
    const t = live[n.id]?.tables ?? {};
    if (t.replication) tables.push({ title: `${n.name} · streaming replication`, rows: t.replication });
    if (t.poolNodes) tables.push({ title: `${n.name} · pgpool pool_nodes`, rows: t.poolNodes });
    if (t.pools) tables.push({ title: `${n.name} · pgbouncer pools`, rows: t.pools });
  }

  return (
    <div className="page">
      <div className="mon-summary panel">
        <div className="kpi big">
          <span>cluster</span>
          <b className={down ? 'err' : degraded ? 'warn' : up ? 'ok' : 'muted'}>
            {nodes.length === 0 ? 'EMPTY' : down ? 'DEGRADED' : degraded ? 'WARNING' : up === nodes.length ? 'HEALTHY' : 'PARTIAL'}
          </b>
        </div>
        <Stat label="nodes up" value={`${up}/${nodes.length}`} tone="ok" />
        <Stat label="down" value={down} tone={down ? 'err' : undefined} />
        <Stat label="degraded" value={degraded} tone={degraded ? 'warn' : undefined} />
        <Stat label="primary" value={primary?.name ?? '—'} tone={primary ? 'ok' : 'err'} />
        <Stat label="cluster tps" value={Math.round(tps * 10) / 10} />
        <Stat label="max lag" value={`${maxLag}s`} tone={maxLag > 10 ? 'warn' : undefined} />
      </div>

      {nodes.length === 0 ? (
        <div className="empty">No nodes yet. Design the topology first.</div>
      ) : (
        <div className="mon-grid">
          {nodes.map((n) => (
            <NodeCard key={n.id} node={n} live={live[n.id]} role={validation.roles[n.id]} />
          ))}
        </div>
      )}

      {tables.length > 0 && (
        <div className="mon-tables">
          {tables.map((t) => (
            <div key={t.title} className="panel">
              <div className="panel-title">{t.title}</div>
              <DataTable rows={t.rows} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
