import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 600_000,
    // the simulation tests are long synchronous loops; running files one at a
    // time keeps the worker RPC responsive
    fileParallelism: false,
    setupFiles: ['tests/setup.ts'],
  },
} as any);
