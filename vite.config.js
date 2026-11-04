import { defineConfig } from 'vite';

const debug = !!process.env.TAURI_ENV_DEBUG;

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: '127.0.0.1' },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  worker: { format: 'es' },
  build: {
    target: 'safari15',
    sourcemap: debug,
    // Monaco is large by nature; this is a desktop app, so size warnings are noise.
    chunkSizeWarningLimit: 8000,
  },
});
