import { useEffect, useState } from 'react';
import { post, timeAgo } from '../api';
import { useStore } from '../store';
import { RocketIcon, TYPE_COLOR, TypeIcon } from '../components/icons';
import { Confirm, RoleBadge, StatusBadge, Terminal } from '../components/ui';
import './deploy.css';

export function DeployTab() {
  const { validation, deployments, current, logs, loadLog, live, settings, toast } = useStore();
  const [selected, setSelected] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const shownId = selected ?? current?.id ?? deployments[0]?.id ?? null;
  const shown = deployments.find((d) => d.id === shownId);

  useEffect(() => {
    if (shownId && !logs[shownId]) void loadLog(shownId);
  }, [shownId, logs, loadLog]);

  // follow a new deployment automatically
  useEffect(() => {
    if (current) setSelected(null);
  }, [current?.id]);

  const errors = validation.issues.filter((i) => i.level === 'error');
  const warnings = validation.issues.filter((i) => i.level === 'warning');
  const source = settings?.images.source;

  return (
    <div className="page deploy-page">
      <div className="deploy-left">
        <div className="panel">
          <div className="panel-title">
            Pre-flight checks <span className="grow" />
            <span className={errors.length ? 'err' : 'ok'}>{errors.length ? `${errors.length} blocking` : 'ready'}</span>
          </div>
          <div className="panel-body">
            {validation.issues.length === 0 && <div className="ok">✔ Topology, credentials and settings look good.</div>}
            {[...errors, ...warnings].map((i, k) => (
              <div key={k} className={`issue ${i.level}`}>
                {i.level === 'error' ? '✖' : '▲'} <span>{i.message}</span>
              </div>
            ))}
            <div className="hr" />
            <div className="muted" style={{ fontSize: 11.5 }}>
              Images: <b className="ok">{source === 'hub' ? 'Docker Hub / registry' : source === 'tarball' ? 'tar.gz upload' : 'already on hosts'}</b> · runtime:{' '}
              <b className="ok">{settings?.runtime}</b> · remote dir: <b className="ok">{settings?.remoteDir}</b>
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">
            Execution plan <span className="grow" />
            <span className="faint">{validation.plan.length} nodes</span>
          </div>
          <div className="plan">
            {validation.plan.map((p, i) => (
              <div key={p.nodeId} className="plan-step" style={{ ['--c' as string]: TYPE_COLOR[p.type] }}>
                <span className="plan-idx">{String(i + 1).padStart(2, '0')}</span>
                <span className="pg-node-icon">
                  <TypeIcon type={p.type} size={15} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b>{p.name}</b> <RoleBadge role={p.role} />
                  <div className="faint" style={{ fontSize: 11 }}>
                    ssh → {p.host || '?'}
                  </div>
                </div>
                <StatusBadge status={live[p.nodeId]?.status} />
              </div>
            ))}
            {validation.plan.length === 0 && <div className="empty">Nothing to deploy yet.</div>}
          </div>
          <div className="panel-body" style={{ borderTop: '1px solid var(--border)' }}>
            <button className="btn primary" style={{ width: '100%', height: 40 }} disabled={!validation.ok || !!current} onClick={() => setConfirm(true)}>
              <RocketIcon size={16} /> {current ? `Running: ${current.action} ${current.target}…` : 'Deploy cluster'}
            </button>
            <p className="faint" style={{ fontSize: 11, marginBottom: 0 }}>
              Order: primary → replicas → pgpool → pgbouncer. Each node: detect Docker/Podman, prepare the image, write config, (re)create the container, wait until healthy. Data volumes are kept on redeploy.
            </p>
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">History</div>
          <div className="history">
            {deployments.map((d) => (
              <button key={d.id} className={`history-item ${d.id === shownId ? 'on' : ''}`} onClick={() => setSelected(d.id)}>
                <span className={`dot ${d.status === 'running' ? 'degraded' : d.status === 'success' ? 'up' : 'down'}`} />
                <span style={{ flex: 1, textAlign: 'left' }}>
                  {d.action} <b>{d.target}</b>
                </span>
                <span className="faint">{timeAgo(d.startedAt)}</span>
              </button>
            ))}
            {deployments.length === 0 && <div className="faint" style={{ padding: 14 }}>No operations yet.</div>}
          </div>
        </div>
      </div>

      <div className="panel deploy-console">
        <div className="panel-title">
          <span className="ok">●</span> console
          {shown && (
            <span className="muted" style={{ textTransform: 'none', letterSpacing: 0 }}>
              {shown.action} {shown.target} · {shown.status} · {new Date(shown.startedAt).toLocaleString()}
            </span>
          )}
          <span className="grow" />
          {shown && shown.status !== 'running' && (
            <button className="btn sm ghost" onClick={() => void loadLog(shown.id)}>
              reload
            </button>
          )}
        </div>
        <div className="panel-body" style={{ minHeight: 0, display: 'grid' }}>
          <Terminal lines={shownId ? logs[shownId] ?? [] : []} live={shown?.status === 'running'} height="100%" />
        </div>
      </div>

      {confirm && (
        <Confirm
          title="Deploy cluster"
          message={
            <>
              The launcher will connect to <b>{new Set(validation.plan.map((p) => p.host)).size}</b> host(s) over SSH and (re)create{' '}
              <b>{validation.plan.length}</b> containers. Running containers of these nodes are replaced; data volumes are kept.
            </>
          }
          confirmText="Deploy"
          onConfirm={() => post('/api/deploy').catch((e) => toast((e as Error).message, 'error'))}
          onClose={() => setConfirm(false)}
        />
      )}
    </div>
  );
}
