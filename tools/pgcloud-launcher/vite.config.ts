import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const here = path.dirname(fileURLToPath(import.meta.url));
// Demo output: the repository's doc/ folder, which also holds the book, images and diagrams.
const DEMO_OUT = path.resolve(here, '../../doc');

/** Remove only the files of the previous demo build; everything else in doc/ is kept. */
function cleanDemoOutput(): Plugin {
  let outDir = DEMO_OUT; // the resolved one, in case --outDir is passed on the command line
  return {
    name: 'clean-demo-output',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    buildStart() {
      fs.rmSync(path.join(outDir, 'assets'), { recursive: true, force: true });
      fs.rmSync(path.join(outDir, 'index.html'), { force: true });
    },
  };
}

// The SPA lives in web/ and is served by the Fastify backend in production.
// In development (npm run dev:web) API and WebSocket calls are proxied to the backend.
// `vite build --mode demo` (npm run build:demo) builds a front-end only demo with simulated data and a
// DEMO watermark into doc/ (index.html, assets/, logo.png, favicon.png), with relative paths so it can be
// opened from any static host. doc/ is not emptied: only the previous demo files are replaced.
export default defineConfig(({ mode }) => ({
  root: 'web',
  plugins: mode === 'demo' ? [react(), cleanDemoOutput()] : [react()],
  base: mode === 'demo' ? './' : '/',
  build: {
    outDir: mode === 'demo' ? DEMO_OUT : '../dist/web',
    emptyOutDir: mode !== 'demo',
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
}));
