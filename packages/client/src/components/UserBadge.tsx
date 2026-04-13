/**
 * Displays a user's GitHub avatar alongside their name and organisation.
 *
 * Avatars are loaded from GitHub via the public URL pattern
 * https://github.com/{username}.png — this works for any valid GitHub
 * username, even in dev mode with mock users (as long as the username
 * matches a real GitHub account).
 */

import type { User } from '@tcq/shared';

interface UserBadgeProps {
  user: User;
  /** Avatar size in pixels. Defaults to 20. */
  size?: number;
  /** Additional CSS classes for the wrapper. */
  className?: string;
}

export function UserBadge({ user, size = 20, className = '' }: UserBadgeProps) {
  return (
    <span className={`inline-flex items-center align-middle gap-1.5 ${className}`}>
      <img
        src={`https://github.com/${user.ghUsername}.png?size=${size * 2}`}
        alt=""
        width={size}
        height={size}
        className="rounded-full shrink-0"
        // Hide the broken image icon if the avatar doesn't load
        // (e.g. username doesn't exist on GitHub)
        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
      />
      <span>
        {user.name}
        {user.organisation && (
          <span className="text-stone-400"> ({user.organisation})</span>
        )}
      </span>
    </span>
  );
}
