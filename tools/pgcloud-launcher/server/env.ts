import path from 'node:path';
import fs from 'node:fs';

/** Runtime configuration, taken from environment variables. */
export const env = {
  host: process.env.HOST ?? '0.0.0.0',
  port: Number(process.env.PORT ?? 8080),
  dataDir: path.resolve(process.env.DATA_DIR ?? './data'),
  /** If set, this is always the admin password. Otherwise one is generated on first start. */
  adminPassword: process.env.LAUNCHER_ADMIN_PASSWORD ?? '',
  /** If set, used to derive the key that encrypts secrets in the database. Otherwise a key file is created in DATA_DIR. */
  secretKey: process.env.LAUNCHER_SECRET_KEY ?? '',
  /** Set to "true" when the launcher is served over HTTPS (behind a TLS proxy) to mark the session cookie Secure. */
  secureCookies: process.env.LAUNCHER_SECURE_COOKIES === 'true',
  logLevel: process.env.LOG_LEVEL ?? 'info',
};

export const paths = {
  db: path.join(env.dataDir, 'launcher.db'),
  keyFile: path.join(env.dataDir, 'secret.key'),
  images: path.join(env.dataDir, 'images'),
  recordings: path.join(env.dataDir, 'recordings'),
};

fs.mkdirSync(env.dataDir, { recursive: true });
fs.mkdirSync(paths.images, { recursive: true });
fs.mkdirSync(paths.recordings, { recursive: true });
