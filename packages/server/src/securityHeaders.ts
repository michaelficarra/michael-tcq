import type { Request, Response, NextFunction } from 'express';

/**
 * Sets security-related response headers on every response.
 *
 * Referrer-Policy `strict-origin-when-cross-origin` means cross-origin
 * navigations only carry the origin (not the full URL) in the Referer header,
 * so a meeting link — whose ID lives in the path — is never leaked to a
 * third-party site a user clicks through to. Same-origin navigations still
 * get the full URL. This matches the modern browser default, but we send it
 * explicitly so the policy holds across older user agents and any proxy that
 * might otherwise strip or alter it.
 *
 * Strict-Transport-Security tells browsers to only ever reach this origin over
 * HTTPS for the next year, defeating SSL-strip downgrade attempts. We only emit
 * it in production: prod sits behind Caddy's auto-HTTPS, whereas dev serves
 * plain HTTP on localhost, where an HSTS pin would wrongly force HTTPS onto
 * every other localhost service the developer runs.
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}
