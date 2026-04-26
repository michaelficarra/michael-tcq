import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { log, info, warning, error, critical, serialiseError, formatLatency } from './logger.js';
import { getRecentErrors, getErrorCount, resetErrorBuffer } from './errorBuffer.js';

function captureStdout(): {
  restore: () => void;
  lines: () => string[];
} {
  const lines: string[] = [];
  // process.stdout.write has multiple overloads — the logger uses the
  // (string) form, so stubbing that specifically is enough.
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    if (typeof chunk === 'string') lines.push(chunk);
    return true;
  });
  return {
    restore: () => spy.mockRestore(),
    lines: () => lines,
  };
}

describe('logger.log', () => {
  let capture: ReturnType<typeof captureStdout>;
  let originalGitSha: string | undefined;

  beforeEach(() => {
    capture = captureStdout();
    originalGitSha = process.env.GIT_SHA;
    delete process.env.GIT_SHA;
  });

  afterEach(() => {
    capture.restore();
    if (originalGitSha === undefined) delete process.env.GIT_SHA;
    else process.env.GIT_SHA = originalGitSha;
  });

  it('writes a single JSON line with the core fields', () => {
    log('INFO', 'hello', { foo: 1 });
    const lines = capture.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith('\n')).toBe(true);
    const entry = JSON.parse(lines[0]);
    expect(entry.severity).toBe('INFO');
    expect(entry.message).toBe('hello');
    expect(entry.service).toBe('tcq');
    expect(entry.foo).toBe(1);
    // RFC3339 timestamp — Date parses it back without error
    expect(Number.isFinite(new Date(entry.time).getTime())).toBe(true);
    expect(entry.gitSha).toBeUndefined();
  });

  it('includes gitSha when GIT_SHA env var is set', () => {
    process.env.GIT_SHA = 'abc123';
    info('deployed', {});
    const entry = JSON.parse(capture.lines()[0]);
    expect(entry.gitSha).toBe('abc123');
  });

  it('uses the convenience wrappers with the right severity', () => {
    warning('watch_out', { reason: 'x' });
    const entry = JSON.parse(capture.lines()[0]);
    expect(entry.severity).toBe('WARNING');
    expect(entry.reason).toBe('x');
  });

  describe('errorBuffer mirroring', () => {
    beforeEach(() => {
      resetErrorBuffer();
    });

    it('records ERROR entries to the buffer', () => {
      const before = getErrorCount();
      error('boom', { foo: 1 });
      expect(getErrorCount()).toBe(before + 1);
      const [entry] = getRecentErrors();
      expect(entry.severity).toBe('ERROR');
      expect(entry.message).toBe('boom');
    });

    it('records CRITICAL entries to the buffer', () => {
      critical('on_fire');
      const [entry] = getRecentErrors();
      expect(entry.severity).toBe('CRITICAL');
      expect(entry.message).toBe('on_fire');
    });

    it('does not record INFO/WARNING entries', () => {
      info('routine');
      warning('soft');
      expect(getErrorCount()).toBe(0);
      expect(getRecentErrors()).toHaveLength(0);
    });
  });
});

describe('serialiseError', () => {
  it('preserves name, message, and stack for Error instances', () => {
    const err = new Error('boom');
    const out = serialiseError(err);
    expect(out.name).toBe('Error');
    expect(out.message).toBe('boom');
    expect(typeof out.stack).toBe('string');
  });

  it('handles string throws', () => {
    const out = serialiseError('not an error');
    expect(out.name).toBe('NonErrorString');
    expect(out.message).toBe('not an error');
  });

  it('handles null and undefined', () => {
    expect(serialiseError(null).message).toBe('null');
    expect(serialiseError(undefined).message).toBe('undefined');
  });

  it('handles plain object throws', () => {
    const out = serialiseError({ a: 1 });
    expect(out.name).toBe('NonError');
    expect(out.message).toBe('{"a":1}');
  });
});

describe('formatLatency', () => {
  it('formats whole seconds', () => {
    expect(formatLatency(2_000_000_000n)).toBe('2.000000000s');
  });

  it('pads sub-second fractions', () => {
    // 50 ns → 0.000000050s (left-padded)
    expect(formatLatency(50n)).toBe('0.000000050s');
  });

  it('handles mixed seconds and nanoseconds', () => {
    expect(formatLatency(1_500_000_000n)).toBe('1.500000000s');
  });

  it('clamps negative values to zero', () => {
    expect(formatLatency(-5n)).toBe('0.000000000s');
  });
});
