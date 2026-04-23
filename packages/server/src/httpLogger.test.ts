import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { httpLogger } from './httpLogger.js';

function captureStdout() {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    if (typeof chunk === 'string') lines.push(chunk);
    return true;
  });
  return {
    restore: () => spy.mockRestore(),
    entries: () => lines.map((l) => JSON.parse(l)),
  };
}

async function listen(app: express.Express): Promise<{ baseUrl: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://localhost:${addr.port}`,
        close: () => server.close(),
      });
    });
  });
}

describe('httpLogger middleware', () => {
  let capture: ReturnType<typeof captureStdout>;
  let baseUrl: string;
  let close: () => void;

  beforeEach(async () => {
    capture = captureStdout();
    const app = express();
    app.use((req, _res, next) => {
      // Inject a faux session for the authenticated test route — real
      // sessions are populated by express-session upstream, but we bypass
      // that here to keep the test hermetic. Cast through unknown so the
      // fake session shape isn't force-fit to express-session's augmented
      // SessionData type.
      if (req.path === '/me') {
        (req as unknown as { session: { user: { ghid: number; ghUsername: string; isAdmin: boolean } } }).session = {
          user: { ghid: 42, ghUsername: 'octocat', isAdmin: false },
        };
      }
      next();
    });
    app.use(httpLogger);
    app.get('/api/health', (_req, res) => {
      res.json({ status: 'ok' });
    });
    app.get('/ok', (_req, res) => {
      res.status(200).send('ok');
    });
    app.get('/me', (_req, res) => {
      res.status(200).send('me');
    });
    app.get('/notfound', (_req, res) => {
      res.status(404).send('nope');
    });
    app.get('/boom', (_req, res) => {
      res.status(500).send('boom');
    });
    ({ baseUrl, close } = await listen(app));
  });

  afterEach(() => {
    close();
    capture.restore();
  });

  it('emits a structured INFO entry with a GCP-shaped httpRequest for 200 responses', async () => {
    await fetch(`${baseUrl}/ok`);
    // Allow res.on('finish') to run before asserting — the listener runs
    // on the next microtask after the body is flushed.
    await new Promise((r) => setImmediate(r));

    const entries = capture.entries().filter((e) => e.message === 'http_request');
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.severity).toBe('INFO');
    expect(entry.httpRequest.requestMethod).toBe('GET');
    expect(entry.httpRequest.requestUrl).toBe('/ok');
    expect(entry.httpRequest.status).toBe(200);
    expect(entry.httpRequest.protocol).toMatch(/^HTTP\//);
    expect(entry.httpRequest.latency).toMatch(/^\d+\.\d{9}s$/);
    expect(entry.user).toBeUndefined();
  });

  it('groups authenticated user fields under a nested user sub-struct', async () => {
    await fetch(`${baseUrl}/me`);
    await new Promise((r) => setImmediate(r));

    const entry = capture.entries().find((e) => e.message === 'http_request');
    expect(entry?.user).toEqual({ ghid: 42, ghUsername: 'octocat', isAdmin: false });
    // Top-level should NOT have the individual fields — attribution stays grouped.
    expect(entry?.ghid).toBeUndefined();
    expect(entry?.ghUsername).toBeUndefined();
    expect(entry?.isAdmin).toBeUndefined();
  });

  it('escalates severity to WARNING for 4xx and ERROR for 5xx', async () => {
    await fetch(`${baseUrl}/notfound`);
    await fetch(`${baseUrl}/boom`);
    await new Promise((r) => setImmediate(r));

    const entries = capture.entries().filter((e) => e.message === 'http_request');
    const not = entries.find((e) => e.httpRequest.status === 404);
    const boom = entries.find((e) => e.httpRequest.status === 500);
    expect(not?.severity).toBe('WARNING');
    expect(boom?.severity).toBe('ERROR');
  });

  it('skips /api/health to avoid log spam from Cloud Run uptime probes', async () => {
    await fetch(`${baseUrl}/api/health`);
    await new Promise((r) => setImmediate(r));

    const entries = capture.entries().filter((e) => e.message === 'http_request');
    expect(entries).toHaveLength(0);
  });
});
