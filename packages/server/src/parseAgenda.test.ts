import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parseAgendaMarkdown } from './parseAgenda.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Plain-text extraction (formerly the `stripMarkdown` regex helper) now
// lives in `@tcq/shared` as `extractPlainText` and is covered by
// `markdown.test.ts`. Agenda-key emoji prefix stripping is exercised
// indirectly via the parser's end-to-end fixtures.

describe('parseAgendaMarkdown', () => {
  it('returns empty array when no agenda section found', () => {
    expect(parseAgendaMarkdown('# Not an agenda')).toEqual([]);
  });

  it('ignores "Agenda topic rules" and "Agenda key" sections', () => {
    const md = `## Agenda topic rules

1. Proposals not looking to advance may be added at any time.
1. Proposals seeking feedback at stage 0 must be added prior to the deadline.

## Agenda key

| Emoji | Meaning |
| :---: | :--- |
| ❄️ | hard schedule constraints |

## Agenda items

1. Secretary's Report (15m, Samina Husain)
`;
    const items = parseAgendaMarkdown(md);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("Secretary's Report");
  });

  it('parses numbered list items with presenter and duration', () => {
    const md = `## Agenda items

1. Secretary's Report (15m, Samina Husain)
1. Opening, welcome and roll call (Chair, 10m)
`;
    const items = parseAgendaMarkdown(md);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ name: "Secretary's Report", presenters: ['Samina Husain'], duration: 15 });
    expect(items[1]).toEqual({ name: 'Opening, welcome and roll call', presenters: ['Chair'], duration: 10 });
  });

  it('parses numbered list items with multiple comma-separated presenters', () => {
    const md = `## Agenda items

1. Joint Report (15m, Alice, Bob)
1. Co-chaired session (Chair, Co-chair, 20m)
`;
    const items = parseAgendaMarkdown(md);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ name: 'Joint Report', presenters: ['Alice', 'Bob'], duration: 15 });
    expect(items[1]).toEqual({
      name: 'Co-chaired session',
      presenters: ['Chair', 'Co-chair'],
      duration: 20,
    });
  });

  it('supports `&` as a presenter separator (with and without surrounding `,`)', () => {
    const md = `## Agenda items

1. Joint Report (15m, Alice & Bob)
1. Three way (15m, Alice, Bob & Carol)
`;
    const items = parseAgendaMarkdown(md);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ name: 'Joint Report', presenters: ['Alice', 'Bob'], duration: 15 });
    expect(items[1]).toEqual({ name: 'Three way', presenters: ['Alice', 'Bob', 'Carol'], duration: 15 });
  });

  it('supports `and` as a presenter separator (case-insensitive, mixed with `,` and `&`)', () => {
    const md = `## Agenda items

1. Joint Report (15m, Alice and Bob)
1. Oxford and (15m, Alice, Bob, and Carol)
1. Mixed (15m, Alice & Bob and Carol)
1. Capital And (15m, Alice And Bob)
`;
    const items = parseAgendaMarkdown(md);
    expect(items).toHaveLength(4);
    expect(items[0]).toEqual({ name: 'Joint Report', presenters: ['Alice', 'Bob'], duration: 15 });
    expect(items[1]).toEqual({ name: 'Oxford and', presenters: ['Alice', 'Bob', 'Carol'], duration: 15 });
    expect(items[2]).toEqual({ name: 'Mixed', presenters: ['Alice', 'Bob', 'Carol'], duration: 15 });
    expect(items[3]).toEqual({ name: 'Capital And', presenters: ['Alice', 'Bob'], duration: 15 });
  });

  it('does not split presenter names that merely contain the substring `and`', () => {
    // "Anderson", "Sandstone", "Andrew" all contain "and" mid-word — the
    // whitespace-bounded separator rule must leave them intact.
    const md = `## Agenda items

1. Item (15m, Sandra Anderson)
1. Two (15m, Alex Sandstone and Bob Andrew)
`;
    const items = parseAgendaMarkdown(md);
    expect(items).toHaveLength(2);
    expect(items[0].presenters).toEqual(['Sandra Anderson']);
    expect(items[1].presenters).toEqual(['Alex Sandstone', 'Bob Andrew']);
  });

  it('extracts the parenthetical even when it contains a markdown link URL', () => {
    // Real TC39 pattern: a slides link sits *inside* the presenter token,
    // separated from the presenter name with " - ". The inner `)` of the
    // link's URL must not terminate the parenthetical match early.
    const md = `## Agenda items

1. Secretary's Report (15m, Samina Husain - [slides](./tc39-2026-009.pdf))
`;
    const items = parseAgendaMarkdown(md);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("Secretary's Report");
    expect(items[0].duration).toBe(15);
    // Markdown is stripped so the URL doesn't leak into the presenter string.
    expect(items[0].presenters).toEqual(['Samina Husain - slides']);
  });

  it('drops bare-link presenter tokens (slides/notes metadata)', () => {
    // Another real TC39 shape: the slides link is a separate comma-token
    // inside the same parenthetical. It looks syntactically like a
    // presenter, but it's metadata; we filter it out.
    const md = `## Agenda items

1. Secretary's Report (15m, Samina Husain, [slides](./tc39-2024-016.pdf))
`;
    const items = parseAgendaMarkdown(md);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ name: "Secretary's Report", presenters: ['Samina Husain'], duration: 15 });
  });

  it('peels off a trailing slides parenthetical to find the presenter parenthetical', () => {
    // Real TC39 pattern: TWO trailing parentheticals — `(presenter, time)
    // ([slides](url))`. We want the presenter info, not the slides link.
    const md = `## Agenda items

1. Secretary's Report (15m, Samina Husain) ([slides](./tc39-2025-005.pdf))
`;
    const items = parseAgendaMarkdown(md);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ name: "Secretary's Report", presenters: ['Samina Husain'], duration: 15 });
  });

  it('skips a numbered list item with no trailing parenthetical', () => {
    // A bare list item without timing metadata is treated as a section
    // header, not an agenda item — the import pulls in items that have
    // a trailing parenthetical with a time.
    const md = `## Agenda items

1. Project Editors' Reports
`;
    expect(parseAgendaMarkdown(md)).toEqual([]);
  });

  it('skips a numbered list item whose trailing parenthetical has no time', () => {
    // A trailing parenthetical without a duration ("(in insertion order)",
    // "(Jordan Harband)") is decorative metadata, not a timebox — skip.
    const md = `## Agenda items

1. Reminder to review Github Delegate teams (Jordan Harband)
1. Overflow from timeboxed agenda items (in insertion order)
`;
    expect(parseAgendaMarkdown(md)).toEqual([]);
  });

  it('skips structural items like adjournment', () => {
    const md = `## Agenda items

1. Find volunteers for note taking
1. Adoption of the agenda
1. Approval of the minutes from last meeting
1. Next meeting host and logistics
1. Other business
1. Adjournment
1. Secretary's Report (15m, Samina Husain)
`;
    const items = parseAgendaMarkdown(md);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("Secretary's Report");
  });

  it('parses table rows with stage, duration, topic, presenter', () => {
    const md = `## Agenda items

1. Proposals

    | stage | timebox | topic | presenter |
    |:-----:|:-------:|-------|-----------|
    | 3 | 30m | [Temporal](https://github.com/tc39/proposal-temporal) for Stage 4 | Philip Chimento |
    | 2 | 15m | [JSON.parseImmutable](https://github.com/tc39/proposal-json-parseimmutable) update | Peter Klecha |
`;
    const items = parseAgendaMarkdown(md);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      name: '[Temporal](https://github.com/tc39/proposal-temporal) for Stage 4',
      presenters: ['Philip Chimento'],
      duration: 30,
    });
    expect(items[1]).toEqual({
      name: '[JSON.parseImmutable](https://github.com/tc39/proposal-json-parseimmutable) update',
      presenters: ['Peter Klecha'],
      duration: 15,
    });
  });

  it('parses table rows with multiple comma-separated presenters', () => {
    const md = `## Agenda items

1. Proposals

    | stage | timebox | topic | presenter |
    |:-----:|:-------:|-------|-----------|
    | 2 | 30m | Joint Proposal | Alice, Bob |
    | 1 | 15m | With links | [Alice](https://a.example), [Bob](https://b.example) |
    | 2 | 20m | Ampersand | Alice & Bob |
    | 2 | 25m | Mixed separators | Alice, Bob & Carol |
    | 2 | 25m | And separator | Alice and Bob |
    | 2 | 25m | Oxford and | Alice, Bob, and Carol |
    | 2 | 25m | And in name | Sandra Anderson and Bob |
`;
    const items = parseAgendaMarkdown(md);
    expect(items).toHaveLength(7);
    expect(items[0].presenters).toEqual(['Alice', 'Bob']);
    expect(items[1].presenters).toEqual(['Alice', 'Bob']);
    expect(items[2].presenters).toEqual(['Alice', 'Bob']);
    expect(items[3].presenters).toEqual(['Alice', 'Bob', 'Carol']);
    expect(items[4].presenters).toEqual(['Alice', 'Bob']);
    expect(items[5].presenters).toEqual(['Alice', 'Bob', 'Carol']);
    expect(items[6].presenters).toEqual(['Sandra Anderson', 'Bob']);
  });

  it('parses tables without a stage column', () => {
    const md = `## Agenda items

1. Short Timeboxed Discussions

    | timebox | topic | presenter |
    |:-------:|-------|-----------|
    | 30m | Abort Protocol Discussion | James M Snell |
`;
    const items = parseAgendaMarkdown(md);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      name: 'Abort Protocol Discussion',
      presenters: ['James M Snell'],
      duration: 30,
    });
  });

  it('skips empty table rows', () => {
    const md = `## Agenda items

1. Overflow from previous meeting

    | timebox | topic | presenter |
    |:-------:|-------|-----------|

1. Secretary's Report (15m, Samina Husain)
`;
    const items = parseAgendaMarkdown(md);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("Secretary's Report");
  });

  it('preserves markdown links in table cells', () => {
    const md = `## Agenda items

1. Proposals

    | stage | timebox | topic | presenter |
    |:-----:|:-------:|-------|-----------|
    | 0 | 30m | [Iterator Includes](https://github.com/michaelficarra/proposal-iterator-includes) for Stage 1, 2, or 2.7 ([slides](https://example.com)) | Michael Ficarra |
`;
    const items = parseAgendaMarkdown(md);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe(
      '[Iterator Includes](https://github.com/michaelficarra/proposal-iterator-includes) for Stage 1, 2, or 2.7 ([slides](https://example.com))',
    );
    expect(items[0].presenters).toEqual(['Michael Ficarra']);
  });

  it('strips emoji prefixes from agenda items', () => {
    const md = `## Agenda items

1. Proposals

    | stage | timebox | topic | presenter |
    |:-----:|:-------:|-------|-----------|
    | 2 | 15m | ⌛️ [RegExp Buffer Boundaries](https://example.com) for Stage 2.7 | Ron Buckton |
`;
    const items = parseAgendaMarkdown(md);
    expect(items[0].name).toBe('[RegExp Buffer Boundaries](https://example.com) for Stage 2.7');
  });

  it('stops at the next ## heading', () => {
    const md = `## Agenda items

1. Secretary's Report (15m, Samina Husain)

## Schedule constraints

Some constraints here.
`;
    const items = parseAgendaMarkdown(md);
    expect(items).toHaveLength(1);
  });

  it('handles a realistic mixed agenda', () => {
    const md = `## Agenda items

1. Opening, welcome and roll call (Chair, 10m)
1. Find volunteers for note taking
1. Adoption of the agenda
1. Secretary's Report (15m, Samina Husain)
1. Project Editors' Reports
    1. ECMA262 Status Updates (5m, Michael Ficarra)
    1. ECMA402 Status Updates (5m)
1. Task Group Reports
    1. TG3: Security (1m)
1. Updates from the CoC Committee (1m)
1. Proposals

    | stage | timebox | topic | presenter |
    |:-----:|:-------:|-------|-----------|
    | 3 | 90m | [Temporal](https://github.com/tc39/proposal-temporal) for Stage 4 | Philip Chimento |
    | 0 | 30m | [Iterator Includes](https://example.com) for Stage 1 | Michael Ficarra |

1. Longer or open-ended discussions

    | timebox | topic | presenter |
    |:-------:|-------|-----------|
    | 60m | test262 coverage strategies | Richard Gibson |

1. Other business
1. Adjournment
`;
    const items = parseAgendaMarkdown(md);

    // Should include: Opening, Secretary's Report, Project Editors' Reports,
    // Task Group Reports, Updates from CoC, Proposals heading, 2 proposal table rows,
    // Longer discussions heading, 1 discussion table row
    const names = items.map((i) => i.name);

    expect(names).toContain('Opening, welcome and roll call');
    expect(names).toContain("Secretary's Report");
    // The Reports section headers themselves are not agenda items — their
    // nested items are imported as separate agenda items, prefixed with
    // the section header.
    expect(names).not.toContain("Project Editors' Reports");
    expect(names).not.toContain('Task Group Reports');
    expect(names).toContain("Project Editors' Reports: ECMA262 Status Updates");
    expect(names).toContain("Project Editors' Reports: ECMA402 Status Updates");
    expect(names).toContain('Task Group Reports: TG3: Security');
    expect(names).toContain('Updates from the CoC Committee');
    expect(names).toContain('[Temporal](https://github.com/tc39/proposal-temporal) for Stage 4');
    expect(names).toContain('[Iterator Includes](https://example.com) for Stage 1');
    expect(names).toContain('test262 coverage strategies');

    // Should NOT include structural items (no trailing parenthetical with
    // a time, so they're not picked up at all).
    expect(names).not.toContain('Find volunteers for note taking');
    expect(names).not.toContain('Adoption of the agenda');
    expect(names).not.toContain('Other business');
    expect(names).not.toContain('Adjournment');
  });

  it('prepends the parent section name to a nested item with a colon separator', () => {
    // TC39 "Project Editors' Reports" / "Task Group Reports" shape: the
    // section header has no parenthetical, so it isn't itself an agenda
    // item, but each nested entry inherits the section name as a prefix.
    const md = `## Agenda items

1. Project Editors' Reports
    1. ECMA262 Status Updates (10m, Michael Ficarra)
    1. ECMA402 Status Updates (5m)
1. Task Group Reports
    1. TG3: Security (1m)
    1. TG4: Source Maps (5m)
`;
    const items = parseAgendaMarkdown(md);
    expect(items).toEqual([
      { name: "Project Editors' Reports: ECMA262 Status Updates", presenters: ['Michael Ficarra'], duration: 10 },
      { name: "Project Editors' Reports: ECMA402 Status Updates", presenters: [], duration: 5 },
      { name: 'Task Group Reports: TG3: Security', presenters: [], duration: 1 },
      { name: 'Task Group Reports: TG4: Source Maps', presenters: [], duration: 5 },
    ]);
  });

  it('emits both the parent and any nested children that have their own time', () => {
    // TC39 "Opening, welcome and roll call (Chair, 20m)" shape: the
    // outer item has its own timebox so it stays, and children that
    // also carry a time are emitted as prefixed sub-items. Children
    // without a time are dropped.
    const md = `## Agenda items

1. Opening, welcome and roll call (Chair, 20m)
    1. Opening of the meeting
    1. Introduction of attendees
    1. Overview of communication tools (Michael Ficarra, 10m)
    1. Reminder to review Github Delegate teams (Jordan Harband)
`;
    const items = parseAgendaMarkdown(md);
    expect(items).toEqual([
      { name: 'Opening, welcome and roll call', presenters: ['Chair'], duration: 20 },
      {
        name: 'Opening, welcome and roll call: Overview of communication tools',
        presenters: ['Michael Ficarra'],
        duration: 10,
      },
    ]);
  });

  it('chains the prefix through multiple levels of nested ordered lists', () => {
    const md = `## Agenda items

1. Outer
    1. Middle
        1. Inner (5m)
`;
    expect(parseAgendaMarkdown(md)).toEqual([{ name: 'Outer: Middle: Inner', presenters: [], duration: 5 }]);
  });
});

/**
 * Fixture-based regression tests against real TC39 agendas verbatim from
 * https://github.com/tc39/agendas. The parsed output is committed to a
 * snapshot file alongside each fixture; any future parser change that
 * shifts the output for a real-world agenda forces a deliberate snapshot
 * update and a code-review look at the diff.
 *
 * Refresh the fixtures by re-running:
 *   curl -fsSL https://raw.githubusercontent.com/tc39/agendas/refs/heads/main/<year>/<month>.md \
 *     -o packages/server/src/test/fixtures/agendas/<year>-<month>.md
 * and re-running these tests with `vitest -u` to update the snapshots.
 */
describe('parseAgendaMarkdown — TC39 fixture agendas', () => {
  const FIXTURES_DIR = join(__dirname, 'test/fixtures/agendas');
  const fixtures = ['2024-04', '2025-02', '2025-09', '2026-03', '2026-05'];

  it.each(fixtures)('parses %s.md to a stable agenda', async (name) => {
    const md = readFileSync(join(FIXTURES_DIR, `${name}.md`), 'utf8');
    const items = parseAgendaMarkdown(md);

    // Sanity floor: a real TC39 agenda always lists at least a handful of
    // proposals. A drop below this floor signals the section header / table
    // detection has regressed for the fixture's structure.
    expect(items.length).toBeGreaterThan(5);

    // Stable serialisation: 2-space JSON, sorted-stable field order via the
    // explicit shape. Snapshot lives next to the fixture so reviewers see the
    // markdown and parsed result side-by-side.
    const serialised = JSON.stringify(
      items.map((it) => ({ name: it.name, presenters: it.presenters, duration: it.duration ?? null })),
      null,
      2,
    );
    await expect(serialised).toMatchFileSnapshot(join(FIXTURES_DIR, `${name}.parsed.json`));
  });
});
