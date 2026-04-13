/**
 * Authentication middleware for protecting API routes.
 *
 * Returns 401 if the request has no authenticated user in the session.
 * Used on /api/* routes to ensure only logged-in users can access them.
 */

import type { RequestHandler } from 'express';
import './session.js';

export const requireAuth: RequestHandler = (req, res, next) => {
  if (!req.session.user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  next();
};
