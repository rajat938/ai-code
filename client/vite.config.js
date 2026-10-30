import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Where the dev server forwards /api calls.
// Locally: http://localhost:5000. In Docker: http://server:5000 (set in docker-compose.yml).
const apiTarget = process.env.API_PROXY_TARGET || 'http://localhost:5000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: { '/api': { target: apiTarget, changeOrigin: true } },
    // File-change detection works reliably inside Docker on Windows/macOS
    watch: process.env.CHOKIDAR_USEPOLLING ? { usePolling: true } : undefined,
  },
});
