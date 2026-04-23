import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { versionHandler } from './versionRoute.js';

async function listen(app: express.Express): Promise<{ baseUrl: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        baseUrl: `http://localhost:${port}`,
        close: () => server.close(),
      });
    });
  });
}

describe('GET /api/version', () => {
  let baseUrl: string;
  let close: () => void;
  // Save and restore GIT_SHA so tests don't leak into each other or the wider suite.
  let originalGitSha: string | undefined;

  beforeEach(async () => {
    originalGitSha = process.env.GIT_SHA;
    const app = express();
    app.get('/api/version', versionHandler);
    ({ baseUrl, close } = await listen(app));
  });

  afterEach(() => {
    close();
    if (originalGitSha === undefined) {
      delete process.env.GIT_SHA;
    } else {
      process.env.GIT_SHA = originalGitSha;
    }
  });

  it('returns 204 when GIT_SHA is not set', async () => {
    delete process.env.GIT_SHA;
    const res = await fetch(`${baseUrl}/api/version`);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('returns 204 when GIT_SHA is the empty string', async () => {
    process.env.GIT_SHA = '';
    const res = await fetch(`${baseUrl}/api/version`);
    expect(res.status).toBe(204);
  });

  it('returns the SHA as plain text by default when GIT_SHA is set', async () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    process.env.GIT_SHA = sha;
    const res = await fetch(`${baseUrl}/api/version`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await res.text()).toBe(sha);
  });

  it('returns plain text for Accept: */*', async () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    process.env.GIT_SHA = sha;
    const res = await fetch(`${baseUrl}/api/version`, { headers: { Accept: '*/*' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await res.text()).toBe(sha);
  });

  it('returns JSON when the client prefers application/json', async () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    process.env.GIT_SHA = sha;
    const res = await fetch(`${baseUrl}/api/version`, { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ sha });
  });

  it('returns JSON when application/json is ranked above text/plain', async () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    process.env.GIT_SHA = sha;
    const res = await fetch(`${baseUrl}/api/version`, {
      headers: { Accept: 'application/json;q=1.0, text/plain;q=0.5' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ sha });
  });

  it('returns plain text when text/plain is ranked above application/json', async () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    process.env.GIT_SHA = sha;
    const res = await fetch(`${baseUrl}/api/version`, {
      headers: { Accept: 'text/plain;q=1.0, application/json;q=0.5' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await res.text()).toBe(sha);
  });

  it('returns plain text when Accept does not include a supported type', async () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    process.env.GIT_SHA = sha;
    const res = await fetch(`${baseUrl}/api/version`, { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await res.text()).toBe(sha);
  });
});
