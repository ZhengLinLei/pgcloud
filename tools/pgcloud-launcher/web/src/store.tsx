import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  ClusterEdge,
  ClusterEvent,
  ClusterNode,
  Deployment,
  NodeLive,
  SettingsView,
  Validation,
  WsMessage,
} from '../../shared/types';
import { api } from './api';

export interface LogLine {
  line: string;
  level: string;
}

interface StateResponse {
  nodes: ClusterNode[];
  edges: ClusterEdge[];
  settings: SettingsView;
  validation: Validation;
  deployments: Deployment[];
  current: Deployment | null;
  live: Record<string, NodeLive>;
  events: ClusterEvent[];
}

interface Store extends StateResponse {
  loaded: boolean;
  connected: boolean;
  logs: Record<string, LogLine[]>;
  refresh: () => Promise<void>;
  loadLog: (id: string) => Promise<void>;
  toast: (message: string, kind?: 'ok' | 'error' | 'info') => void;
  toasts: Array<{ id: number; message: string; kind: string }>;
}

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('StoreProvider missing');
  return s;
}

const EMPTY: StateResponse = {
  nodes: [],
  edges: [],
  settings: undefined as unknown as SettingsView,
  validation: { ok: false, issues: [], plan: [], roles: {} },
  deployments: [],
  current: null,
  live: {},
  events: [],
};

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StateResponse>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [connected, setConnected] = useState(false);
  const [logs, setLogs] = useState<Record<string, LogLine[]>>({});
  const [toasts, setToasts] = useState<Store['toasts']>([]);
  const refreshTimer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    const s = await api<StateResponse>('/api/state');
    setState((prev) => ({ ...s, live: { ...prev.live, ...s.live } }));
    setLoaded(true);
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => void refresh().catch(() => undefined), 150);
  }, [refresh]);

  const loadLog = useCallback(async (id: string) => {
    const { log } = await api<{ log: string }>(`/api/deployments/${id}/log`);
    const lines = log
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const m = /^\[(\w+)\] (.*)$/.exec(l);
        return m ? { level: m[1], line: m[2] } : { level: 'info', line: l };
      });
    setLogs((prev) => ({ ...prev, [id]: lines }));
  }, []);

  const toast = useCallback((message: string, kind: 'ok' | 'error' | 'info' = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, kind }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  // WebSocket with automatic reconnection
  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: number | null = null;
    let closed = false;
    const onMessage = (msg: WsMessage) => {
      switch (msg.type) {
        case 'live':
          setState((s) => ({ ...s, live: msg.nodes }));
          break;
        case 'log':
          setLogs((prev) => {
            const list = prev[msg.deploymentId] ?? [];
            const next = [...list, { line: msg.line, level: msg.level ?? 'info' }];
            return { ...prev, [msg.deploymentId]: next.length > 3000 ? next.slice(-3000) : next };
          });
          break;
        case 'deployment':
          setState((s) => {
            const others = s.deployments.filter((d) => d.id !== msg.deployment.id);
            return {
              ...s,
              deployments: [msg.deployment, ...others].sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
              current: msg.deployment.status === 'running' ? msg.deployment : s.current?.id === msg.deployment.id ? null : s.current,
            };
          });
          break;
        case 'event':
          setState((s) => ({ ...s, events: [msg.event, ...s.events].slice(0, 500) }));
          break;
        case 'topology':
          scheduleRefresh();
          break;
      }
    };
    if (import.meta.env.MODE === 'demo') {
      // Demo build: simulated live feed instead of the WebSocket
      let unsubscribe: (() => void) | null = null;
      void import('./demo/mock').then((m) => {
        if (closed) return;
        unsubscribe = m.subscribe(onMessage);
        setConnected(true);
      });
      return () => {
        closed = true;
        unsubscribe?.();
      };
    }
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => {
        setConnected(true);
        scheduleRefresh();
      };
      ws.onclose = (e) => {
        setConnected(false);
        if (e.code === 4401) window.dispatchEvent(new CustomEvent('pgl:unauthorized'));
        if (!closed) retry = window.setTimeout(connect, 2000);
      };
      ws.onmessage = (ev) => onMessage(JSON.parse(ev.data as string) as WsMessage);
    };
    connect();
    return () => {
      closed = true;
      if (retry) window.clearTimeout(retry);
      ws?.close();
    };
  }, [scheduleRefresh]);

  const value = useMemo<Store>(
    () => ({ ...state, loaded, connected, logs, refresh, loadLog, toast, toasts }),
    [state, loaded, connected, logs, refresh, loadLog, toast, toasts],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
