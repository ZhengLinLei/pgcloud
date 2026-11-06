import { useEffect, useState, type ReactNode } from 'react';
import type { NodeStatus } from '../../../shared/types';
import { CloseIcon } from './icons';

export function Dot({ status }: { status: NodeStatus | undefined }) {
  return <span className={`dot ${status ?? 'unknown'}`} title={status ?? 'unknown'} />;
}

export const STATUS_COLOR: Record<NodeStatus, string> = {
  up: 'var(--accent)',
  degraded: 'var(--warn)',
  down: 'var(--danger)',
  unknown: 'var(--faint)',
};

export function StatusBadge({ status }: { status: NodeStatus | undefined }) {
  const s = status ?? 'unknown';
  const label = { up: 'online', degraded: 'degraded', down: 'offline', unknown: 'not deployed' }[s];
  return (
    <span className="badge" style={{ color: STATUS_COLOR[s] }}>
      <Dot status={s} /> {label}
    </span>
  );
}

export function RoleBadge({ role }: { role: string | undefined }) {
  if (!role) return null;
  const color =
    role === 'primary' ? 'var(--accent)' : role === 'replica' ? 'var(--cyan)' : role === 'balancer' ? 'var(--pool)' : 'var(--bouncer)';
  return (
    <span className="badge" style={{ color }}>
      {role}
    </span>
  );
}

export function Modal({ title, onClose, children, actions }: { title: ReactNode; onClose: () => void; children: ReactNode; actions?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="panel modal" role="dialog" aria-modal="true">
        <div className="panel-title">
          {title}
          <span className="grow" />
          {actions}
          <button className="btn icon ghost sm" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="panel-body">{children}</div>
      </div>
    </div>
  );
}

/** Confirmation that requires typing the node name for destructive actions. */
export function Confirm({
  title,
  message,
  confirmText,
  danger,
  requireText,
  onConfirm,
  onClose,
}: {
  title: string;
  message: ReactNode;
  confirmText: string;
  danger?: boolean;
  requireText?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState('');
  return (
    <Modal title={title} onClose={onClose}>
      <div style={{ maxWidth: 560 }}>
        <div style={{ marginBottom: 16 }}>{message}</div>
        {requireText && (
          <label className="field">
            <span>
              Type <b className="err">{requireText}</b> to confirm
            </span>
            <input className="input" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
          </label>
        )}
        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className={`btn ${danger ? 'danger' : 'primary'}`}
            disabled={!!requireText && typed !== requireText}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function Sparkline({
  values,
  color = 'var(--accent)',
  height = 34,
  width = 160,
}: {
  values: Array<number | null>;
  color?: string;
  height?: number;
  width?: number;
}) {
  const pts = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null);
  if (pts.length < 2) {
    return (
      <svg width={width} height={height} className="spark">
        <line x1="0" x2={width} y1={height - 1} y2={height - 1} stroke="var(--border)" strokeDasharray="3 3" />
      </svg>
    );
  }
  const max = Math.max(...pts.map((p) => p[1]), 1e-9);
  const n = Math.max(values.length - 1, 1);
  const x = (i: number) => (i / n) * width;
  const y = (v: number) => height - 2 - (v / max) * (height - 6);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ');
  const area = `${line} L${x(pts[pts.length - 1][0]).toFixed(1)},${height} L${x(pts[0][0]).toFixed(1)},${height} Z`;
  const id = `g${Math.random().toString(36).slice(2, 8)}`;
  const last = pts[pts.length - 1];
  return (
    <svg width={width} height={height} className="spark" style={{ overflow: 'visible' }}>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.35" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.6" />
      <circle cx={x(last[0])} cy={y(last[1])} r="2.6" fill={color} />
    </svg>
  );
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function Terminal({ lines, live, height }: { lines: Array<{ line: string; level: string }>; live?: boolean; height?: number | string }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (el) el.scrollTop = el.scrollHeight;
  }, [el, lines.length]);
  return (
    <div className="terminal" ref={setEl} style={{ height }}>
      {lines.length === 0 && <span className="l-out">$ waiting for output…</span>}
      {lines.map((l, i) => (
        <div key={i} className={`l-${l.level}`}>
          {l.line}
        </div>
      ))}
      {live && <span className="cursor" />}
    </div>
  );
}
