import type { RequestHandler } from 'express';
import type { User } from '@tcq/shared';

// Extend the express-session types to include our user field.
// This declaration is shared across all server code.
declare module 'express-session' {
  interface SessionData {
    user?: User;
  }
}

/**
 * Mock authentication middleware for development.
 *
 * Automatically sets a fake user on every request's session, so that
 * all API endpoints and Socket.IO connections see an authenticated user.
 * This will be removed when GitHub OAuth is implemented.
 */
export const MOCK_USER: User = {
  ghid: 1,
  ghUsername: 'testuser',
  name: 'Test User',
  organisation: 'Test Org',
};

export const mockAuth: RequestHandler = (req, _res, next) => {
  if (!req.session.user) {
    req.session.user = MOCK_USER;
  }
  next();
};
