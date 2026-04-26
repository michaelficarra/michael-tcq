import { describe, it, expect, beforeEach } from 'vitest';
import { recordError, getRecentErrors, getErrorCount, resetErrorBuffer } from './errorBuffer.js';

describe('errorBuffer', () => {
  beforeEach(() => {
    resetErrorBuffer();
  });

  it('records and returns entries newest-first', () => {
    recordError({ timestamp: '2026-04-26T10:00:00.000Z', severity: 'ERROR', message: 'first' });
    recordError({ timestamp: '2026-04-26T10:00:01.000Z', severity: 'ERROR', message: 'second' });

    const recent = getRecentErrors();
    expect(recent).toHaveLength(2);
    expect(recent[0].message).toBe('second');
    expect(recent[1].message).toBe('first');
  });

  it('counts every record even when entries are evicted', () => {
    for (let i = 0; i < 60; i++) {
      recordError({ timestamp: '2026-04-26T10:00:00.000Z', severity: 'ERROR', message: `m${i}` });
    }
    expect(getErrorCount()).toBe(60);
    // Ring is bounded at 50.
    expect(getRecentErrors()).toHaveLength(50);
    // Oldest entries (m0..m9) have been evicted.
    expect(getRecentErrors().some((e) => e.message === 'm0')).toBe(false);
    expect(getRecentErrors()[0].message).toBe('m59');
  });

  it('renders a detail preview from an error field if present', () => {
    recordError({
      timestamp: '2026-04-26T10:00:00.000Z',
      severity: 'ERROR',
      message: 'http_request_error',
      fields: { error: { name: 'TypeError', message: 'Cannot read x of undefined' } },
    });
    const [entry] = getRecentErrors();
    expect(entry.detail).toBe('Cannot read x of undefined');
  });

  it('truncates very long detail previews', () => {
    const long = 'x'.repeat(500);
    recordError({
      timestamp: '2026-04-26T10:00:00.000Z',
      severity: 'ERROR',
      message: 'big',
      fields: { error: { message: long } },
    });
    const [entry] = getRecentErrors();
    expect(entry.detail).toBeDefined();
    expect(entry.detail!.length).toBeLessThanOrEqual(200);
    expect(entry.detail!.endsWith('…')).toBe(true);
  });

  it('omits detail when there are no extra fields', () => {
    recordError({ timestamp: '2026-04-26T10:00:00.000Z', severity: 'CRITICAL', message: 'plain' });
    const [entry] = getRecentErrors();
    expect(entry.detail).toBeUndefined();
    expect(entry.severity).toBe('CRITICAL');
  });
});
