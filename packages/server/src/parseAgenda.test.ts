import { describe, it, expect } from 'vitest';
import { parseAgendaMarkdown, stripMarkdown } from './parseAgenda.js';

describe('stripMarkdown', () => {
  it('strips markdown links', () => {
    expect(stripMarkdown('[text](https://example.com)')).toBe('text');
  });

  it('strips bold', () => {
    expect(stripMarkdown('**bold text**')).toBe('bold text');
  });

  it('strips italic', () => {
    expect(stripMarkdown('*italic text*')).toBe('italic text');
  });

  it('strips inline code', () => {
    expect(stripMarkdown('`code`')).toBe('code');
  });

  it('strips HTML tags', () => {
    expect(stripMarkdown('<sub>Note</sub>')).toBe('Note');
  });

  it('strips agenda key emoji', () => {
    expect(stripMarkdown('❄️ Hard constraint item')).toBe('Hard constraint item');
    expect(stripMarkdown('⌛️ Late addition')).toBe('Late addition');
  });

  it('handles combined formatting', () => {
    expect(stripMarkdown('[**bold link**](url) and *italic*')).toBe('bold link and italic');
  });
});

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

  it('parses numbered list items with presenter and timebox', () => {
    const md = `## Agenda items

1. Secretary's Report (15m, Samina Husain)
1. Opening, welcome and roll call (Chair, 10m)
`;
    const items = parseAgendaMarkdown(md);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ name: "Secretary's Report", presenter: 'Samina Husain', timebox: 15 });
    expect(items[1]).toEqual({ name: 'Opening, welcome and roll call', presenter: 'Chair', timebox: 10 });
  });

  it('parses numbered list items without parenthetical', () => {
    const md = `## Agenda items

1. Project Editors' Reports
`;
    const items = parseAgendaMarkdown(md);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ name: "Project Editors' Reports", presenter: '', timebox: undefined });
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

  it('parses table rows with stage, timebox, topic, presenter', () => {
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
      presenter: 'Philip Chimento',
      timebox: 30,
    });
    expect(items[1]).toEqual({
      name: '[JSON.parseImmutable](https://github.com/tc39/proposal-json-parseimmutable) update',
      presenter: 'Peter Klecha',
      timebox: 15,
    });
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
      presenter: 'James M Snell',
      timebox: 30,
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
    expect(items[0].presenter).toBe('Michael Ficarra');
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
    expect(names).toContain("Project Editors' Reports");
    expect(names).toContain('Task Group Reports');
    expect(names).toContain('Updates from the CoC Committee');
    expect(names).toContain('[Temporal](https://github.com/tc39/proposal-temporal) for Stage 4');
    expect(names).toContain('[Iterator Includes](https://example.com) for Stage 1');
    expect(names).toContain('test262 coverage strategies');

    // Should NOT include structural items
    expect(names).not.toContain('Find volunteers for note taking');
    expect(names).not.toContain('Adoption of the agenda');
    expect(names).not.toContain('Other business');
    expect(names).not.toContain('Adjournment');
  });
});
