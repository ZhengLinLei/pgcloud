import { useEffect, useMemo, useRef, useState } from 'react';
import type { AuditEntry, Recording } from '../../../shared/types';
import { api, del, patch } from '../api';
import { useStore } from '../store';
import { useRecordings } from '../components/Recorder';
import { TrashIcon } from '../components/icons';
import { DEMO } from '../demo/Watermark';

const SOURCES: AuditEntry['source'][] = ['event', 'operation', 'container', 'failover', 'launcher'];

/** The demo has no server: build the same .log / .json the launcher serves and save it from the browser. */
function saveInBrowser(recording: Recording, entries: AuditEntry[], format: 'log' | 'json') {
  const text =
    format === 'json'
      ? JSON.stringify({ recording, entries }, null, 2)
      : [
          `# PgCloud audit recording: ${recording.name}`,
          `# from ${recording.startedAt} to ${recording.endedAt ?? '-'} · ${entries.length} entries`,
          '# timestamp (UTC)            level  source     node        message',
          ...entries.map((e) => `${e.ts.padEnd(27)} ${e.level.toUpperCase().padEnd(6)} ${e.source.padEnd(10)} ${(e.node ?? '-').padEnd(11)} ${e.text}`),
        ].join('\n') + '\n';
  const url = URL.createObjectURL(new Blob([text], { type: format === 'json' ? 'application/json' : 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `pgcloud-audit-${recording.startedAt.slice(0, 19).replace(/[:T]/g, '-')}.${format}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function AuditTab() {
  const { toast } = useStore();
  const { recordings, reload } = useRecordings();
  const [selected, setSelected] = useState<string | null>(null);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState<'all' | 'warn' | 'error'>('all');
  const [sources, setSources] = useState<Set<string>>(new Set(SOURCES));
  const [node, setNode] = useState('all');

  const shown = recordings.find((r) => r.id === selected) ?? recordings.find((r) => r.status === 'ready');
  const [renaming, setRenaming] = useState<string | null>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const editing = renaming !== null;
  useEffect(() => setRenaming(null), [shown?.id]);
  // the whole name is selected when the field opens: typing replaces it
  useEffect(() => {
    if (editing) renameInput.current?.select();
  }, [editing]);
  const rename = async () => {
    if (!shown || renaming === null) return;
    if (!renaming.trim() || renaming.trim() === shown.name) return setRenaming(null);
    try {
      await patch(`/api/recordings/${shown.id}`, { name: renaming });
      setRenaming(null);
      reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  useEffect(() => {
    if (!shown || shown.status !== 'ready') return setEntries([]);
    void api<{ recording: Recording; entries: AuditEntry[] }>(`/api/recordings/${shown.id}`)
      .then((r) => setEntries(r.entries))
      .catch((e) => toast((e as Error).message, 'error'));
  }, [shown?.id, shown?.status, toast]);

  const nodes = useMemo(() => [...new Set(entries.map((e) => e.node).filter(Boolean))] as string[], [entries]);
  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return entries.filter(
      (e) =>
        sources.has(e.source) &&
        (level === 'all' || (level === 'error' ? e.level === 'error' : e.level !== 'info')) &&
        (node === 'all' || e.node === node) &&
        (!q || e.text.toLowerCase().includes(q)),
    );
  }, [entries, query, level, sources, node]);
  const counts = useMemo(() => ({ error: entries.filter((e) => e.level === 'error').length, warn: entries.filter((e) => e.level === 'warn').length }), [entries]);

  return (
    <div className="audit">
      <div className="panel audit-list">
        <div className="panel-title">Recordings</div>
        <div className="history">
          {recordings.map((r) => (
            <button key={r.id} className={`history-item ${r.id === shown?.id ? 'on' : ''}`} onClick={() => setSelected(r.id)}>
              <span className={`dot ${r.status === 'ready' ? 'up' : r.status === 'failed' ? 'down' : 'degraded'}`} />
              <span style={{ flex: 1, textAlign: 'left' }}>
                <b>{r.name}</b>
                <br />
                <span className="faint">
                  {new Date(r.startedAt).toLocaleString()} · {r.status === 'ready' ? `${r.entries} entries` : r.status}
                </span>
              </span>
            </button>
          ))}
          {recordings.length === 0 && (
            <div className="faint" style={{ padding: 14 }}>
              No recordings yet. Press <b>REC</b> in the top bar, reproduce what you want to audit, and press it again.
            </div>
          )}
        </div>
      </div>

      <div className="panel audit-view">
        <div className="panel-title">
          {shown && renaming !== null ? (
            <span className="audit-rename">
              <input
                className="input"
                autoFocus
                maxLength={120}
                value={renaming}
                aria-label="Name of the recording"
                ref={renameInput}
                onChange={(e) => setRenaming(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void rename();
                  if (e.key === 'Escape') setRenaming(null);
                }}
              />
              <button className="btn sm primary" onClick={() => void rename()}>
                Save
              </button>
              <button className="btn sm ghost" onClick={() => setRenaming(null)}>
                Cancel
              </button>
            </span>
          ) : (
            <>
              {shown ? shown.name : 'Timeline'}
              {shown && (
                <button className="btn sm ghost" title="Rename the recording" onClick={() => setRenaming(shown.name)}>
                  Rename
                </button>
              )}
            </>
          )}
          <span className="grow" />
          {shown?.status === 'ready' && (
            <>
              <a
                className="btn sm"
                href={`/api/recordings/${shown.id}/download?format=log`}
                onClick={(e) => {
                  if (!DEMO) return;
                  e.preventDefault();
                  saveInBrowser(shown, entries, 'log');
                }}
              >
                ⬇ .log
              </a>
              <a
                className="btn sm"
                href={`/api/recordings/${shown.id}/download?format=json`}
                onClick={(e) => {
                  if (!DEMO) return;
                  e.preventDefault();
                  saveInBrowser(shown, entries, 'json');
                }}
              >
                ⬇ .json
              </a>
            </>
          )}
          {shown && shown.status !== 'recording' && shown.status !== 'collecting' && (
            <button
              className="btn sm danger"
              onClick={() =>
                del(`/api/recordings/${shown.id}`)
                  .then(() => {
                    setSelected(null);
                    reload();
                  })
                  .catch((e) => toast((e as Error).message, 'error'))
              }
            >
              <TrashIcon />
            </button>
          )}
        </div>
        {shown?.status === 'ready' ? (
          <>
            <div className="audit-filters">
              <input className="input" placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} />
              <div className="segmented">
                {(['all', 'warn', 'error'] as const).map((l) => (
                  <button key={l} className={level === l ? 'on' : ''} onClick={() => setLevel(l)}>
                    {l === 'all' ? 'all' : l === 'warn' ? `warn+ (${counts.warn + counts.error})` : `errors (${counts.error})`}
                  </button>
                ))}
              </div>
              <select className="input" value={node} onChange={(e) => setNode(e.target.value)} style={{ maxWidth: 140 }}>
                <option value="all">all nodes</option>
                {nodes.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              {SOURCES.map((s) => (
                <label key={s} className="check">
                  <input
                    type="checkbox"
                    checked={sources.has(s)}
                    onChange={(e) => {
                      const next = new Set(sources);
                      if (e.target.checked) next.add(s);
                      else next.delete(s);
                      setSources(next);
                    }}
                  />
                  <span>{s}</span>
                </label>
              ))}
              <span className="faint">
                {filtered.length} / {entries.length}
              </span>
            </div>
            <div className="audit-lines">
              {filtered.slice(0, 5000).map((e, i) => (
                <div key={i} className={`audit-line ${e.level}`}>
                  <span className="ts">{e.ts.replace('T', ' ').slice(0, 23)}</span>
                  <span className={`src src-${e.source}`}>{e.source}</span>
                  <span className="nd">{e.node ?? '—'}</span>
                  <span className="tx">{e.text}</span>
                </div>
              ))}
              {filtered.length > 5000 && <div className="faint">… {filtered.length - 5000} more: download the file to see everything.</div>}
            </div>
          </>
        ) : (
          <div className="faint" style={{ padding: 14 }}>
            {shown?.status === 'recording'
              ? 'Recording… press REC in the top bar to stop it.'
              : shown?.status === 'collecting'
                ? 'Collecting the logs of every node…'
                : shown?.status === 'failed'
                  ? `Collection failed: ${shown.error ?? ''}`
                  : 'Select a recording.'}
          </div>
        )}
      </div>
    </div>
  );
}
