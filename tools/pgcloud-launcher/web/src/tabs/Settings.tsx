import { useEffect, useState } from 'react';
import { HUB_IMAGES, LOCAL_IMAGES } from '../../../shared/types';
import type { ImageSource, NodeType, OldPrimaryPolicy, RuntimeChoice, SettingsView } from '../../../shared/types';
import { api, del, formatBytes, post, put } from '../api';
import { useStore } from '../store';
import { EyeIcon, TrashIcon, TYPE_LABEL, UploadIcon } from '../components/icons';

function SecretField({
  label,
  name,
  has,
  value,
  onChange,
}: {
  label: string;
  name: string;
  has: boolean;
  value: string;
  onChange: (v: string) => void;
}) {
  const [revealed, setRevealed] = useState<string | null>(null);
  return (
    <label className="field">
      <span>{label}</span>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          placeholder={has ? '•••••••• stored (type to change)' : 'not set'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="btn icon"
          title="Reveal current value"
          disabled={!has}
          onClick={async () => setRevealed(revealed ? null : (await api<{ value: string }>(`/api/settings/secret/${name}`)).value)}
        >
          <EyeIcon />
        </button>
      </div>
      {revealed && (
        <small style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <code className="ok" style={{ userSelect: 'all' }}>
            {revealed}
          </code>
          <button type="button" className="btn sm ghost" onClick={() => navigator.clipboard?.writeText(revealed)}>
            copy
          </button>
        </small>
      )}
    </label>
  );
}

export function SettingsTab() {
  const { settings, nodes, toast } = useStore();
  const [s, setS] = useState<SettingsView | null>(settings ?? null);
  const [secrets, setSecrets] = useState({ password: '', replicaPassword: '', pcpPassword: '' });
  const [upload, setUpload] = useState<{ name: string; pct: number } | null>(null);
  const [images, setImages] = useState<Array<{ name: string; size: number | null }>>([]);
  const [pw, setPw] = useState({ current: '', next: '' });
  const [envPassword, setEnvPassword] = useState(false);

  useEffect(() => {
    if (settings) setS(settings);
  }, [settings]);
  useEffect(() => {
    void api<Array<{ name: string; size: number | null }>>('/api/images').then(setImages);
    void api<{ passwordFromEnv: boolean }>('/api/session').then((r) => setEnvPassword(r.passwordFromEnv));
  }, [settings?.images.tarballs.length]);

  if (!s) return <div className="page muted">Loading…</div>;

  const save = async () => {
    try {
      await put('/api/settings', {
        cluster: { ...s.cluster, ...secrets },
        images: { source: s.images.source, registry: s.images.registry, tag: s.images.tag, names: s.images.names },
        runtime: s.runtime,
        remoteDir: s.remoteDir,
        monitorIntervalSec: s.monitorIntervalSec,
        oldPrimary: s.oldPrimary,
        autoHeal: s.autoHeal,
      });
      setSecrets({ password: '', replicaPassword: '', pcpPassword: '' });
      toast('Settings saved. Redeploy nodes to apply cluster changes.', 'ok');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const uploadFile = (file: File) => {
    if (import.meta.env.MODE === 'demo') {
      toast('Not available in the demo: this page only illustrates the launcher.', 'error');
      return;
    }
    const fd = new FormData();
    fd.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/images/upload');
    xhr.upload.onprogress = (e) => e.lengthComputable && setUpload({ name: file.name, pct: Math.round((e.loaded / e.total) * 100) });
    xhr.onload = () => {
      setUpload(null);
      if (xhr.status >= 300) toast(JSON.parse(xhr.responseText || '{}').error ?? 'Upload failed', 'error');
      else toast(`${file.name} uploaded`, 'ok');
    };
    xhr.onerror = () => {
      setUpload(null);
      toast('Upload failed', 'error');
    };
    setUpload({ name: file.name, pct: 0 });
    xhr.send(fd);
  };

  const c = s.cluster;
  const set = (patch: Partial<SettingsView>) => setS({ ...s, ...patch });
  const setCluster = (patch: Partial<SettingsView['cluster']>) => setS({ ...s, cluster: { ...c, ...patch } });
  const setImages_ = (patch: Partial<SettingsView['images']>) => setS({ ...s, images: { ...s.images, ...patch } });
  const sameNames = (a: Record<NodeType, string>, b: Record<NodeType, string>) =>
    (Object.keys(b) as NodeType[]).every((t) => a[t] === b[t]);
  // Switching to/from the registry source swaps the default names and tag (custom values are kept).
  const setSource = (source: ImageSource) => {
    const cur = s.images;
    const patch: Partial<SettingsView['images']> = { source };
    if (source === 'hub' && cur.source !== 'hub') {
      if (!cur.registry) patch.registry = HUB_IMAGES.registry;
      if (sameNames(cur.names, LOCAL_IMAGES.names)) patch.names = { ...HUB_IMAGES.names };
      if (!cur.tag || cur.tag === LOCAL_IMAGES.tag) patch.tag = HUB_IMAGES.tag;
    } else if (source !== 'hub' && cur.source === 'hub') {
      if (sameNames(cur.names, HUB_IMAGES.names)) patch.names = { ...LOCAL_IMAGES.names };
      if (cur.tag === HUB_IMAGES.tag) patch.tag = LOCAL_IMAGES.tag;
    }
    setImages_(patch);
  };
  const entry = nodes.find((n) => n.type === 'pgbouncer') ?? nodes.find((n) => n.type === 'pgpool') ?? nodes.find((n) => n.type === 'postgres');

  return (
    <div className="page">
      <div className="settings-grid">
        <section className="panel">
          <div className="panel-title">Cluster credentials</div>
          <div className="panel-body">
            <div className="row">
              <label className="field">
                <span>Database</span>
                <input className="input" value={c.database} onChange={(e) => setCluster({ database: e.target.value })} />
              </label>
              <label className="field">
                <span>Superuser</span>
                <input className="input" value={c.user} onChange={(e) => setCluster({ user: e.target.value })} />
              </label>
            </div>
            <SecretField label="Superuser password" name="password" has={c.hasPassword} value={secrets.password} onChange={(v) => setSecrets({ ...secrets, password: v })} />
            <div className="row">
              <label className="field">
                <span>Replication user</span>
                <input className="input" value={c.replicaUser} onChange={(e) => setCluster({ replicaUser: e.target.value })} />
              </label>
              <label className="field">
                <span>PCP user</span>
                <input className="input" value={c.pcpUser} onChange={(e) => setCluster({ pcpUser: e.target.value })} />
              </label>
            </div>
            <SecretField label="Replication password" name="replicaPassword" has={c.hasReplicaPassword} value={secrets.replicaPassword} onChange={(v) => setSecrets({ ...secrets, replicaPassword: v })} />
            <SecretField label="PCP password" name="pcpPassword" has={c.hasPcpPassword} value={secrets.pcpPassword} onChange={(v) => setSecrets({ ...secrets, pcpPassword: v })} />
            <label className="field">
              <span>Allowed networks (CIDR)</span>
              <input className="input" value={c.allowedCidrs} onChange={(e) => setCluster({ allowedCidrs: e.target.value })} />
              <small>Comma separated. Must include the launcher and every node. Avoid 0.0.0.0/0.</small>
            </label>
            <p className="faint" style={{ fontSize: 11, margin: 0 }}>
              Random strong passwords were generated on first start. Changing them only affects new clusters: PostgreSQL keeps the password it was initialized with.
            </p>
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">PgCloud images</div>
          <div className="panel-body">
            <div className="field">
              <span>Source</span>
              <div className="segmented">
                {(
                  [
                    ['build', 'build'],
                    ['hub', 'registry'],
                    ['tarball', 'tar.gz'],
                    ['local', 'on hosts'],
                  ] as Array<[ImageSource, string]>
                ).map(([k, label]) => (
                  <button key={k} className={s.images.source === k ? 'on' : ''} onClick={() => setSource(k)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {s.images.source === 'hub' && (
              <label className="field">
                <span>Registry / namespace</span>
                <input className="input" placeholder={HUB_IMAGES.registry} value={s.images.registry} onChange={(e) => setImages_({ registry: e.target.value })} />
                <small>
                  Prefixed to each image name. Default: the official images on <a href="https://hub.docker.com/u/zhenglinlei" target="_blank" rel="noreferrer">Docker Hub</a>.{' '}
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => setImages_({ registry: HUB_IMAGES.registry, names: { ...HUB_IMAGES.names }, tag: HUB_IMAGES.tag })}
                  >
                    Use official images
                  </button>
                </small>
              </label>
            )}
            <div className="row">
              {(['postgres', 'pgpool', 'pgbouncer'] as NodeType[]).map((t) => (
                <label className="field" key={t}>
                  <span>{TYPE_LABEL[t]} image</span>
                  <input className="input" value={s.images.names[t]} onChange={(e) => setImages_({ names: { ...s.images.names, [t]: e.target.value } })} />
                </label>
              ))}
              <label className="field">
                <span>Tag</span>
                <input className="input" value={s.images.tag} onChange={(e) => setImages_({ tag: e.target.value })} />
              </label>
            </div>
            {s.images.source === 'build' && (
              <p className="muted" style={{ fontSize: 11.5 }}>
                The launcher ships the PgCloud sources. On deploy it copies them to each server over SFTP and runs <code>docker build</code> /{' '}
                <code>podman build</code> there. Images are labelled with a hash of their sources and rebuilt only when the sources change. The first
                build takes a few minutes (PgBouncer is compiled) and the servers need Internet access to download packages.
              </p>
            )}
            {s.images.source === 'local' && (
              <p className="muted" style={{ fontSize: 11.5 }}>
                The images must already exist on every host (for example built with <code>docker/&lt;service&gt;/BUILD.sh</code> and tagged with the names above).
              </p>
            )}
            {s.images.source === 'tarball' && (
              <div>
                <div className="terminal" style={{ fontSize: 11, marginBottom: 10 }}>
                  <span className="l-out"># build once, then upload the archive</span>
                  {'\n'}docker compose build{'\n'}docker save pgcloud/db:dev pgcloud/pgpool:dev pgcloud/pgbouncer:dev | gzip &gt; pgcloud-images.tar.gz
                </div>
                <label className="btn" style={{ cursor: upload ? 'wait' : 'pointer' }}>
                  <UploadIcon /> {upload ? `Uploading ${upload.name} ${upload.pct}%` : 'Upload .tar / .tar.gz'}
                  <input type="file" accept=".tar,.gz,.tgz" hidden disabled={!!upload} onChange={(e) => e.target.files?.[0] && uploadFile(e.target.files[0])} />
                </label>
                <div style={{ marginTop: 10 }}>
                  {images.map((img) => (
                    <div key={img.name} className="history-item" style={{ cursor: 'default' }}>
                      <span className="ok">▣</span>
                      <span style={{ flex: 1 }}>{img.name}</span>
                      <span className="faint">{formatBytes(img.size)}</span>
                      <button className="btn sm danger" onClick={() => del(`/api/images/${encodeURIComponent(img.name)}`)}>
                        <TrashIcon />
                      </button>
                    </div>
                  ))}
                  {images.length === 0 && <div className="faint">No archives uploaded.</div>}
                </div>
                <p className="faint" style={{ fontSize: 11 }}>
                  Image names and tag above must match the archive (for the commands above: tag <b>dev</b>). Archives are copied over SFTP to each host once and
                  loaded only when the image is missing.
                </p>
              </div>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">Hosts</div>
          <div className="panel-body">
            <div className="field">
              <span>Container runtime</span>
              <div className="segmented">
                {(['auto', 'docker', 'podman'] as RuntimeChoice[]).map((r) => (
                  <button key={r} className={s.runtime === r ? 'on' : ''} onClick={() => set({ runtime: r })}>
                    {r}
                  </button>
                ))}
              </div>
              <small>auto = Docker if available, otherwise Podman (detected on each host)</small>
            </div>
            <label className="field">
              <span>Remote directory</span>
              <input className="input" value={s.remoteDir} onChange={(e) => set({ remoteDir: e.target.value })} />
              <small>Each node writes its config to &lt;dir&gt;/&lt;node name&gt; (mode 700)</small>
            </label>
            <div className="field">
              <span>Old primary that comes back after a failover</span>
              <div className="segmented">
                {(
                  [
                    ['rejoin', 'rejoin automatically'],
                    ['wait', 'wait for me'],
                  ] as Array<[OldPrimaryPolicy, string]>
                ).map(([k, label]) => (
                  <button key={k} className={s.oldPrimary === k ? 'on' : ''} onClick={() => set({ oldPrimary: k })}>
                    {label}
                  </button>
                ))}
              </div>
              <small>
                rejoin = it becomes a replica of the current primary (pg_rewind, or a fresh copy if that fails). wait = it does not start
                (never a second primary); you choose Rejoin or Rebuild in its inspector. Redeploy the PostgreSQL nodes to apply.
              </small>
            </div>
            <label className="check" style={{ alignItems: 'flex-start', marginTop: 4 }}>
              <input type="checkbox" style={{ marginTop: 3, flex: '0 0 auto' }} checked={s.autoHeal !== false} onChange={(e) => set({ autoHeal: e.target.checked })} />
              <span>
                Auto-heal: after an outage, rejoin old primaries (with "rejoin automatically") and re-attach healthy nodes that
                Pgpool-II keeps detached
              </span>
            </label>
            <label className="field">
              <span>Monitoring interval (s)</span>
              <input className="input" type="number" min={1} max={60} value={s.monitorIntervalSec} onChange={(e) => set({ monitorIntervalSec: Number(e.target.value) })} />
            </label>
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">Connect your application</div>
          <div className="panel-body">
            {entry ? (
              <>
                <p className="muted" style={{ marginTop: 0, fontSize: 11.5 }}>
                  Entry point: <b className="ok">{entry.name}</b> ({TYPE_LABEL[entry.type]})
                </p>
                <div className="terminal" style={{ fontSize: 11.5 }}>
                  postgresql://{c.user}:&lt;password&gt;@{entry.address}:{String((entry.config as { port: number }).port)}/{c.database}
                </div>
              </>
            ) : (
              <div className="faint">Add nodes to see the connection string.</div>
            )}
            <div className="hr" />
            <div className="label" style={{ marginBottom: 10 }}>
              Launcher admin password
            </div>
            {envPassword ? (
              <p className="faint" style={{ fontSize: 11.5, margin: 0 }}>
                Set by the LAUNCHER_ADMIN_PASSWORD environment variable.
              </p>
            ) : (
              <>
                <div className="row">
                  <input className="input" type="password" placeholder="current" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
                  <input className="input" type="password" placeholder="new (10+ chars)" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
                </div>
                <button
                  className="btn"
                  style={{ marginTop: 10 }}
                  disabled={!pw.current || pw.next.length < 10}
                  onClick={() =>
                    post('/api/admin/password', pw)
                      .then(() => {
                        toast('Password changed, please log in again', 'ok');
                        window.dispatchEvent(new CustomEvent('pgl:unauthorized'));
                      })
                      .catch((e) => toast((e as Error).message, 'error'))
                  }
                >
                  Change password
                </button>
              </>
            )}
          </div>
        </section>
      </div>
      <div className="settings-save panel">
        <span className="muted">Changes apply to the next deployment.</span>
        <button className="btn primary" onClick={save}>
          Save settings
        </button>
      </div>
      <style>{`
        .settings-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 16px; padding-bottom: 80px; }
        .settings-save { position: sticky; bottom: 0; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; }
        @media (max-width: 520px) { .settings-grid { grid-template-columns: 1fr; } }
      `}</style>
    </div>
  );
}
