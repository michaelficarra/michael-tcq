import { describe, it, expect } from 'vitest';
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

describe('securityHeaders middleware', () => {
  it('sets Referrer-Policy so meeting links are not leaked cross-origin', async () => {
    const app = express();
    app.use(securityHeaders);
    app.get('/meeting/abc123', (_req, res) => res.send('ok'));

    const { baseUrl, close } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/meeting/abc123`);
      expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    } finally {
      close();
    }
  });
});
