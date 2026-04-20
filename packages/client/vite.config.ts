import { createLogger, defineConfig } from 'vite';
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

// Safety net: http-proxy's WebSocket tunnel can throw EPIPE/ECONNRESET on a
// raw socket write path that isn't routed through proxy.on('error'), so the
// error escapes as an uncaught exception. Filter those here and let
// everything else propagate as a real crash.
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE' || err.code === 'ECONNRESET') {
    logProxyError(err);
    return;
  }
  throw err;
});

// Vite's built-in proxy middleware logs WS proxy errors through its own
// logger (not console.error), so patching console.error doesn't catch them.
// Wrap the default logger and drop error messages that contain an EPIPE or
// ECONNRESET stack trace — our proxy.on('error') handler above already logs
// a single-line summary, so Vite's duplicate is pure noise.
const filteredLogger = createLogger();
const originalLoggerError = filteredLogger.error.bind(filteredLogger);
filteredLogger.error = (msg, options) => {
  if (typeof msg === 'string' && /\bwrite EPIPE\b|\bread ECONNRESET\b/.test(msg)) {
    return;
  }
  originalLoggerError(msg, options);
};

const serverPort = process.env.PORT ?? '3000';
const serverTarget = `http://localhost:${serverPort}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  customLogger: filteredLogger,
  build: {
    chunkSizeWarningLimit: 600,
  },
  server: {
    proxy: {
      '/api': {
        target: serverTarget,
        configure: (proxy) => {
          proxy.on('error', logProxyError);
        },
      },
      '/auth': {
        target: serverTarget,
        configure: (proxy) => {
          proxy.on('error', logProxyError);
        },
      },
      '/socket.io': {
        target: serverTarget,
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
