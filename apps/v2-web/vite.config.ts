/// <reference types='vitest' />
import react from '@vitejs/plugin-react';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { defineConfig } from 'vite';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/v2-web',
  server: {
    port: 4300,
    host: '127.0.0.1',
    proxy: {
      '/api/v2': {
        target: 'http://127.0.0.1:3838',
        ws: true,
      },
    },
  },
  preview: { port: 4300, host: '127.0.0.1' },
  plugins: [react(), nxViteTsPaths()],
  build: {
    outDir: '../../dist/apps/v2-web',
    emptyOutDir: true,
    reportCompressedSize: true,
    commonjsOptions: { transformMixedEsModules: true },
  },
  test: {
    name: 'v2-web',
    watch: false,
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
  },
}));
