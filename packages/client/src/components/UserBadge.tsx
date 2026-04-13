/**
 * Displays a user's GitHub avatar alongside their name and organisation.
 *
 * Avatars are loaded from GitHub via the public URL pattern
 * https://github.com/{username}.png — this works for any valid GitHub
 * username, even in dev mode with mock users (as long as the username
 * matches a real GitHub account).
 *
 * The avatar has a fixed size (via inline style) so it doesn't cause
 * layout reflow when loading or on error. On error, a generic person
 * silhouette fallback is shown instead of hiding the image.
 */

import type { User } from '@tcq/shared';

/**
 * Data URI for a generic person silhouette fallback avatar.
 * Used when the GitHub avatar fails to load (e.g. nonexistent username).
 */
const FALLBACK_AVATAR = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
  '<rect width="32" height="32" rx="16" fill="#d6d3d1"/>' +
  '<circle cx="16" cy="12" r="5" fill="#a8a29e"/>' +
  '<path d="M6,28 Q6,20 16,20 Q26,20 26,28" fill="#a8a29e"/>' +
  '</svg>',
);

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
        // Fixed dimensions prevent layout reflow during loading
        width={size}
        height={size}
        style={{ width: size, height: size, minWidth: size, minHeight: size }}
        className="rounded-full shrink-0"
        // Show a generic fallback avatar on error instead of hiding
        onError={(e) => {
          const img = e.target as HTMLImageElement;
          // Prevent infinite loop if fallback also fails
          if (!img.src.startsWith('data:')) {
            img.src = FALLBACK_AVATAR;
          }
        }}
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
