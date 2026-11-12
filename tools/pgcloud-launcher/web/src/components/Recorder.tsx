import { useCallback, useEffect, useRef, useState } from 'react';
import type { Recording } from '../../../shared/types';
import { api, post } from '../api';
import { useStore } from '../store';
import { useNow } from './ui';

export function useRecordings() {
  const { events } = useStore();
  const [data, setData] = useState<{ recordings: Recording[]; current: Recording | null }>({ recordings: [], current: null });
  const reload = useCallback(() => {
    void api<{ recordings: Recording[]; current: Recording | null }>('/api/recordings')
      .then(setData)
      .catch(() => undefined);
  }, []);
  // events announce start / stop / ready, so reloading on new events is enough
  useEffect(reload, [reload, events[0]?.id]);
  return { ...data, reload };
}

const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export const defaultRecordingName = () => `Recording ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;

/**
 * Header button: start / stop an audit recording; shows REC and the elapsed time while it runs.
 * Starting asks for an optional name in a small popover (Enter starts, Esc cancels).
 */
export function RecordButton() {
  const { toast } = useStore();
  const { current, recordings, reload } = useRecordings();
  const now = useNow();
  const collecting = recordings.some((r) => r.status === 'collecting');
  const [asking, setAsking] = useState(false);
  const [name, setName] = useState('');
  const [placeholder, setPlaceholder] = useState('');
  const wrap = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!asking) return;
    const close = (e: MouseEvent) => wrap.current && !wrap.current.contains(e.target as Node) && setAsking(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [asking]);

  const start = async () => {
    try {
      await post('/api/recordings/start', { name: name.trim() || undefined });
      toast('Recording: every event, operation and container log from now on will be collected', 'info');
      setAsking(false);
      setName('');
      reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const stop = async () => {
    try {
      await post('/api/recordings/stop');
      toast('Recording stopped: collecting the logs of every node (Audit tab)', 'info');
      reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <span className="rec-wrap" ref={wrap}>
      <button
        className={`btn rec-btn ${current ? 'on' : ''}`}
        onClick={() => {
          if (current) return void stop();
          setPlaceholder(defaultRecordingName());
          setAsking(!asking);
        }}
        title={current ? `Stop the audit recording "${current.name}"` : 'Record: collect every log with date and time for an audit'}
        aria-label={current ? 'Stop recording' : 'Start recording'}
        aria-expanded={asking}
      >
        <span className="rec-dot" />
        {current ? <span className="mono-num">REC {mmss(now - new Date(current.startedAt).getTime())}</span> : collecting ? 'collecting…' : 'REC'}
      </button>
      {asking && !current && (
        <div className="rec-pop panel" role="dialog" aria-label="Start an audit recording">
          <label className="field">
            <span>Name of the recording</span>
            <input
              className="input"
              autoFocus
              maxLength={120}
              placeholder={placeholder}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void start();
                if (e.key === 'Escape') setAsking(false);
              }}
            />
          </label>
          <p className="faint">Optional: empty keeps the date. You can rename it later in the Audit tab.</p>
          <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn ghost sm" onClick={() => setAsking(false)}>
              Cancel
            </button>
            <button className="btn danger sm" onClick={() => void start()}>
              <span className="rec-dot" /> Start recording
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
