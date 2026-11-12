import { useEffect, useMemo, useRef, useState } from 'react';
import type { AccessReport, AccessSolution } from '../../../shared/types';
import { api, post } from '../api';
import { useStore } from '../store';
import { FastSwapModal } from './FastSwap';
import { Confirm, useNow } from './ui';

/** Seconds without any reachable entry point before the alert shows (avoids flicker during planned work). */
const GRACE_MS = 6000;

/**
 * Bottom-right alert: no entry point (PgBouncer, else Pgpool-II, else the primary) accepts connections.
 * It explains why, layer by layer, and offers the ways out the launcher knows.
 */
export function AccessAlert() {
  const { nodes, live, current, toast, loaded } = useStore();
  const now = useNow();
  const since = useRef<number | null>(null);
  const [report, setReport] = useState<AccessReport | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [dialog, setDialog] = useState<null | 'fastswap' | 'rebuild' | AccessSolution>(null);

  // entry points, as the launcher defines them
  const entries = useMemo(() => {
    const deployed = nodes.filter((n) => n.deployedAt);
    const b = deployed.filter((n) => n.type === 'pgbouncer');
    if (b.length) return b;
    const p = deployed.filter((n) => n.type === 'pgpool');
    if (p.length) return p;
    return deployed.filter((n) => n.type === 'postgres' && live[n.id]?.role === 'primary');
  }, [nodes, live]);
  const anyDeployed = nodes.some((n) => n.deployedAt);
  const reachable = entries.some((n) => live[n.id]?.status === 'up');
  const known = entries.some((n) => live[n.id] && live[n.id].status !== 'unknown') || (anyDeployed && entries.length === 0);
  const inaccessible = loaded && anyDeployed && known && !reachable;

  if (inaccessible && since.current === null) since.current = Date.now();
  if (!inaccessible) since.current = null;
  const show = inaccessible && since.current !== null && now - since.current >= GRACE_MS;

  useEffect(() => {
    if (!show) {
      setReport(null);
      setMinimized(false);
      return;
    }
    let alive = true;
    const load = () =>
      api<AccessReport>('/api/access')
        .then((r) => alive && setReport(r))
        .catch(() => undefined);
    void load();
    const t = window.setInterval(load, 5000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [show]);

  if (!show) return null;
  const secs = since.current ? Math.round((now - since.current) / 1000) : 0;
  const duration = secs < 120 ? `${secs} s` : `${Math.round(secs / 60)} min`;

  const apply = async (s: AccessSolution) => {
    if (s.ui) return setDialog(s.ui);
    if (s.action?.confirm) return setDialog(s);
    await run(s);
  };
  const run = async (s: AccessSolution) => {
    if (!s.action) return;
    try {
      await post(s.action.path, s.action.body ?? {});
      toast(`${s.title}: started — follow it in the Deploy tab`, 'info');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <>
      <style>{'.toasts{right:auto;left:12px;}.access-head{display:flex;align-items:center;gap:8px;}.access-head .grow{flex:1 1 auto;}.access-head .btn.icon.ghost{margin-left:auto;}'}</style>
      <div className={`access-alert ${minimized ? 'min' : ''}`} role="alert">
        <div className="access-head" onClick={() => setMinimized(!minimized)}>
          <span className="access-dot" />
          <b>SYSTEM NOT ACCESSIBLE</b>
          <span className="grow" />
          <span className="faint">{duration}</span>
          <button className="btn icon ghost" aria-label={minimized ? 'Expand' : 'Minimize'}>
            {minimized ? '▴' : '▾'}
          </button>
        </div>
        {!minimized && (
          <div className="access-body">
            <p className="access-lead">
              No entry point accepts connections:{' '}
              {entries.map((n, i) => (
                <span key={n.id}>
                  {i > 0 && ', '}
                  <b>{n.name}</b> <span className="err">{live[n.id]?.status ?? 'unknown'}</span>
                </span>
              ))}
              {entries.length === 0 && <b>no primary running</b>}. Applications cannot reach the database.
            </p>
            {current && (
              <p className="warn" style={{ margin: '0 0 8px' }}>
                Operation running: {current.action} {current.target}. It may be the cause; wait for it to finish.
              </p>
            )}
            {report === null ? (
              <p className="faint">Diagnosing…</p>
            ) : (
              <>
                {report.causes.length > 0 && (
                  <>
                    <div className="label">Why</div>
                    <ul className="access-causes">
                      {report.causes.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                  </>
                )}
                <div className="label">What you can do</div>
                <div className="access-solutions">
                  {report.solutions.map((s) => (
                    <div key={s.key} className={`access-solution ${s.kind}`}>
                      <div className="grow">
                        <div className="t">
                          {s.kind === 'auto' && <span className="badge ok">AUTO</span>} {s.title}
                        </div>
                        <div className="d">{s.detail}</div>
                      </div>
                      {(s.action || s.ui) && (
                        <button className={`btn sm ${s.kind === 'danger' ? 'danger' : 'primary'}`} disabled={!!current} onClick={() => apply(s)}>
                          {s.kind === 'danger' ? 'Open' : 'Apply'}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
      {dialog === 'fastswap' && <FastSwapModal onClose={() => setDialog(null)} />}
      {dialog === 'rebuild' && (
        <Confirm
          title="Destroy & rebuild cluster"
          message={
            <>
              Every node is destroyed: containers, <b>PostgreSQL data volumes</b> and configuration. Then the cluster is deployed from
              scratch, with an empty database. <b>This cannot be undone.</b>
            </>
          }
          confirmText="Destroy & rebuild"
          danger
          requireText="DESTROY"
          onConfirm={() => post('/api/rebuild-cluster', { confirm: 'DESTROY' }).catch((e) => toast((e as Error).message, 'error'))}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog && typeof dialog === 'object' && (
        <Confirm title={dialog.title} message={<>{dialog.action?.confirm} {dialog.detail}</>} confirmText="Apply" onConfirm={() => run(dialog)} onClose={() => setDialog(null)} />
      )}
    </>
  );
}
