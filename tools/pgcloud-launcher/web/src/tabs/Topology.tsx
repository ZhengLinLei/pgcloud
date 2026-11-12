import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  ConnectionMode,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import '../components/topology.css';
import type { NodeStatus, NodeType } from '../../../shared/types';
import { del, patch, post } from '../api';
import { useStore } from '../store';
import { PgNode, type PgFlowNode } from '../components/PgNode';
import { StatusEdge, type StatusFlowEdge } from '../components/StatusEdge';
import { Inspector } from '../components/Inspector';
import { FitIcon, LinkIcon, RocketIcon, TYPE_COLOR, TYPE_LABEL, TypeIcon } from '../components/icons';

const nodeTypes = { pg: PgNode };
const edgeTypes = { status: StatusEdge };

const PALETTE: Array<{ key: string; type: NodeType; hint: string; label?: string; config?: Record<string, unknown> }> = [
  { key: 'postgres', type: 'postgres', hint: 'primary or replica' },
  { key: 'backup', type: 'postgres', label: 'Backup', hint: 'standby · no traffic · takes over', config: { backup: true } },
  { key: 'pgpool', type: 'pgpool', hint: 'load balancer · failover' },
  { key: 'pgbouncer', type: 'pgbouncer', hint: 'connection pooler' },
];

function worst(a: NodeStatus | undefined, b: NodeStatus | undefined): NodeStatus {
  const rank: Record<NodeStatus, number> = { down: 3, degraded: 2, unknown: 1, up: 0 };
  const x = a ?? 'unknown';
  const y = b ?? 'unknown';
  return rank[x] >= rank[y] ? x : y;
}

function Canvas({ goDeploy }: { goDeploy: () => void }) {
  const { nodes, edges, live, validation, toast, current } = useStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // links are controlled too: React Flow's own selection would be lost on the next render
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const removeEdge = useCallback((id: string) => {
    setSelectedEdgeId(null);
    void del(`/api/edges/${id}`);
  }, []);
  const [rfNodes, setRfNodes, onNodesChangeBase] = useNodesState<PgFlowNode>([]);
  const dragging = useRef(new Set<string>());
  const { screenToFlowPosition, fitView } = useReactFlow();
  const fitted = useRef(false);

  // issues per node for badges
  const issuesByNode = useMemo(() => {
    const map: Record<string, number> = {};
    for (const i of validation.issues) if (i.nodeId && i.level === 'error') map[i.nodeId] = (map[i.nodeId] ?? 0) + 1;
    return map;
  }, [validation]);

  // Sync server state -> flow nodes (keep positions of nodes being dragged)
  useEffect(() => {
    setRfNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      return nodes.map((n) => {
        const p = prevById.get(n.id);
        return {
          id: n.id,
          type: 'pg' as const,
          position: p && dragging.current.has(n.id) ? p.position : { x: n.x, y: n.y },
          selected: n.id === selectedId,
          data: { node: n, live: live[n.id], role: validation.roles[n.id], issues: issuesByNode[n.id] ?? 0 },
        };
      });
    });
  }, [nodes, live, validation, issuesByNode, selectedId, setRfNodes]);

  // Fit once, when the nodes have been rendered and measured (fitting earlier frames nothing)
  const nodesInitialized = useNodesInitialized();
  useEffect(() => {
    if (!fitted.current && nodesInitialized && rfNodes.length) {
      fitted.current = true;
      void fitView({ padding: 0.25, duration: 300 });
    }
  }, [nodesInitialized, rfNodes.length, fitView]);

  const rfEdges: StatusFlowEdge[] = useMemo(
    () =>
      edges.map((e) => {
        const s = nodes.find((n) => n.id === e.source);
        const t = nodes.find((n) => n.id === e.target);
        let label = '';
        let kind: 'replication' | 'balance' | 'pool' = 'pool';
        if (s?.type === 'postgres') {
          kind = 'replication';
          const rep = live[e.target]?.tables?.replication?.find((r) => r.name === s.name);
          label = rep ? String(rep.sync_state) : 'wal';
        } else if (s?.type === 'pgpool') {
          kind = 'balance';
          label = (t?.config as { weight?: number })?.weight === 0 ? 'failover only' : 'balance';
        } else {
          label = 'pool';
        }
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: 'status' as const,
          // replication links run sideways between postgres nodes, on the side facing the other node
          ...(s?.type === 'postgres' && t?.type === 'postgres'
            ? s.x <= t.x
              ? { sourceHandle: 'r', targetHandle: 'l' }
              : { sourceHandle: 'ls', targetHandle: 'rt' }
            : { sourceHandle: 'b', targetHandle: 't' }),
          selected: e.id === selectedEdgeId,
          data: {
            status: worst(live[e.source]?.status, live[e.target]?.status),
            label,
            kind,
            onSelect: (id: string) => {
              setSelectedEdgeId(id);
              setSelectedId(null);
            },
            onRemove: removeEdge,
          },
        };
      }),
    [edges, nodes, live, selectedEdgeId, removeEdge],
  );

  const onEdgesChange = useCallback((changes: EdgeChange<StatusFlowEdge>[]) => {
    for (const c of changes) {
      if (c.type !== 'select') continue;
      if (c.selected) {
        setSelectedEdgeId(c.id);
        setSelectedId(null);
      } else setSelectedEdgeId((cur) => (cur === c.id ? null : cur));
    }
  }, []);

  const onNodesChange = useCallback(
    (changes: NodeChange<PgFlowNode>[]) => {
      for (const c of changes) {
        if (c.type === 'position') {
          if (c.dragging) dragging.current.add(c.id);
          else if (dragging.current.has(c.id) && c.position) {
            dragging.current.delete(c.id);
          }
        }
        if (c.type === 'select' && c.selected) {
          setSelectedId(c.id);
          setSelectedEdgeId(null);
        }
      }
      onNodesChangeBase(changes.filter((c) => c.type !== 'remove'));
    },
    [onNodesChangeBase],
  );

  const onNodeDragStop = useCallback((_: unknown, node: PgFlowNode) => {
    dragging.current.delete(node.id);
    void patch(`/api/nodes/${node.id}`, { x: Math.round(node.position.x), y: Math.round(node.position.y) });
  }, []);

  const onConnect = useCallback(
    async (c: Connection) => {
      try {
        // "source" = dependent node. Users may drag in either direction, so normalize.
        const a = nodes.find((n) => n.id === c.source);
        const b = nodes.find((n) => n.id === c.target);
        if (!a || !b) return;
        const order: Record<NodeType, number> = { pgbouncer: 0, pgpool: 1, postgres: 2 };
        let source = a;
        let target = b;
        if (order[a.type] > order[b.type]) [source, target] = [b, a];
        else if (a.type === 'postgres' && b.type === 'postgres') {
          // replica -> primary: the node that already has replicas (or was created first) is the primary
          const hasDownstream = (id: string) => edges.some((e) => e.target === id);
          if (hasDownstream(a.id) && !hasDownstream(b.id)) [source, target] = [b, a];
        }
        await post('/api/edges', { source: source.id, target: target.id });
      } catch (e) {
        toast((e as Error).message, 'error');
      }
    },
    [nodes, edges, toast],
  );

  const onEdgesDelete = useCallback((deleted: Edge[]) => {
    setSelectedEdgeId(null);
    for (const e of deleted) void del(`/api/edges/${e.id}`);
  }, []);

  const addNode = useCallback(
    async (type: NodeType, position?: { x: number; y: number }, config?: Record<string, unknown>) => {
      const pos = position ?? screenToFlowPosition({ x: window.innerWidth / 2 - 120, y: window.innerHeight / 2 - 60 });
      try {
        const n = await post<{ id: string }>('/api/nodes', { type, x: Math.round(pos.x), y: Math.round(pos.y), ...(config ? { config } : {}) });
        setSelectedId(n.id);
      } catch (e) {
        toast((e as Error).message, 'error');
      }
    },
    [screenToFlowPosition, toast],
  );

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      const p = PALETTE.find((x) => x.key === e.dataTransfer.getData('application/pgcloud-node'));
      if (!p) return;
      void addNode(p.type, screenToFlowPosition({ x: e.clientX - 118, y: e.clientY - 40 }), p.config);
    },
    [addNode, screenToFlowPosition],
  );

  const selected = nodes.find((n) => n.id === selectedId);
  const errors = validation.issues.filter((i) => i.level === 'error').length;
  const warnings = validation.issues.filter((i) => i.level === 'warning').length;

  return (
    <div className="topology">
      <div className="canvas" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        <ReactFlow<PgFlowNode, StatusFlowEdge>
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onNodeDragStop={onNodeDragStop}
          onConnect={onConnect}
          onEdgesChange={onEdgesChange}
          onEdgesDelete={onEdgesDelete}
          onEdgeClick={(_, e) => {
            setSelectedEdgeId(e.id);
            setSelectedId(null);
          }}
          onPaneClick={() => {
            setSelectedId(null);
            setSelectedEdgeId(null);
          }}
          onNodeClick={(_, n) => {
            setSelectedId(n.id);
            setSelectedEdgeId(null);
          }}
          connectionMode={ConnectionMode.Loose}
          deleteKeyCode={['Backspace', 'Delete']}
          minZoom={0.2}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          colorMode={document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'}
        >
          <Controls position="bottom-right" showInteractive={false} />
          <MiniMap
            position="top-right"
            pannable
            zoomable
            nodeColor={(n) => {
              const d = (n as PgFlowNode).data;
              const st = d.live?.status;
              return st === 'down' ? 'var(--danger)' : TYPE_COLOR[d.node.type];
            }}
            style={{ width: 160, height: 110, marginTop: 52 }}
          />
        </ReactFlow>

        <div className="panel palette">
          <div className="panel-title">Add node</div>
          <div className="panel-body">
          {PALETTE.map((p) => (
            <button
              key={p.key}
              className="palette-item"
              style={{ ['--c' as string]: TYPE_COLOR[p.type] }}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/pgcloud-node', p.key);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onClick={() => addNode(p.type, undefined, p.config)}
              title="Click or drag onto the canvas"
            >
              <span className="pg-node-icon">
                <TypeIcon type={p.type} size={13} />
              </span>
              <span>
                {p.label ?? TYPE_LABEL[p.type]}
                <small>{p.hint}</small>
              </span>
            </button>
          ))}
          <div className="faint" style={{ fontSize: 10, paddingTop: 4 }}>
            Drag between handles to connect · select a link + ⌫ to remove it
          </div>
          </div>
        </div>

        <div className="panel toolbar">
          <button className="btn sm ghost" onClick={() => post('/api/autolink').then((r) => toast(`${(r as { created: number }).created} links created`, 'ok'))}>
            <LinkIcon /> Auto-link
          </button>
          <button className="btn sm ghost" onClick={() => fitView({ padding: 0.25, duration: 400 })}>
            <FitIcon /> Fit
          </button>
          <span className="sep" />
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, padding: '0 4px' }} className={errors ? 'err' : warnings ? 'warn' : 'ok'}>
            {errors ? `${errors} ERROR${errors > 1 ? 'S' : ''}` : warnings ? `${warnings} WARNING${warnings > 1 ? 'S' : ''}` : 'TOPOLOGY VALID'}
          </span>
          {validation.issues.some((i) => i.code === 'roles') && (
            <button
              className="btn sm"
              onClick={() =>
                post<{ primary: string }>('/api/adopt-live-roles')
                  .then((r) => toast(`Topology updated: ${r.primary} is the primary`, 'ok'))
                  .catch((e) => toast((e as Error).message, 'error'))
              }
            >
              Adopt live roles
            </button>
          )}
          <button className="btn sm primary" disabled={!validation.ok || !!current} onClick={goDeploy}>
            <RocketIcon /> Deploy
          </button>
        </div>

        <div className="panel legend">
          <div>
            <i style={{ borderColor: 'var(--accent)', borderTopStyle: 'dashed' }} /> link up · live traffic
          </div>
          <div>
            <i style={{ borderColor: 'var(--danger)', borderTopStyle: 'dotted' }} /> a side is down
          </div>
          <div>
            <i style={{ borderColor: 'var(--border-strong)' }} /> not deployed
          </div>
        </div>

        {nodes.length === 0 && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
            <div className="panel" style={{ maxWidth: 440, pointerEvents: 'auto' }}>
              <div className="panel-title">Empty topology</div>
              <div className="panel-body">
              <p className="muted" style={{ marginTop: 0 }}>
                Add a PostgreSQL primary, its replicas, a Pgpool-II and a PgBouncer. Set SSH access for each server and press Deploy.
              </p>
              <button
                className="btn primary"
                onClick={async () => {
                  const center = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
                  const mk = (type: NodeType, dx: number, dy: number) =>
                    post('/api/nodes', { type, x: Math.round(center.x + dx), y: Math.round(center.y + dy) });
                  await mk('pgbouncer', -118, -360);
                  await mk('pgpool', -118, -170);
                  await mk('postgres', -118, 40); // created first -> becomes the primary on auto-link
                  await mk('postgres', -460, 40);
                  await mk('postgres', 224, 40);
                  await post('/api/autolink');
                  window.setTimeout(() => fitView({ padding: 0.25, duration: 500 }), 300);
                }}
              >
                Load 3-tier template
              </button>
              </div>
            </div>
          </div>
        )}
      </div>
      {selected && (
        <Inspector
          key={selected.id}
          node={selected}
          role={validation.roles[selected.id]}
          issues={validation.issues.filter((i) => i.nodeId === selected.id)}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

export function TopologyTab({ goDeploy }: { goDeploy: () => void }) {
  return (
    <ReactFlowProvider>
      <Canvas goDeploy={goDeploy} />
    </ReactFlowProvider>
  );
}
