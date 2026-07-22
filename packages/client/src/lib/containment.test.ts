import { describe, it, expect } from 'vitest';
import type { AgendaEntry } from '@tcq/shared';
import { asUserKey } from '@tcq/shared';
import { computeContainment, computePastSessions } from './containment.js';

/** Concise agenda-entry builders for test fixtures. */
function item(id: string, duration?: number): AgendaEntry {
  return { kind: 'item', id, name: id, presenterIds: [asUserKey('github:presenter')], duration };
}
function session(id: string, capacity: number): AgendaEntry {
  return { kind: 'session', id, name: id, capacity };
}

describe('computeContainment', () => {
  it('returns empty maps for an empty agenda', () => {
    const { containedBy, used, runTotal } = computeContainment([]);
    expect(containedBy.size).toBe(0);
    expect(used.size).toBe(0);
    expect(runTotal.size).toBe(0);
  });

  it('ignores items that appear before any session', () => {
    const entries: AgendaEntry[] = [item('a', 10), item('b', 15)];
    const { containedBy, used, runTotal } = computeContainment(entries);
    expect(containedBy.size).toBe(0);
    expect(used.size).toBe(0);
    expect(runTotal.size).toBe(0);
  });

  it('contains items that fit within capacity and reports the used sum', () => {
    const entries: AgendaEntry[] = [session('s', 30), item('a', 10), item('b', 15)];
    const { containedBy, overflowBy, used, runTotal } = computeContainment(entries);
    expect(containedBy.get('a')).toBe('s');
    expect(containedBy.get('b')).toBe('s');
    expect(overflowBy.size).toBe(0);
    expect(used.get('s')).toBe(25);
    expect(runTotal.get('s')).toBe(25);
  });

  it('reports a session with no items as used=0 and runTotal=0', () => {
    const { used, runTotal } = computeContainment([session('s', 30)]);
    expect(used.get('s')).toBe(0);
    expect(runTotal.get('s')).toBe(0);
  });

  it('fills exactly to capacity', () => {
    const entries: AgendaEntry[] = [session('s', 30), item('a', 10), item('b', 20)];
    const { containedBy, used, runTotal } = computeContainment(entries);
    expect(containedBy.get('a')).toBe('s');
    expect(containedBy.get('b')).toBe('s');
    expect(used.get('s')).toBe(30);
    expect(runTotal.get('s')).toBe(30);
  });

  it('excludes items past the capacity line but still counts them in runTotal', () => {
    // Capacity 30, items 15+15+10 — the first two fit exactly (30), the
    // third overflows. runTotal should be 40.
    const entries: AgendaEntry[] = [session('s', 30), item('a', 15), item('b', 15), item('c', 10)];
    const { containedBy, overflowBy, overflowAmount, used, runTotal } = computeContainment(entries);
    expect(containedBy.get('a')).toBe('s');
    expect(containedBy.get('b')).toBe('s');
    expect(containedBy.has('c')).toBe(false);
    expect(overflowBy.get('c')).toBe('s');
    // First overflowing item, contained prefix uses 30/30; the full
    // duration of 'c' is the protruding remainder.
    expect(overflowAmount.get('c')).toBe(10);
    expect(used.get('s')).toBe(30);
    expect(runTotal.get('s')).toBe(40);
  });

  it('treats items with no duration as 0m and keeps them contained', () => {
    const entries: AgendaEntry[] = [session('s', 30), item('a'), item('b', 10)];
    const { containedBy, used, runTotal } = computeContainment(entries);
    expect(containedBy.get('a')).toBe('s');
    expect(containedBy.get('b')).toBe('s');
    expect(used.get('s')).toBe(10);
    expect(runTotal.get('s')).toBe(10);
  });

  it('stops a session run at the next session header', () => {
    const entries: AgendaEntry[] = [session('s1', 30), item('a', 10), session('s2', 60), item('b', 20)];
    const { containedBy, used } = computeContainment(entries);
    // 'a' belongs to s1, 'b' belongs to s2 — neither crosses the boundary.
    expect(containedBy.get('a')).toBe('s1');
    expect(containedBy.get('b')).toBe('s2');
    expect(used.get('s1')).toBe(10);
    expect(used.get('s2')).toBe(20);
  });

  it('closes the contained prefix at the first overflowing item (does not skip ahead to a smaller one)', () => {
    // Capacity 30, first item 40 is already too big alone, next item 5
    // would fit on its own but must NOT be contained — the prefix is
    // broken at the 40.
    const entries: AgendaEntry[] = [session('s', 30), item('a', 40), item('b', 5)];
    const { containedBy, overflowBy, used, runTotal } = computeContainment(entries);
    expect(containedBy.has('a')).toBe(false);
    expect(containedBy.has('b')).toBe(false);
    expect(overflowBy.get('a')).toBe('s');
    expect(overflowBy.get('b')).toBe('s');
    expect(used.get('s')).toBe(0);
    expect(runTotal.get('s')).toBe(45);
  });

  it('closes the prefix mid-run: later items past an overflow are not contained', () => {
    // Capacity 30, items 10 (fits → used=10), 40 (overflows → prefix
    // closes), 5 (would fit if squeezed, but must be excluded). runTotal
    // reflects the full run for correct overflow display.
    const entries: AgendaEntry[] = [session('s', 30), item('a', 10), item('b', 40), item('c', 5)];
    const { containedBy, overflowBy, overflowAmount, used, runTotal } = computeContainment(entries);
    expect(containedBy.get('a')).toBe('s');
    expect(containedBy.has('b')).toBe(false);
    expect(containedBy.has('c')).toBe(false);
    expect(overflowBy.get('b')).toBe('s');
    expect(overflowBy.get('c')).toBe('s');
    // 'b' straddles the line: 10 fit, 40 contributes (10 + 40 − 30) = 20m.
    // 'c' sits entirely past the closed prefix: its whole 5m is overflow.
    // Sum (20 + 5 = 25) matches runTotal − capacity (55 − 30 = 25).
    expect(overflowAmount.get('b')).toBe(20);
    expect(overflowAmount.get('c')).toBe(5);
    expect(used.get('s')).toBe(10);
    expect(runTotal.get('s')).toBe(55);
  });

  it('does not record overflow for items outside any session run', () => {
    const entries: AgendaEntry[] = [item('a', 10), session('s', 30), item('b', 5)];
    const { overflowBy } = computeContainment(entries);
    expect(overflowBy.has('a')).toBe(false);
    expect(overflowBy.has('b')).toBe(false);
  });

  it('marks every overflow item across two consecutive overflowing sessions', () => {
    // Each session's overflow tail is scoped to its own run; the second
    // session's run starts fresh after the boundary.
    const entries: AgendaEntry[] = [session('s1', 10), item('a', 15), item('b', 5), session('s2', 5), item('c', 20)];
    const { overflowBy } = computeContainment(entries);
    expect(overflowBy.get('a')).toBe('s1');
    expect(overflowBy.get('b')).toBe('s1');
    expect(overflowBy.get('c')).toBe('s2');
  });

  it('handles an item whose own duration exceeds the remaining capacity', () => {
    // Session capacity 20, first item 15 fits (used=15), next item 10
    // would push to 25 — doesn't fit, so remains uncontained but still
    // contributes to runTotal.
    const entries: AgendaEntry[] = [session('s', 20), item('a', 15), item('b', 10)];
    const { containedBy, used, runTotal } = computeContainment(entries);
    expect(containedBy.get('a')).toBe('s');
    expect(containedBy.has('b')).toBe(false);
    expect(used.get('s')).toBe(15);
    expect(runTotal.get('s')).toBe(25);
  });
});

describe('computePastSessions', () => {
  // Fixture: two sessions, s1 covering items a,b (indices 1,2) and s2
  // covering items c,d (indices 4,5).
  const twoSessions: AgendaEntry[] = [
    session('s1', 30),
    item('a', 15),
    item('b', 15),
    session('s2', 30),
    item('c', 15),
    item('d', 15),
  ];

  it('returns an empty set for an empty agenda', () => {
    expect(computePastSessions([], -1, false).size).toBe(0);
  });

  it('marks every session past when the meeting has concluded (past-final)', () => {
    // currentIndex is irrelevant once isPastFinal is set.
    const past = computePastSessions(twoSessions, -1, true);
    expect(past).toEqual(new Set(['s1', 's2']));
  });

  it('marks no session past before the meeting starts (no current item)', () => {
    expect(computePastSessions(twoSessions, -1, false).size).toBe(0);
  });

  it('does not mark a session past while the current item sits within its run', () => {
    // Current item is 'b' (index 2), inside s1's run.
    const past = computePastSessions(twoSessions, 2, false);
    expect(past.has('s1')).toBe(false);
    expect(past.has('s2')).toBe(false);
  });

  it('marks a session past once the current item lies beyond its whole run', () => {
    // Current item is 'c' (index 4), in s2's run — so s1 is entirely behind us.
    const past = computePastSessions(twoSessions, 4, false);
    expect(past.has('s1')).toBe(true);
    expect(past.has('s2')).toBe(false);
  });

  it('does not mark an upcoming session past when the current item precedes its run', () => {
    // Current item is 'a' (index 1), before s2's run — s2 is upcoming.
    const past = computePastSessions(twoSessions, 1, false);
    expect(past.has('s1')).toBe(false);
    expect(past.has('s2')).toBe(false);
  });

  it('treats a session as current (not past) when the current item is in its overflow tail', () => {
    // Capacity 20 with items 15 + 15: 'a' is contained, 'b' overflows. The
    // current item is the overflowing 'b' (index 2) — still within s's run,
    // so the session is current and keeps its indicators.
    const entries: AgendaEntry[] = [session('s', 20), item('a', 15), item('b', 15)];
    expect(computePastSessions(entries, 2, false).has('s')).toBe(false);
  });

  it('marks the last session past once the meeting advances to its final overflow item', () => {
    // Both sessions overflow; current item is the very last item (index 5),
    // which is inside s2's run, so only s1 is past.
    const past = computePastSessions(twoSessions, 5, false);
    expect(past.has('s1')).toBe(true);
    expect(past.has('s2')).toBe(false);
  });
});
