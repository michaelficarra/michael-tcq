import { createLogger, defineConfig, type Plugin, type ResolvedConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { loadConfig, optimize } from 'svgo';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Recursively yield every `.svg` file under `dir`. Used by the build-time
// SVG optimiser plugin below; tolerates a missing directory because the
// plugin runs unconditionally and the output dir may not contain SVGs.
async function* walkSvgs(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkSvgs(full);
    } else if (extname(entry.name).toLowerCase() === '.svg') {
      yield full;
    }
  }
}

// Build-time SVG optimiser. Walks the output directory after Vite has
// finished writing everything (including `public/` copies, which happen in
// the internal `vite:copy-public` plugin's `writeBundle` hook) and rewrites
// each SVG with the SVGO-optimised version. The same `svgo.config.mjs` at
// the repo root drives both this plugin and the `optimize:svg` script, so
// build output stays optimised even when a contributor lands a new SVG
// without first running the manual script.
function svgoBuildPlugin(): Plugin {
  let resolved: ResolvedConfig;
  const configPath = resolve(fileURLToPath(import.meta.url), '../../../svgo.config.mjs');
  return {
    name: 'tcq:svgo-optimize',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      resolved = config;
    },
    async closeBundle() {
      const svgoConfig = await loadConfig(configPath);
      const outDir = resolve(resolved.root, resolved.build.outDir);
      let count = 0;
      let saved = 0;
      for await (const file of walkSvgs(outDir)) {
        const original = await readFile(file, 'utf8');
        const result = optimize(original, { ...svgoConfig, path: file });
        if (!('data' in result)) continue;
        if (result.data !== original) {
          await writeFile(file, result.data);
        }
        count += 1;
        saved += Buffer.byteLength(original) - Buffer.byteLength(result.data);
      }
      if (count > 0) {
        resolved.logger.info(
          `[svgo] optimised ${count} SVG file(s) in ${relative(resolved.root, outDir)} (-${saved} bytes)`,
        );
      }
    },
  };
}

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
  console.warn(`Proxy error: ${err.message || err} (${hint})`);
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
  plugins: [react(), tailwindcss(), svgoBuildPlugin()],
  customLogger: filteredLogger,
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Split heavy third-party deps into named vendor chunks so a code
        // change to app code doesn't invalidate the cached vendor bundle on
        // the next deploy. Matches against each module's resolved id so
        // transitive deps (e.g. unified's submodules under node_modules)
        // also land in the right chunk.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          // React + router: shared by every route, on the critical path.
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) {
            return 'react';
          }
          // dnd-kit: only loaded with the meeting page.
          if (/[\\/]node_modules[\\/]@dnd-kit[\\/]/.test(id)) return 'dnd';
          // Socket.IO transport + msgpack parser: only loaded with the meeting page.
          if (
            /[\\/]node_modules[\\/](socket\.io-client|socket\.io-msgpack-parser|engine\.io-client|@msgpack)[\\/]/.test(
              id,
            )
          ) {
            return 'socket';
          }
          // Markdown stack (unified/remark/rehype + their many micromark/mdast/hast helpers).
          if (
            /[\\/]node_modules[\\/](unified|remark-.*|rehype-.*|mdast-.*|hast-.*|micromark.*|character-entities.*|decode-named-character-reference|trim-lines|space-separated-tokens|comma-separated-tokens|property-information|html-void-elements|web-namespaces|zwitch|trough|bail|is-plain-obj|vfile.*|unist-.*|ccount|escape-string-regexp|longest-streak|markdown-table|stringify-entities|devlop)[\\/]/.test(
              id,
            )
          ) {
            return 'markdown';
          }
          return undefined;
        },
      },
    },
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
