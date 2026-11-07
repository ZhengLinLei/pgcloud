import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { ClusterNode, NodeLive } from '../../../shared/types';
import { TYPE_LABEL, TypeIcon } from './icons';
import { Dot, RoleBadge } from './ui';

export type PgNodeData = { node: ClusterNode; live?: NodeLive; role?: string; issues: number };
export type PgFlowNode = Node<PgNodeData, 'pg'>;

const fmt = (v: unknown, suffix = '') => (v === null || v === undefined ? '—' : `${v}${suffix}`);
const STATUS_TEXT = { up: 'online', degraded: 'degraded', down: 'offline', unknown: 'idle' } as const;
const TYPE_SHORT = { postgres: 'postgres', pgpool: 'pgpool', pgbouncer: 'pgbouncer' } as const;

function PgNodeView({ data, selected }: NodeProps<PgFlowNode>) {
  const { node, live, issues } = data;
  const m = live?.metrics ?? {};
  const status = live?.status ?? 'unknown';
  // live role when reachable; the drawn role for nodes not deployed yet; nothing for a node that is down
  const role = status === 'up' && live?.role ? live.role : status === 'down' ? undefined : data.role;
  const port = (node.config as { port?: number }).port;

  let metrics: Array<[string, string]>;
  if (node.type === 'postgres') {
    metrics = [
      ['conn', fmt(m.connections)],
      ['tps', fmt(m.tps)],
      role === 'primary' ? ['replicas', fmt(m.replicas)] : ['lag', fmt(m.lagSeconds, 's')],
    ];
  } else if (node.type === 'pgpool') {
    metrics = [
      ['backends', m.backends !== undefined ? `${m.backendsUp ?? 0}/${m.backends}` : '—'],
      ['qps', fmt(m.tps)],
      ['ping', fmt(live?.latencyMs, 'ms')],
    ];
  } else {
    metrics = [
      ['clients', fmt(m.connections)],
      ['servers', fmt(m.serverConnections)],
      ['tps', fmt(m.tps)],
    ];
  }

  return (
    <div className={`pg-node ${node.type} status-${status} ${selected ? 'selected' : ''}`}>
      <Handle type="target" position={Position.Top} id="t" />
      <Handle type="target" position={Position.Left} id="l" />
      <Handle type="source" position={Position.Left} id="ls" className="handle-twin" />
      <div className="pg-node-bar">
        <Dot status={status} />
        <span className={status === 'down' ? 'err' : status === 'up' ? 'ok' : ''}>{STATUS_TEXT[status]}</span>
        <span className="grow" />
        {issues > 0 && (
          <span className="err" title={`${issues} validation error(s)`}>
            ▲{issues}
          </span>
        )}
        <span title={TYPE_LABEL[node.type]}>{TYPE_SHORT[node.type]}</span>
      </div>
      <div className="pg-node-head">
        <div className="pg-node-icon">
          <TypeIcon type={node.type} size={15} />
        </div>
        <div className="pg-node-title">
          <div className="pg-node-name">{node.name}</div>
          <div className="pg-node-addr">
            {node.address || 'no host'}:{port}
          </div>
        </div>
        <RoleBadge role={role} />
      </div>
      <div className="pg-node-metrics">
        {metrics.map(([label, value]) => (
          <div key={label}>
            <b>{value}</b>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <Handle type="source" position={Position.Bottom} id="b" />
      <Handle type="source" position={Position.Right} id="r" />
      <Handle type="target" position={Position.Right} id="rt" className="handle-twin" />
    </div>
  );
}

export const PgNode = memo(PgNodeView);
