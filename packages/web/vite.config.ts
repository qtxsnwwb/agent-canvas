import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Dev only: forward API and WebSocket traffic to the local server. /hooks is not proxied (the page never calls it).
const target = 'http://127.0.0.1:4317';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@agent-canvas/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    proxy: {
      '/api': target,
      '/ws': { target, ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
