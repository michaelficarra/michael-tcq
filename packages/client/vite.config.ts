import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Log proxy errors with context explaining why they're expected.
 */
function logProxyError(err: NodeJS.ErrnoException) {
  const code = err.code ?? '';
  let hint: string;
  if (code === 'ECONNREFUSED') {
    hint = 'this is expected if the server is still starting';
  } else if (code === 'EPIPE' || code === 'ECONNRESET') {
    hint = 'this is expected if someone just reloaded the page, abruptly closing the WebSocket connection';
  } else {
    hint = 'this may be transient; check that the server is running';
  }
  console.log(`Proxy error: ${err.message || err} (${hint})`);
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    chunkSizeWarningLimit: 600,
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        configure: (proxy) => { proxy.on('error', logProxyError); },
      },
      '/auth': {
        target: 'http://localhost:3000',
        configure: (proxy) => { proxy.on('error', logProxyError); },
      },
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
        configure: (proxy) => {
          proxy.on('error', logProxyError);
          proxy.on('proxyReqWs', (_proxyReq, _req, socket) => {
            socket.on('error', logProxyError);
          });
        },
      },
    },
  },
});
