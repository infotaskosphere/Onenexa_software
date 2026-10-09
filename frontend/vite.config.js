import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Electron loads the built app from file:// inside app.asar. Use relative
  // asset URLs only for the packaged desktop build; keep web deployment URLs rooted.
  base: process.env.ONENEXA_DESKTOP_BUILD === '1' ? './' : '/',
  root: path.resolve(__dirname, './'),
  publicDir: path.resolve(__dirname, './public'),
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Unified Inbox uses the backend's SSE stream for authenticated
      // real-time updates. The commercial backend has no Socket.IO server,
      // so avoid unsupported WebSocket handshakes while retaining the same
      // UI behavior through SSE/polling.
      'socket.io-client': path.resolve(__dirname, './src/lib/socketIoRealtimeFallback.js'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
    allowedHosts: true,
    hmr: process.env.DISABLE_HMR !== 'true',
    watch: process.env.DISABLE_HMR === 'true' ? null : {},
  },
  build: {
    outDir: path.resolve(__dirname, './dist'),
    sourcemap: false,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.name && assetInfo.name.endsWith('.css')) {
            return 'assets/[name]-[hash].css';
          }
          return 'assets/[name]-[hash][extname]';
        },
      },
    },
  },
  optimizeDeps: {
    include: ['@hello-pangea/dnd'],
  },
});
