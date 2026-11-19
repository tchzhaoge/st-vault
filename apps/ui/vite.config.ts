import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:10002',
      '/health': 'http://127.0.0.1:10002',
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
