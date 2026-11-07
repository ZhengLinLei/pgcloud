import { useEffect, useState } from 'react';
import { APP_VERSION } from '../../shared/types';
import { api, post } from './api';
import { StoreProvider, useStore } from './store';
import { Logo, LogoutIcon, MoonIcon, SunIcon } from './components/icons';
import { useNow } from './components/ui';
import { TopologyTab } from './tabs/Topology';
import { MonitorTab } from './tabs/Monitor';
import { DeployTab } from './tabs/Deploy';
import { EventsTab } from './tabs/Events';
import { SettingsTab } from './tabs/Settings';
import { DEMO, DemoWatermark } from './demo/Watermark';

type Tab = 'topology' | 'monitor' | 'deploy' | 'events' | 'settings';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'topology', label: 'Topology' },
  { id: 'monitor', label: 'Monitor' },
  { id: 'deploy', label: 'Deploy' },
  { id: 'events', label: 'Events' },
  { id: 'settings', label: 'Settings' },
];

function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? 'dark');
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('pgl-theme', next);
    } catch {
      /* ignore */
    }
    setTheme(next);
  };
  return [theme, toggle];
}

function initialTab(): Tab {
  const h = location.hash.slice(1) as Tab;
  return TABS.some((t) => t.id === h) ? h : 'topology';
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const { nodes, live, connected, validation, current, toasts, events } = useStore();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [theme, toggleTheme] = useTheme();
  const now = useNow();
  const [seenEvents, setSeenEvents] = useState(0);

  useEffect(() => {
    history.replaceState(null, '', `#${tab}`);
    if (tab === 'events') setSeenEvents(events[0]?.id ?? 0);
  }, [tab, events]);

  const statuses = nodes.map((n) => live[n.id]?.status);
  const up = statuses.filter((s) => s === 'up').length;
  const down = statuses.filter((s) => s === 'down').length;
  const unseenErrors = events.filter((e) => e.id > seenEvents && e.level === 'error').length;
  const errors = validation.issues.filter((i) => i.level === 'error').length;

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <Logo />
          <span className="brand-name">PGCLOUD</span>
          <span className="brand-name" style={{ fontWeight: 400, color: 'var(--muted)' }}>
            LAUNCHER
          </span>
          <span className={`live-pill ${connected ? 'on' : ''}`} title={connected ? 'Live connection' : 'Reconnecting…'}>
            <span className={`dot ${connected ? 'up' : 'down'}`} />
            {connected ? 'LIVE' : 'OFFLINE'}
          </span>
          <span className="sub">v{APP_VERSION}</span>
        </div>
        <div className="header-right">
          <div className="pulse-stat">
            <span>
              NODES <b>{up}</b>/<b>{nodes.length}</b>
            </span>
            <span className={down ? 'err' : ''}>
              DOWN <b className={down ? 'err' : ''}>{down}</b>
            </span>
            {current && (
              <span className="warn">
                RUNNING <b className="warn">{current.action} {current.target}</b>
              </span>
            )}
          </div>
          <span className="clock mono-num">{new Date(now).toUTCString().slice(5, 25)} UTC</span>
          <button className="btn icon" onClick={toggleTheme} title="Toggle light/dark" aria-label="Toggle theme">
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </button>
          <button className="btn icon" onClick={onLogout} title="Log out" aria-label="Log out">
            <LogoutIcon />
          </button>
        </div>
      </header>
      <nav className="tabstrip" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            <span className="label-text">{t.label}</span>
            {t.id === 'deploy' && current && <span className="dot degraded" />}
            {t.id === 'events' && unseenErrors > 0 && <span className="count">{unseenErrors}</span>}
            {t.id === 'topology' && errors > 0 && <span className="count">{errors}</span>}
          </button>
        ))}
      </nav>
      <main className="main">
        {tab === 'topology' && <TopologyTab goDeploy={() => setTab('deploy')} />}
        {tab === 'monitor' && <MonitorTab />}
        {tab === 'deploy' && <DeployTab />}
        {tab === 'events' && <EventsTab />}
        {tab === 'settings' && <SettingsTab />}
      </main>
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}

const BOOT = ['establishing secure channel…', 'loading topology…', 'authentication required'];

function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState(0);
  useEffect(() => {
    if (line < BOOT.length - 1) {
      const t = window.setTimeout(() => setLine(line + 1), 450);
      return () => window.clearTimeout(t);
    }
  }, [line]);
  return (
    <div className="login-wrap">
      <form
        className="panel login"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await post('/api/login', { password });
            onLogin();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="panel-title">
          <Logo size={18} />
          PgCloud Launcher
          <span className="grow" />
          <span className="faint" style={{ fontWeight: 400 }}>
            v{APP_VERSION}
          </span>
        </div>
        <div className="panel-body">
          <div className="typing">
            {BOOT.slice(0, line + 1).map((l, i) => (
              <div key={i} className={i === line ? 'cursor' : ''}>
                &gt; {l}
              </div>
            ))}
          </div>
          <label className="field">
            <span>Admin password</span>
            <input className="input" type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error && <div className="err" style={{ marginBottom: 10 }}>✖ {error}</div>}
          <button className="btn primary" style={{ width: '100%', height: 30 }} disabled={busy || !password}>
            {busy ? 'VERIFYING…' : 'ACCESS'}
          </button>
          <p className="faint" style={{ fontSize: 10.5, marginBottom: 0 }}>
            First start? The password is printed in the launcher logs and saved in <code>/data/admin-password.txt</code>.
          </p>
        </div>
      </form>
    </div>
  );
}

export function App() {
  const [auth, setAuth] = useState<boolean | null>(null);
  useEffect(() => {
    void api<{ authenticated: boolean }>('/api/session')
      .then((r) => setAuth(r.authenticated))
      .catch(() => setAuth(false));
    const onUnauthorized = () => setAuth(false);
    window.addEventListener('pgl:unauthorized', onUnauthorized);
    return () => window.removeEventListener('pgl:unauthorized', onUnauthorized);
  }, []);
  if (auth === null) return null;
  if (!auth)
    return (
      <>
        <Login onLogin={() => setAuth(true)} />
        {DEMO && <DemoWatermark />}
      </>
    );
  return (
    <StoreProvider>
      {DEMO && <DemoWatermark />}
      <Shell
        onLogout={async () => {
          await post('/api/logout').catch(() => undefined);
          setAuth(false);
        }}
      />
    </StoreProvider>
  );
}
