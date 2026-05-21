/**
 * Inline SVG icons shared across components.
 *
 * Source: Heroicons (https://heroicons.com), solid 20×20 variants. We
 * inline them so callers can drive `fill` / size via Tailwind classes
 * without an extra HTTP round-trip the way an `<img src=…>` would
 * require, and so they participate in the same dark-mode colour
 * tokens as the rest of the UI.
 */

interface IconProps {
  /** Tailwind classes applied to the `<svg>` element. Defaults to `w-5 h-5`. */
  className?: string;
}

/**
 * Filled circle with an × — the "remove this" affordance shared by the
 * chair pill (AgendaPanel), the presenter-chip combobox (UserCombobox),
 * and the premium-users pill (PremiumUsersPanel). Single source of
 * truth so the three pill variants stay visually consistent.
 */
export function CircleXIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className}>
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z"
        clipRule="evenodd"
      />
    </svg>
  );
}

/**
 * Filled circle with a + — the symmetric "add to this list" affordance
 * used alongside `CircleXIcon` in `AgendaPanel`'s chair list. Kept here
 * so both icons of the add/remove pair live together.
 */
export function CirclePlusIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className}>
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-11.25a.75.75 0 00-1.5 0v2.5h-2.5a.75.75 0 000 1.5h2.5v2.5a.75.75 0 001.5 0v-2.5h2.5a.75.75 0 000-1.5h-2.5v-2.5z"
        clipRule="evenodd"
      />
    </svg>
  );
}

/**
 * Solid downward-pointing chevron used to mark a button as a dropdown
 * trigger. Replaces the ▾ unicode character so the glyph renders
 * identically across platforms (the unicode triangle varied in weight
 * and vertical alignment depending on the OS/font fallback).
 */
export function ChevronDownIcon({ className = 'w-4 h-4' }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className}>
      <path
        fillRule="evenodd"
        d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.24 4.38a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z"
        clipRule="evenodd"
      />
    </svg>
  );
}
