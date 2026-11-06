import { useMemo, useState } from 'react';
import { useStore } from '../store';

const LEVELS = ['all', 'error', 'warn', 'success', 'info'] as const;
const COLOR: Record<string, string> = { error: 'err', warn: 'warn', success: 'ok', info: 'muted' };
const GLYPH: Record<string, string> = { error: '✖', warn: '▲', success: '✔', info: '•' };

export function EventsTab() {
  const { events, nodes } = useStore();
  const [level, setLevel] = useState<(typeof LEVELS)[number]>('all');
  const [query, setQuery] = useState('');
  const names = useMemo(() => Object.fromEntries(nodes.map((n) => [n.id, n.name])), [nodes]);
  const shown = events.filter(
    (e) => (level === 'all' || e.level === level) && (!query || e.message.toLowerCase().includes(query.toLowerCase())),
  );
  return (
    <div className="page">
      <div className="panel">
        <div className="panel-title" style={{ flexWrap: 'wrap' }}>
          Event stream
          <span className="grow" />
          <input className="input" style={{ width: 220, height: 28 }} placeholder="filter…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="segmented">
            {LEVELS.map((l) => (
              <button key={l} className={level === l ? 'on' : ''} onClick={() => setLevel(l)}>
                {l}
              </button>
            ))}
          </div>
        </div>
        <div style={{ padding: '6px 0' }}>
          {shown.length === 0 && <div className="empty">No events.</div>}
          {shown.map((e) => (
            <div key={e.id} className="event-row">
              <span className="faint mono-num">{new Date(e.ts).toLocaleString()}</span>
              <span className={COLOR[e.level]}>{GLYPH[e.level]}</span>
              <span className="event-node">{e.nodeId ? names[e.nodeId] ?? 'deleted' : 'cluster'}</span>
              <span>{e.message}</span>
            </div>
          ))}
        </div>
      </div>
      <style>{`
        .event-row { display: grid; grid-template-columns: 170px 18px 110px 1fr; gap: 10px; padding: 7px 16px; font-size: 12px; border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent); }
        .event-row:hover { background: var(--accent-soft); }
        .event-node { color: var(--cyan); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        @media (max-width: 700px) { .event-row { grid-template-columns: 18px 1fr; } .event-row > span:first-child, .event-node { display: none; } }
      `}</style>
    </div>
  );
}
