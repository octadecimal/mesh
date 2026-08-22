import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: {
    // Bind every interface so the page is reachable from the Windows host
    // browser under WSL2, whose NAT gives this VM its own IP. Windows does not
    // forward the WSL network onward, so this stays host-visible, not public.
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4317', changeOrigin: true },
    },
  },
  build: { outDir: '../dist/web', emptyOutDir: true },
});
