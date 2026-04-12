import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/auth': 'http://localhost:3000',
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
        // Suppress noisy EPIPE / ECONNRESET errors when WebSocket
        // connections close abruptly (e.g. during server restarts).
        configure: (proxy) => {
          proxy.on('error', (err) => {
            console.log(`WebSocket proxy: backend connection error (${err.message})`);
          });
          proxy.on('proxyReqWs', (_proxyReq, _req, socket) => {
            socket.on('error', (err: Error) => {
              console.log(`WebSocket proxy: backend disconnected while forwarding (${err.message})`);
            });
          });
        },
      },
    },
  },
});
