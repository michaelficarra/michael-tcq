/**
 * Displays a user's avatar alongside their name and organisation.
 *
 * The avatar URL is provider-supplied (`user.avatarUrl`) — GitHub synthesises
 * one from the login, other providers supply their own, and some (e.g. ORCID)
 * supply none. When it's empty or fails to load, a generic person silhouette
 * is shown instead. The avatar has a fixed size (via inline style) so it
 * doesn't cause layout reflow when loading or on error.
 */

import type { User } from '@tcq/shared';
import { userLabel } from '@tcq/shared';

/**
 * Data URI for a generic person silhouette fallback avatar.
 * Used when the GitHub avatar fails to load (e.g. nonexistent username).
 * Exported so other components rendering avatars (e.g. the username
 * combobox's chips) can degrade to the same placeholder.
 */
export const FALLBACK_AVATAR =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
      '<rect width="32" height="32" rx="16" fill="#d6d3d1"/>' +
      '<circle cx="16" cy="12" r="5" fill="#a8a29e"/>' +
      '<path d="M6,28 Q6,20 16,20 Q26,20 26,28" fill="#a8a29e"/>' +
      '</svg>',
  );

interface UserBadgeProps {
  user: User | undefined;
  /** Avatar size in pixels. Defaults to 20. */
  size?: number;
  /** Additional CSS classes for the wrapper. */
  className?: string;
}

export function UserBadge({ user, size = 20, className = '' }: UserBadgeProps) {
  if (!user) {
    return (
      <span className={`inline-flex items-center align-middle gap-1.5 ${className}`}>
        <img
          src={FALLBACK_AVATAR}
          alt=""
          width={size}
          height={size}
          style={{ width: size, height: size, minWidth: size, minHeight: size }}
          className="rounded-full shrink-0"
        />
        <span className="text-stone-600 dark:text-stone-300 italic">unknown</span>
      </span>
    );
  }

  return (
    <span className={`inline-flex items-center align-middle gap-1.5 ${className}`}>
      <img
        // Provider-supplied avatar; fall back to the silhouette when the
        // provider has none (empty string).
        src={user.avatarUrl || FALLBACK_AVATAR}
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
        {/* The display name carries the account identifier AND provider as
            a title so a hover surfaces who this is and where they came from
            (e.g. "Alice Anderson" → "@alice · github"). When the name is
            empty or whitespace-only, fall back to the handle/account id as
            the visible text so the badge never renders an empty label. */}
        <span title={userLabel(user)}>{user.name?.trim() || user.handle || user.accountId}</span>
        {user.isPremium && (
          // Premium-tier verification mark, shown immediately after the
          // display name (verified-account convention). Sized to match
          // the avatar so it carries visual weight in dense lists (queue
          // entries) as well as roomier headers (current speaker).
          <img
            src="/premium.svg"
            alt="Premium"
            title="TCQ Premium™"
            width={size}
            height={size}
            style={{ width: size, height: size }}
            className="premium-badge inline-block align-text-bottom ml-1 shrink-0"
          />
        )}
        {user.organisation && (
          // Organisation gets a fixed max-width and ellipsis so a long
          // company string doesn't make the badge run off the row. The
          // username and display name stay un-truncated — those are the
          // identifying labels and need to be readable in full.
          <span className="text-stone-600 dark:text-stone-300" title={user.organisation}>
            {' ('}
            <span className="inline-block max-w-[12rem] truncate align-bottom">{user.organisation}</span>
            {')'}
          </span>
        )}
      </span>
    </span>
  );
}
