import { Client, type ConnectConfig, type SFTPWrapper } from 'ssh2';
import fs from 'node:fs';
import path from 'node:path';
import type { RuntimeChoice } from '../shared/types.js';
import type { SshSecretConfig } from './db.js';

/** Single-quote a value for a POSIX shell. */
export function q(value: string | number): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class SshSession {
  private client = new Client();
  private sftpHandle: SFTPWrapper | null = null;
  homeDir = '';

  constructor(private readonly cfg: SshSecretConfig) {}

  connect(timeoutMs = 15000): Promise<this> {
    const options: ConnectConfig = {
      host: this.cfg.host,
      port: this.cfg.port,
      username: this.cfg.user,
      readyTimeout: timeoutMs,
      keepaliveInterval: 10000,
    };
    if (this.cfg.auth === 'key') {
      options.privateKey = this.cfg.privateKey;
      if (this.cfg.passphrase) options.passphrase = this.cfg.passphrase;
    } else {
      options.password = this.cfg.password;
      options.tryKeyboard = true;
    }
    return new Promise((resolve, reject) => {
      this.client
        .on('ready', () => resolve(this))
        .on('error', (err) => reject(new Error(`SSH ${this.cfg.user}@${this.cfg.host}:${this.cfg.port}: ${err.message}`)))
        .on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => this.cfg.password)))
        .connect(options);
    });
  }

  /** Run a command. `sudo` wraps it in `sudo -n sh -c` when the node is configured to use sudo. */
  exec(
    command: string,
    opts: { sudo?: boolean; onData?: (chunk: string) => void; timeoutMs?: number } = {},
  ): Promise<ExecResult> {
    const useSudo = opts.sudo ?? false;
    const full = useSudo && this.cfg.sudo ? `sudo -n sh -c ${q(command)}` : command;
    return new Promise((resolve, reject) => {
      this.client.exec(full, (err, stream) => {
        if (err) return reject(err);
        let stdout = '';
        let stderr = '';
        const timer = opts.timeoutMs
          ? setTimeout(() => {
              stream.close();
              reject(new Error(`Timeout after ${opts.timeoutMs} ms: ${command}`));
            }, opts.timeoutMs)
          : null;
        stream
          .on('close', (code: number | null) => {
            if (timer) clearTimeout(timer);
            resolve({ code: code ?? 0, stdout, stderr });
          })
          .on('data', (d: Buffer) => {
            stdout += d.toString();
            opts.onData?.(d.toString());
          });
        stream.stderr.on('data', (d: Buffer) => {
          stderr += d.toString();
          opts.onData?.(d.toString());
        });
      });
    });
  }

  /** Like exec but throws when the exit code is not 0. */
  async run(command: string, opts: Parameters<SshSession['exec']>[1] = {}): Promise<string> {
    const r = await this.exec(command, opts);
    if (r.code !== 0) {
      const detail = (r.stderr || r.stdout).trim().split('\n').slice(-5).join('\n');
      throw new Error(`Command failed (exit ${r.code}): ${command}\n${detail}`);
    }
    return r.stdout;
  }

  private sftp(): Promise<SFTPWrapper> {
    if (this.sftpHandle) return Promise.resolve(this.sftpHandle);
    return new Promise((resolve, reject) =>
      this.client.sftp((err, s) => {
        if (err) return reject(err);
        this.sftpHandle = s;
        resolve(s);
      }),
    );
  }

  /** Resolve "~" in a remote path using the remote $HOME. */
  async resolvePath(p: string): Promise<string> {
    if (!this.homeDir) this.homeDir = (await this.run('printf %s "$HOME"')).trim() || '/root';
    if (p === '~') return this.homeDir;
    if (p.startsWith('~/')) return path.posix.join(this.homeDir, p.slice(2));
    return p;
  }

  async writeFile(remotePath: string, content: string, mode = 0o600): Promise<void> {
    const s = await this.sftp();
    await new Promise<void>((resolve, reject) => {
      const ws = s.createWriteStream(remotePath, { mode });
      ws.on('error', reject).on('close', () => resolve());
      ws.end(content);
    });
    // createWriteStream mode only applies to new files
    await new Promise<void>((resolve, reject) => s.chmod(remotePath, mode, (e) => (e ? reject(e) : resolve())));
  }

  async remoteSize(remotePath: string): Promise<number | null> {
    const s = await this.sftp();
    return new Promise((resolve) => s.stat(remotePath, (err, st) => resolve(err ? null : st.size)));
  }

  async uploadFile(localPath: string, remotePath: string, onProgress?: (pct: number) => void): Promise<void> {
    const s = await this.sftp();
    const total = fs.statSync(localPath).size;
    let sent = 0;
    let lastPct = -1;
    await new Promise<void>((resolve, reject) => {
      const rs = fs.createReadStream(localPath);
      const ws = s.createWriteStream(remotePath, { mode: 0o600 });
      rs.on('data', (chunk) => {
        sent += chunk.length;
        const pct = Math.floor((sent / total) * 100);
        if (pct !== lastPct && pct % 10 === 0) {
          lastPct = pct;
          onProgress?.(pct);
        }
      });
      ws.on('error', reject).on('close', () => resolve());
      rs.on('error', reject);
      rs.pipe(ws);
    });
  }

  close(): void {
    try {
      this.client.end();
    } catch {
      /* ignore */
    }
  }
}

export async function withSsh<T>(cfg: SshSecretConfig, fn: (s: SshSession) => Promise<T>): Promise<T> {
  if (!cfg.host) throw new Error('SSH host is not configured');
  const session = await new SshSession(cfg).connect();
  try {
    return await fn(session);
  } finally {
    session.close();
  }
}

export interface RuntimeInfo {
  bin: 'docker' | 'podman';
  version: string;
}

/** Find a usable container runtime on the remote host (daemon reachable, not just installed). */
export async function detectRuntime(s: SshSession, choice: RuntimeChoice): Promise<RuntimeInfo> {
  const candidates: Array<'docker' | 'podman'> = choice === 'auto' ? ['docker', 'podman'] : [choice];
  const problems: string[] = [];
  for (const bin of candidates) {
    const r = await s.exec(`${bin} version --format '{{.Server.Version}}' 2>&1 || ${bin} --version 2>&1`, {
      sudo: true,
    });
    const which = await s.exec(`command -v ${bin}`, { sudo: true });
    if (which.code !== 0) {
      problems.push(`${bin}: not installed`);
      continue;
    }
    const info = await s.exec(`${bin} info --format '{{json .}}' >/dev/null 2>&1`, { sudo: true });
    if (info.code !== 0) {
      problems.push(`${bin}: installed but not usable by this user (${r.stdout.trim().split('\n')[0]})`);
      continue;
    }
    return { bin, version: r.stdout.trim().split('\n')[0] };
  }
  throw new Error(
    `No usable container runtime (${problems.join('; ')}). Install Docker or Podman, add the SSH user to the docker group, or enable "sudo" for this node.`,
  );
}
