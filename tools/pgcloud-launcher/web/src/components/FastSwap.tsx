import { useEffect, useState } from 'react';
import { api, post } from '../api';
import { useStore } from '../store';
import { Modal } from './ui';

interface Plan {
  risk: { atRisk: boolean; reason: string };
  source: { id: string; name: string; address: string; role: string; timeline: number; lsn: string } | null;
  method: string;
}

/** Red banner shown on every tab while the cluster is about to lose its data, with the fast-swap action. */
export function CollapseBanner() {
  const { validation, current } = useStore();
  const [open, setOpen] = useState(false);
  const risk = validation.issues.find((i) => i.code === 'collapse-risk');
  if (!risk && !open) return null;
  return (
    <>
      {risk && (
        <div className="collapse-banner" role="alert">
          <span className="collapse-icon">⚠</span>
          <span className="grow">
            <b>CLUSTER AT RISK</b> — {risk.message.replace(/^Cluster at risk: /, '')}
          </span>
          <button className="btn danger" disabled={!!current} onClick={() => setOpen(true)}>
            Fast-swap
          </button>
        </div>
      )}
      {open && <FastSwapModal onClose={() => setOpen(false)} />}
    </>
  );
}

export function FastSwapModal({ onClose }: { onClose: () => void }) {
  const { toast } = useStore();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(22);
  const [user, setUser] = useState('root');
  const [auth, setAuth] = useState<'password' | 'key'>('password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [sudo, setSudo] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Plan>('/api/fast-swap/plan')
      .then(setPlan)
      .catch((e) => setError((e as Error).message));
  }, []);

  const start = async () => {
    setBusy(true);
    try {
      await post('/api/fast-swap', { name, ssh: { host, port, user, auth, sudo, password, privateKey } });
      toast('Fast-swap started — follow it in the Deploy tab', 'info');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Fast-swap: emergency copy of the data" onClose={onClose}>
      <div style={{ maxWidth: 620 }}>
        {error && <p className="err">{error}</p>}
        {plan?.source ? (
          <div className="fastswap-source">
            <div className="label">Freshest data</div>
            <div>
              <b>{plan.source.name}</b> ({plan.source.address}) · {plan.source.role} · timeline {plan.source.timeline} · WAL {plan.source.lsn}
            </div>
          </div>
        ) : (
          !error && <p className="faint">Looking for the node with the freshest data…</p>
        )}
        <p className="faint">
          A new server receives a copy with <b>pg_basebackup over streaming replication</b>: consistent while the source keeps running,
          only the database files travel, and the new node keeps streaming afterwards, so nothing written during the copy is lost (an
          <code> scp</code> of a running data directory would be inconsistent). It is created as a top-priority backup node, so it takes
          over a failed node or becomes the primary if needed.
        </p>
        <div className="row">
          <label className="field">
            <span>Node name</span>
            <input className="input" placeholder="fastswap1" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span>Host</span>
            <input className="input" placeholder="10.0.0.20" value={host} onChange={(e) => setHost(e.target.value)} />
          </label>
          <label className="field" style={{ maxWidth: 90 }}>
            <span>Port</span>
            <input className="input" type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} />
          </label>
        </div>
        <div className="row">
          <label className="field">
            <span>User</span>
            <input className="input" value={user} onChange={(e) => setUser(e.target.value)} />
          </label>
          <div className="field">
            <span>Auth</span>
            <div className="segmented">
              {(['password', 'key'] as const).map((a) => (
                <button key={a} className={auth === a ? 'on' : ''} onClick={() => setAuth(a)}>
                  {a}
                </button>
              ))}
            </div>
          </div>
        </div>
        {auth === 'password' ? (
          <label className="field">
            <span>Password</span>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
        ) : (
          <label className="field">
            <span>Private key</span>
            <textarea className="input" rows={4} value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} />
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={sudo} onChange={(e) => setSudo(e.target.checked)} />
          <span>Use sudo for docker/podman</span>
        </label>
        <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn danger" disabled={busy || !plan?.source || !host} onClick={start}>
            Start fast-swap
          </button>
        </div>
      </div>
    </Modal>
  );
}
