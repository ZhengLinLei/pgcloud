import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react';
import type { NodeStatus } from '../../../shared/types';

export type StatusEdgeData = { status: NodeStatus; label: string; kind: 'replication' | 'balance' | 'pool' };
export type StatusFlowEdge = Edge<StatusEdgeData, 'status'>;

const COLORS: Record<NodeStatus, string> = {
  up: 'var(--accent)',
  degraded: 'var(--warn)',
  down: 'var(--danger)',
  unknown: 'var(--border-strong)',
};

function StatusEdgeView(props: EdgeProps<StatusFlowEdge>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected } = props;
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const status = data?.status ?? 'unknown';
  const color = COLORS[status];
  const alive = status === 'up';
  const kindColor = data?.kind === 'replication' ? 'var(--cyan)' : data?.kind === 'balance' ? 'var(--pool)' : 'var(--bouncer)';
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: selected ? 'var(--text)' : color,
          strokeWidth: selected ? 2 : 1.5,
          strokeDasharray: alive ? '5 5' : status === 'down' ? '2 4' : undefined,
          animation: alive ? 'dashflow 1s linear infinite' : undefined,
        }}
      />
      {/* packets travelling along the link */}
      {alive && (
        <circle r={2.5} fill={kindColor}>
          <animateMotion dur="2.6s" repeatCount="indefinite" path={path} />
        </circle>
      )}
      {data?.label && (
        <EdgeLabelRenderer>
          <div
            className="edge-label nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, color: alive ? kindColor : color }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const StatusEdge = memo(StatusEdgeView);
