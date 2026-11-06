import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from './env.js';
import { hashPassword, randomToken, verifyPassword } from './crypto.js';
import { kv } from './db.js';

// Single admin account. The launcher holds SSH credentials for every server,
// so every API call and the WebSocket require a session.

export const SESSION_COOKIE = 'pgl_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sessions = new Map<string, number>();
let failedLogins = 0;

export function initAdmin(log: (msg: string) => void): void {
  if (env.adminPassword) {
    log('Admin password taken from LAUNCHER_ADMIN_PASSWORD');
    return;
  }
  if (!kv.get<string>('adminHash')) {
    const password = randomToken(12);
    kv.set('adminHash', hashPassword(password));
    const file = path.join(env.dataDir, 'admin-password.txt');
    fs.writeFileSync(file, password + '\n', { mode: 0o600 });
    log('─'.repeat(64));
    log(`  pgpool-launcher admin password: ${password}`);
    log(`  (also saved in ${file}; change it in Settings)`);
    log('─'.repeat(64));
  }
}

export function passwordFromEnv(): boolean {
  return !!env.adminPassword;
}

export function checkPassword(password: string): boolean {
  if (env.adminPassword) {
    const a = Buffer.from(password);
    const b = Buffer.from(env.adminPassword);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  const stored = kv.get<string>('adminHash');
  return !!stored && verifyPassword(password, stored);
}

export function changePassword(current: string, next: string): void {
  if (env.adminPassword) throw Object.assign(new Error('The password is set by LAUNCHER_ADMIN_PASSWORD'), { statusCode: 400 });
  if (!checkPassword(current)) throw Object.assign(new Error('Current password is wrong'), { statusCode: 403 });
  if (next.length < 10) throw Object.assign(new Error('Use at least 10 characters'), { statusCode: 400 });
  kv.set('adminHash', hashPassword(next));
  fs.rmSync(path.join(env.dataDir, 'admin-password.txt'), { force: true });
  sessions.clear();
}

export async function login(password: string): Promise<string | null> {
  if (!checkPassword(password)) {
    failedLogins++;
    // slow down brute force
    await new Promise((r) => setTimeout(r, Math.min(5000, 300 * failedLogins)));
    return null;
  }
  failedLogins = 0;
  const token = randomToken();
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

export function logout(token: string | undefined): void {
  if (token) sessions.delete(token);
}

export function isValidSession(token: string | undefined): boolean {
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (exp < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function cookieOptions() {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: env.secureCookies,
    maxAge: SESSION_TTL_MS / 1000,
  };
}

export async function requireSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!isValidSession(req.cookies[SESSION_COOKIE])) {
    await reply.code(401).send({ error: 'Not authenticated' });
  }
}
