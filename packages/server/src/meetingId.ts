/**
 * Generates memorable, human-readable meeting IDs using the `human-id` library.
 *
 * IDs look like "plain-cobras-rule" or "eleven-chefs-kneel" — three lowercase
 * words separated by hyphens. The library has a large enough word pool
 * (15M+ combinations) that collisions are vanishingly unlikely.
 */

import { humanId } from 'human-id';

/** Generate a single candidate ID. */
function generate(): string {
  return humanId({ separator: '-', capitalize: false });
}

/**
 * Generate a meeting ID that doesn't collide with any existing meeting.
 *
 * The `isCollision` callback should return true if a meeting with the
 * given ID already exists. In practice, collisions are extremely unlikely
 * with 15M+ combinations, but we check anyway.
 */
export function generateMeetingId(isCollision: (id: string) => boolean): string {
  // Try up to a reasonable number of times (defensive; collisions are near-impossible)
  for (let i = 0; i < 10; i++) {
    const id = generate();
    if (!isCollision(id)) {
      return id;
    }
  }

  // Should never be reached in practice
  throw new Error('Failed to generate a unique meeting ID after 10 attempts');
}
