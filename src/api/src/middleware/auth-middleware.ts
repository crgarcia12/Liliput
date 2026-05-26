import type { Request, Response, NextFunction } from 'express';
import { verifySessionToken } from '../services/auth-service.js';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    username: string;
    role: string;
  };
}

/** Extract JWT from Authorization header or cookies */
function extractToken(req: Request): string | null {
  // Try Authorization header first
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // Try session cookie
  const cookies = req.headers.cookie?.split(';') ?? [];
  for (const cookie of cookies) {
    const [name, value] = cookie.trim().split('=');
    if (name === 'session_token') {
      return decodeURIComponent(value ?? '');
    }
  }

  return null;
}

/** Middleware to verify JWT and attach user to request */
export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): void {
  const token = extractToken(req);

  if (!token) {
    res.status(401).json({ error: 'Unauthorized: missing token' });
    return;
  }

  const session = verifySessionToken(token);
  if (!session) {
    res.status(401).json({ error: 'Unauthorized: invalid token' });
    return;
  }

  req.user = {
    id: session.userId,
    username: session.username,
    role: session.role,
  };

  next();
}

/** Optional auth middleware — doesn't fail if no token, but attaches user if present */
export function optionalAuthMiddleware(
  req: AuthRequest,
  _res: Response,
  next: NextFunction,
): void {
  const token = extractToken(req);

  if (token) {
    const session = verifySessionToken(token);
    if (session) {
      req.user = {
        id: session.userId,
        username: session.username,
        role: session.role,
      };
    }
  }

  next();
}
