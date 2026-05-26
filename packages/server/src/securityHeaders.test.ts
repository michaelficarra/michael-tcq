import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import { securityHeaders } from './securityHeaders.js';

/** Start an app on a random port and return the base URL + close function. */
async function listen(app: express.Express): Promise<{ baseUrl: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ baseUrl: `http://localhost:${port}`, close: () => server.close() });
    });
  });
}

/** Build an app guarded by the middleware and fetch a meeting-style path. */
async function fetchWithMiddleware(): Promise<Response> {
  const app = express();
  app.use(securityHeaders);
  app.get('/meeting/abc123', (_req, res) => res.send('ok'));
  const { baseUrl, close } = await listen(app);
  try {
    return await fetch(`${baseUrl}/meeting/abc123`);
  } finally {
    close();
  }
}

describe('securityHeaders middleware', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('sets Referrer-Policy so meeting links are not leaked cross-origin', async () => {
    const res = await fetchWithMiddleware();
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it('sets Strict-Transport-Security in production', async () => {
    process.env.NODE_ENV = 'production';
    const res = await fetchWithMiddleware();
    expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains');
  });

  it('omits Strict-Transport-Security outside production (avoids pinning localhost)', async () => {
    process.env.NODE_ENV = 'development';
    const res = await fetchWithMiddleware();
    expect(res.headers.get('Strict-Transport-Security')).toBeNull();
  });
});
