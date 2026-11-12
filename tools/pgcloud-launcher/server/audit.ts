// Audit recordings: while a recording runs, nothing extra is collected; when it stops, every source is
// gathered for that time window and merged into one timeline (saved in DATA_DIR/recordings/<id>.json):
// launcher events, operations (deploy, switchover...) with their console, the container logs of every
// node (docker/podman logs --timestamps) and the Pgpool-II failover / failback logs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONTAINER_NAME, type AuditEntry, type Recording } from '../shared/types.js';
import { getDeploymentLog, kv, listDeployments, listEventsBetween, listNodes } from './db.js';
import { paths } from './env.js';
import { emitEvent } from './hub.js';
import { onNode } from './deploy.js';

const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

function list(): Recording[] {
  return kv.get<Recording[]>('recordings') ?? [];
}
function save(recs: Recording[]): void {
  kv.set('recordings', recs.slice(0, 200));
}
function update(id: string, patch: Partial<Recording>): Recording | undefined {
  const recs = list();
  const r = recs.find((x) => x.id === id);
  if (r) Object.assign(r, patch);
  save(recs);
  return r;
}

export function listRecordings(): { recordings: Recording[]; current: Recording | null } {
  const recs = list();
  return { recordings: recs, current: recs.find((r) => r.status === 'recording') ?? null };
}

export function startRecording(name?: string): Recording {
  if (listRecordings().current) throw fail('A recording is already running');
  const r: Recording = {
    id: crypto.randomUUID(),
    name: name?.trim() || `Recording ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    status: 'recording',
    startedAt: new Date().toISOString(),
    endedAt: null,
    entries: 0,
  };
  save([r, ...list()]);
  emitEvent('info', `Audit recording started: ${r.name}`);
  return r;
}

export function renameRecording(id: string, name: string): Recording {
  const n = String(name ?? '').trim();
  if (!n) throw fail('Give the recording a name');
  if (n.length > 120) throw fail('The name is too long (120 characters at most)');
  const r = update(id, { name: n });
  if (!r) throw fail('Recording not found', 404);
  return r;
}

export function stopRecording(): Recording {
  const cur = listRecordings().current;
  if (!cur) throw fail('No recording is running');
  emitEvent('info', `Audit recording stopped: ${cur.name}; collecting the logs of every node`);
  const r = update(cur.id, { status: 'collecting', endedAt: new Date().toISOString() })!;
  void collect(r).catch((e) => {
    update(r.id, { status: 'failed', error: (e as Error).message });
    emitEvent('error', `Audit recording ${r.name}: ${(e as Error).message}`);
  });
  return r;
}

const levelOf = (text: string): AuditEntry['level'] =>
  /\b(FATAL|PANIC|ERROR|fail(ed)?\b|✖)/i.test(text) ? 'error' : /\b(WARNING|WARN|degraded)/i.test(text) ? 'warn' : 'info';

async function collect(r: Recording): Promise<void> {
  const from = r.startedAt;
  const to = r.endedAt ?? new Date().toISOString();
  const entries: AuditEntry[] = [];
  const nodes = listNodes();
  const nameOf = (id: string | null) => nodes.find((n) => n.id === id)?.name ?? null;

  // launcher events
  for (const e of listEventsBetween(from, to)) {
    entries.push({ ts: e.ts, source: 'event', node: nameOf(e.nodeId), level: e.level === 'success' ? 'info' : e.level, text: e.message });
  }
  // operations and their console (lines carry HH:MM:SS; the date comes from the operation)
  for (const d of listDeployments(500).filter((x) => x.startedAt <= to && (x.finishedAt ?? to) >= from)) {
    entries.push({ ts: d.startedAt, source: 'operation', node: null, level: 'info', text: `▶ ${d.action} ${d.target} (${d.status})` });
    const day = d.startedAt.slice(0, 10);
    let last = d.startedAt;
    for (const line of getDeploymentLog(d.id).split('\n').filter(Boolean)) {
      const m = /^\[(\w+)\] (\d\d:\d\d:\d\d) (.*)$/.exec(line);
      if (!m) continue;
      let ts = `${day}T${m[2]}.000Z`;
      if (ts < last.slice(0, 19)) ts = new Date(new Date(ts).getTime() + 86400e3).toISOString(); // crossed midnight
      last = ts;
      if (ts < from || ts > to) continue;
      const level = m[1] === 'error' ? 'error' : m[1] === 'warn' ? 'warn' : 'info';
      entries.push({ ts, source: 'operation', node: null, level, text: `${d.action} ${d.target}: ${m[3]}` });
    }
  }
  // container logs and Pgpool-II failover logs of every deployed node
  for (const n of nodes.filter((x) => x.deployedAt)) {
    try {
      await onNode(n, async (s, rt) => {
        const out = await s.exec(`${rt} logs --timestamps --since ${from} --until ${to} ${CONTAINER_NAME[n.type]} 2>&1`, { sudo: true });
        for (const line of out.stdout.split('\n')) {
          const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s?(.*)$/.exec(line);
          if (m && m[2].trim()) entries.push({ ts: new Date(m[1]).toISOString(), source: 'container', node: n.name, level: levelOf(m[2]), text: m[2] });
        }
        if (n.type === 'pgpool') {
          const fl = await s.exec(`${rt} exec ${CONTAINER_NAME.pgpool} sh -c 'cat /opt/pgcloud/log/failover.log /opt/pgcloud/log/failback.log 2>/dev/null'`, { sudo: true });
          let cur: string | null = null;
          for (const line of fl.stdout.split('\n')) {
            const m = /^(\w{3} \w{3}\s+\d+ [\d:]+ \w+ \d{4}) \|\s?(.*)$/.exec(line);
            if (m) {
              const d = new Date(m[1].replace(/ UTC /, ' ') + ' UTC');
              cur = Number.isNaN(d.getTime()) ? cur : d.toISOString();
            }
            const text = (m ? m[2] : line).trim();
            if (!cur || !text || cur < from || cur > to) continue;
            entries.push({ ts: cur, source: 'failover', node: n.name, level: levelOf(text), text });
          }
        }
      });
    } catch (e) {
      entries.push({ ts: to, source: 'launcher', node: n.name, level: 'warn', text: `Could not collect the logs of ${n.name}: ${(e as Error).message}` });
    }
  }
  entries.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  fs.writeFileSync(path.join(paths.recordings, `${r.id}.json`), JSON.stringify(entries));
  update(r.id, { status: 'ready', entries: entries.length });
  emitEvent('success', `Audit recording ready: ${r.name} (${entries.length} entries)`);
}

export function getRecording(id: string): { recording: Recording; entries: AuditEntry[] } {
  const recording = list().find((r) => r.id === id);
  if (!recording) throw fail('Recording not found', 404);
  const file = path.join(paths.recordings, `${id}.json`);
  const entries = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as AuditEntry[]) : [];
  return { recording, entries };
}

export function recordingAsText(id: string): string {
  const { recording, entries } = getRecording(id);
  const head = [
    `# PgCloud audit recording: ${recording.name}`,
    `# from ${recording.startedAt} to ${recording.endedAt ?? '-'} · ${entries.length} entries`,
    '# timestamp (UTC)            level  source     node        message',
  ];
  const body = entries.map(
    (e) => `${e.ts.padEnd(27)} ${e.level.toUpperCase().padEnd(6)} ${e.source.padEnd(10)} ${(e.node ?? '-').padEnd(11)} ${e.text}`,
  );
  return [...head, ...body].join('\n') + '\n';
}

export function deleteRecording(id: string): void {
  const recs = list();
  const r = recs.find((x) => x.id === id);
  if (!r) throw fail('Recording not found', 404);
  if (r.status === 'recording' || r.status === 'collecting') throw fail('Stop the recording first');
  save(recs.filter((x) => x.id !== id));
  fs.rmSync(path.join(paths.recordings, `${id}.json`), { force: true });
}
