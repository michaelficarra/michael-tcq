import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { errorHandler } from './errorHandler.js';

function captureStdout() {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    if (typeof line === 'string') lines.push(line);
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

describe('errorHandler middleware', () => {
  let capture: ReturnType<typeof captureStdout>;
  let baseUrl: string;
  let close: () => void;

  beforeEach(async () => {
    capture = captureStdout();
    const app = express();
    app.get('/throw', () => {
      throw new Error('synchronous failure');
    });
    app.get('/async-throw', async () => {
      throw new Error('async failure');
    });
    app.use(errorHandler);
    ({ baseUrl, close } = await listen(app));
  });

  afterEach(() => {
    close();
    capture.restore();
  });

  it('responds with 500 JSON and logs an ERROR entry with a stack trace', async () => {
    const res = await fetch(`${baseUrl}/throw`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });

    const entry = capture.entries().find((e) => e.message === 'http_request_error');
    expect(entry).toBeDefined();
    expect(entry.severity).toBe('ERROR');
    expect(entry.httpRequest.status).toBe(500);
    expect(entry.httpRequest.requestMethod).toBe('GET');
    expect(entry.httpRequest.requestUrl).toBe('/throw');
    expect(entry.error.name).toBe('Error');
    expect(entry.error.message).toBe('synchronous failure');
    expect(typeof entry.error.stack).toBe('string');
  });

  it('catches async route errors too (Express 5 behaviour)', async () => {
    const res = await fetch(`${baseUrl}/async-throw`);
    expect(res.status).toBe(500);

    const entry = capture.entries().find((e) => e.message === 'http_request_error');
    expect(entry.error.message).toBe('async failure');
  });
});
