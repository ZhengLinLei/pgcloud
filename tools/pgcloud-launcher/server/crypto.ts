import crypto from 'node:crypto';
import fs from 'node:fs';
import { env, paths } from './env.js';

// Secrets (SSH passwords/keys, cluster passwords) are stored encrypted with AES-256-GCM.
// The key comes from LAUNCHER_SECRET_KEY or from a random key file in the data directory.

function loadKey(): Buffer {
  if (env.secretKey) return crypto.createHash('sha256').update(env.secretKey).digest();
  if (!fs.existsSync(paths.keyFile)) {
    fs.writeFileSync(paths.keyFile, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  }
  return Buffer.from(fs.readFileSync(paths.keyFile, 'utf8').trim(), 'base64');
}

const key = loadKey();
const PREFIX = 'enc:v1:';

export function encrypt(plain: string): string {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function decrypt(value: string | undefined | null): string {
  if (!value) return '';
  if (!value.startsWith(PREFIX)) return value;
  const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt:${salt.toString('base64')}:${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [, salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export function randomToken(bytes = 32): string {
  // Never start with "-": the token is also used as a password, and command line tools
  // (pg_enc, pg_md5...) would read a leading "-" as an option.
  for (;;) {
    const token = crypto.randomBytes(bytes).toString('base64url');
    if (!token.startsWith('-')) return token;
  }
}
