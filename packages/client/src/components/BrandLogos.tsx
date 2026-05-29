/**
 * Brand marks for the login buttons, used solely for the sanctioned
 * "Log in with <provider>" affordance. Mostly single-path monochrome SVGs
 * (24×24) that inherit the button's text colour via `fill="currentColor"`, so
 * each button sets the appropriate contrasting fill. The Google and Microsoft
 * marks are the exceptions: their multi-colour logos carry hard-coded brand
 * fills because both vendors' guidelines forbid recolouring them. Artwork:
 * Simple Icons (CC0) for GitHub/ORCID; Google's and Microsoft's own brand
 * assets for their marks. The GitHub, ORCID, Google, and Microsoft marks are
 * trademarks of their respective owners.
 */

interface MarkProps {
  className?: string;
}

/** GitHub "Octocat" mark. */
export function GitHubMark({ className = 'h-5 w-5' }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

/** ORCID iD mark. */
export function OrcidMark({ className = 'h-5 w-5' }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12 0C5.372 0 0 5.372 0 12s5.372 12 12 12 12-5.372 12-12S18.628 0 12 0zM7.369 4.378c.525 0 .947.431.947.947s-.422.947-.947.947a.95.95 0 0 1-.947-.947c0-.525.422-.947.947-.947zm-.722 3.038h1.444v10.041H6.647V7.416zm3.562 0h3.9c3.712 0 5.344 2.653 5.344 5.025 0 2.578-2.016 5.025-5.325 5.025h-3.919V7.416zm1.444 1.303v7.444h2.297c3.272 0 4.022-2.484 4.022-3.722 0-2.016-1.284-3.722-4.097-3.722h-2.222z" />
    </svg>
  );
}

/**
 * Google "G" mark. Unlike the GitHub and ORCID marks this is the official
 * four-colour logo with hard-coded brand fills — Google's guidelines forbid
 * recolouring it, so it deliberately does NOT use `fill="currentColor"`. Sits
 * on the white "Sign in with Google" button.
 */
export function GoogleMark({ className = 'h-5 w-5' }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path
        fill="#4285F4"
        d="M23.52 12.273c0-.851-.076-1.67-.218-2.455H12v4.642h6.458a5.52 5.52 0 0 1-2.394 3.622v3.01h3.878c2.269-2.088 3.578-5.165 3.578-8.819z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.956-1.075 7.942-2.908l-3.878-3.01c-1.075.72-2.45 1.145-4.064 1.145-3.125 0-5.77-2.11-6.714-4.947H1.276v3.108A11.997 11.997 0 0 0 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.286 14.28a7.213 7.213 0 0 1-.376-2.28c0-.79.136-1.557.376-2.28V6.612H1.276A11.997 11.997 0 0 0 0 12c0 1.936.464 3.768 1.276 5.388l4.01-3.108z"
      />
      <path
        fill="#EA4335"
        d="M12 4.773c1.762 0 3.344.606 4.589 1.795l3.44-3.44C17.952 1.19 15.235 0 12 0A11.997 11.997 0 0 0 1.276 6.612l4.01 3.108C6.23 6.883 8.875 4.773 12 4.773z"
      />
    </svg>
  );
}

/**
 * Microsoft logo — the four coloured squares. Like the Google mark this is the
 * official multi-colour logo with hard-coded brand fills; Microsoft's
 * guidelines forbid recolouring it, so it does NOT use `fill="currentColor"`.
 * Sits on the white "Sign in with Microsoft" button.
 */
export function MicrosoftMark({ className = 'h-5 w-5' }: MarkProps) {
  return (
    <svg viewBox="0 0 23 23" aria-hidden="true" className={className}>
      <rect x="1" y="1" width="10" height="10" fill="#F25022" />
      <rect x="12" y="1" width="10" height="10" fill="#7FBA00" />
      <rect x="1" y="12" width="10" height="10" fill="#00A4EF" />
      <rect x="12" y="12" width="10" height="10" fill="#FFB900" />
    </svg>
  );
}

/**
 * Code-bracket (`</>`) glyph for the dev/mock-auth login button. Not a brand
 * mark — it's a generic "developer" affordance signalling this entry isn't a
 * real OAuth provider. Heroicons solid (MIT).
 */
export function DevMark({ className = 'h-5 w-5' }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M14.447 3.026a.75.75 0 0 1 .527.921l-4.5 16.5a.75.75 0 0 1-1.448-.394l4.5-16.5a.75.75 0 0 1 .921-.527ZM16.72 6.22a.75.75 0 0 1 1.06 0l5.25 5.25a.75.75 0 0 1 0 1.06l-5.25 5.25a.75.75 0 1 1-1.06-1.06L21.44 12l-4.72-4.72a.75.75 0 0 1 0-1.06Zm-9.44 0a.75.75 0 0 1 0 1.06L2.56 12l4.72 4.72a.75.75 0 0 1-1.06 1.06L.97 12.53a.75.75 0 0 1 0-1.06l5.25-5.25a.75.75 0 0 1 1.06 0Z"
      />
    </svg>
  );
}
