import { describe, it, expect } from 'vitest';

describe('client scaffolding', () => {
  it('can import shared types', async () => {
    const shared = await import('@tcq/shared');
    expect(shared.QUEUE_ENTRY_TYPES).toBeDefined();
    expect(shared.REACTION_TYPES).toHaveLength(6);
  });
});
