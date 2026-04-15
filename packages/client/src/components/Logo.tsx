/**
 * TCQ logo — the favicon SVG inline next to the word "TCQ".
 * Used in the navigation bar, home page header, and login page.
 */

interface LogoProps {
  /** Text size class. Defaults to "text-xl sm:text-2xl". */
  className?: string;
}

export function Logo({ className = 'text-xl sm:text-2xl' }: LogoProps) {
  return (
    <span
      className={`${className} font-semibold text-stone-800 dark:text-stone-200 select-none inline-flex items-center gap-1.5`}
    >
      {/* Inline SVG of the stacked speech bubbles favicon */}
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" className="h-[1.1em] w-[1.1em]" aria-hidden="true">
        <rect x="6" y="2" width="22" height="8" rx="3" fill="#f26522" opacity="0.4" />
        <rect x="4" y="11" width="22" height="8" rx="3" fill="#f26522" opacity="0.7" />
        <rect x="2" y="20" width="22" height="8" rx="3" fill="#f26522" />
        <polygon points="6,28 10,28 7,32" fill="#f26522" />
      </svg>
      TCQ
    </span>
  );
}
