import { describe, it, expect } from 'vitest';
import { loadAgendaJson, parseAgendaDocument } from './parseAgendaImport.js';

describe('parseAgendaDocument', () => {
  it('parses a flat top-level array of sessions and topics', () => {
    const result = parseAgendaDocument([
      { type: 'session', name: 'Morning', capacity: 60 },
      { type: 'topic', name: 'Welcome', presenters: ['Alice'], duration: 5 },
      { type: 'topic', name: 'Updates', duration: 15 },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.entries).toEqual([
      { kind: 'session', name: 'Morning', capacity: 60 },
      { kind: 'item', name: 'Welcome', presenters: ['Alice'], duration: 5 },
      { kind: 'item', name: 'Updates', presenters: [], duration: 15 },
    ]);
  });

  it('keeps sessions and topics in document order', () => {
    const result = parseAgendaDocument([
      { type: 'session', name: 'Block A', capacity: 30 },
      { type: 'topic', name: 'First', presenters: ['Bob'], duration: 10 },
      { type: 'topic', name: 'Second', duration: 20 },
      { type: 'session', name: 'Block B', capacity: 45 },
      { type: 'topic', name: 'After session', duration: 5 },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.entries).toEqual([
      { kind: 'session', name: 'Block A', capacity: 30 },
      { kind: 'item', name: 'First', presenters: ['Bob'], duration: 10 },
      { kind: 'item', name: 'Second', presenters: [], duration: 20 },
      { kind: 'session', name: 'Block B', capacity: 45 },
      { kind: 'item', name: 'After session', presenters: [], duration: 5 },
    ]);
  });

  it('rejects a session without a capacity', () => {
    const result = parseAgendaDocument([{ type: 'session', name: 'No capacity' }]);
    expect(result.ok).toBe(false);
  });

  it('rejects the legacy object wrapper (top-level array only)', () => {
    const result = parseAgendaDocument({ entries: [{ type: 'topic', name: 'Standalone' }] });
    expect(result.ok).toBe(false);
  });

  it('rejects nested session topics (flat entries only)', () => {
    const result = parseAgendaDocument([
      { type: 'session', name: 'Block A', topics: [{ type: 'topic', name: 'First' }] },
    ]);
    expect(result.ok).toBe(false);
  });

  it('rejects the timebox alias on a session', () => {
    const result = parseAgendaDocument([{ type: 'session', name: 'Morning', timebox: 60 }]);
    expect(result.ok).toBe(false);
  });

  it('rejects the timebox alias on a topic', () => {
    const result = parseAgendaDocument([{ type: 'topic', name: 'Item', timebox: 12 }]);
    expect(result.ok).toBe(false);
  });

  it('rejects the singular presenter alias on a topic', () => {
    const result = parseAgendaDocument([{ type: 'topic', name: 'Item', presenter: 'Alice' }]);
    expect(result.ok).toBe(false);
  });

  it('rejects unknown fields', () => {
    const result = parseAgendaDocument([{ type: 'topic', name: 'Item', extra: true }]);
    expect(result.ok).toBe(false);
  });

  it('rejects an empty document', () => {
    expect(parseAgendaDocument([])).toEqual({ ok: false, error: 'At least one entry is required' });
  });
});

describe('loadAgendaJson', () => {
  it('loads a JSON array from source text', () => {
    const result = loadAgendaJson(`[
      { "type": "topic", "name": "From file", "duration": 10 }
    ]`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.entries).toEqual([{ kind: 'item', name: 'From file', presenters: [], duration: 10 }]);
  });

  it('rejects invalid JSON', () => {
    const result = loadAgendaJson(`export default [{ type: 'topic', name: 'Item' }];`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/^Invalid JSON:/);
  });

  it('rejects empty source', () => {
    expect(loadAgendaJson('   ')).toEqual({ ok: false, error: 'File is empty' });
  });
});
