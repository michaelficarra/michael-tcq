import { describe, it, expect } from 'vitest';
import { loadAgendaJson, parseAgendaDocument } from './parseAgendaImport.js';

describe('parseAgendaDocument', () => {
  it('parses a top-level array of topics and sessions', () => {
    const result = parseAgendaDocument([
      { type: 'session', name: 'Morning', timebox: 60 },
      { type: 'topic', name: 'Welcome', presenter: 'Alice', timebox: 5 },
      { type: 'topic', name: 'Updates', timebox: 15 },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.entries).toEqual([
      { kind: 'session', name: 'Morning', capacity: 60 },
      { kind: 'item', name: 'Welcome', presenters: ['Alice'], duration: 5 },
      { kind: 'item', name: 'Updates', presenters: [], duration: 15 },
    ]);
  });

  it('accepts an object wrapper with entries', () => {
    const result = parseAgendaDocument({
      entries: [{ type: 'topic', name: 'Standalone' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.entries).toEqual([{ kind: 'item', name: 'Standalone', presenters: [] }]);
  });

  it('flattens nested session topics immediately after the session', () => {
    const result = parseAgendaDocument([
      {
        type: 'session',
        name: 'Block A',
        topics: [
          { name: 'First', presenter: 'Bob', timebox: 10 },
          { name: 'Second', timebox: 20 },
        ],
      },
      { type: 'topic', name: 'After session', timebox: 5 },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.entries).toEqual([
      { kind: 'session', name: 'Block A' },
      { kind: 'item', name: 'First', presenters: ['Bob'], duration: 10 },
      { kind: 'item', name: 'Second', presenters: [], duration: 20 },
      { kind: 'item', name: 'After session', presenters: [], duration: 5 },
    ]);
  });

  it('leaves session capacity unset when timebox is omitted', () => {
    const result = parseAgendaDocument([{ type: 'session', name: 'Empty block' }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.entries[0]).toEqual({
      kind: 'session',
      name: 'Empty block',
    });
  });

  it('accepts duration as an alias for timebox', () => {
    const result = parseAgendaDocument([{ type: 'topic', name: 'Item', duration: 12 }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.entries[0]).toEqual({
      kind: 'item',
      name: 'Item',
      presenters: [],
      duration: 12,
    });
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
      { "type": "topic", "name": "From file", "timebox": 10 }
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
