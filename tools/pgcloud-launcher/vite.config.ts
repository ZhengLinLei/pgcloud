import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The SPA lives in web/ and is served by the Fastify backend in production.
// In development (npm run dev:web) API and WebSocket calls are proxied to the backend.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
});
