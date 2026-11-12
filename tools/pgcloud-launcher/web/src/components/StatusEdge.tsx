import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react';
import type { NodeStatus } from '../../../shared/types';

export type StatusEdgeData = {
  status: NodeStatus;
  label: string;
  kind: 'replication' | 'balance' | 'pool';
  onSelect?: (id: string) => void;
  onRemove?: (id: string) => void;
};
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
        interactionWidth={24}
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
            className={`edge-label nodrag nopan ${selected ? 'selected' : ''}`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, color: alive ? kindColor : color }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              data.onSelect?.(id);
            }}
            title="Click to select · ⌫ or ✕ to remove"
          >
            {data.label}
            {selected && (
              <button
                className="edge-remove"
                // pointerdown, not click: React Flow clears the selection on mousedown, which would
                // unmount this button before its click arrives
                onPointerDown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  data.onRemove?.(id);
                }}
                aria-label="Remove link"
              >
                ✕ remove
              </button>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const StatusEdge = memo(StatusEdgeView);
