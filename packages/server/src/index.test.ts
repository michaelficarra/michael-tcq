import { describe, it, expect } from 'vitest';

describe('server scaffolding', () => {
  it('can import shared types', async () => {
    const shared = await import('@tcq/shared');
    expect(shared.QUEUE_ENTRY_TYPES).toContain('topic');
    expect(shared.QUEUE_ENTRY_TYPES).toContain('point-of-order');
  });

  it('has correct queue entry priority ordering', async () => {
    const { QUEUE_ENTRY_PRIORITY } = await import('@tcq/shared');
    expect(QUEUE_ENTRY_PRIORITY['point-of-order']).toBeLessThan(QUEUE_ENTRY_PRIORITY.question);
    expect(QUEUE_ENTRY_PRIORITY.question).toBeLessThan(QUEUE_ENTRY_PRIORITY.reply);
    expect(QUEUE_ENTRY_PRIORITY.reply).toBeLessThan(QUEUE_ENTRY_PRIORITY.topic);
  });
});
