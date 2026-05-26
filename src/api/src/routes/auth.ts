import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Server as SocketServer } from 'socket.io';
import { getAuthStatus, subscribeAuthStatus } from '../engine/auth-status.js';
import { probeAuth } from '../engine/spec-generator.js';
import {
  validateCredentials,
  generateSessionToken,
  verifySessionToken,
  changePassword,
} from '../services/auth-service.js';
import { authMiddleware, type AuthRequest } from '../middleware/auth-middleware.js';
import { logger } from '../logger.js';

export function createAuthRouter(io: SocketServer): Router {
  const router = Router();

  // Broadcast every auth status change to all connected clients.
  subscribeAuthStatus((status) => {
    io.emit('auth:status', status);
  });

  // GET /api/auth/status — current cached auth health.
  router.get('/api/auth/status', (_req: Request, res: Response) => {
    res.json(getAuthStatus());
  });

  // POST /api/auth/check — actively probe Copilot to refresh the status.
  router.post('/api/auth/check', (_req: Request, res: Response) => {
    probeAuth()
      .then((status) => res.json(status))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err: message }, 'Auth probe failed');
        res.status(500).json({ error: 'Probe failed', details: message });
      });
  });

  // GET /api/auth/verify — lightweight session validity check used by the
  // NGINX gateway's auth_request. Returns 200 if the cookie / Bearer token
  // is valid, 401 otherwise. Never returns 304: no ETag/Last-Modified and
  // no body that the browser would conditionally cache.
  router.get('/api/auth/verify', (req: Request, res: Response) => {
    const authHeader = req.headers.authorization;
    let token: string | null = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    } else {
      const cookies = req.headers.cookie?.split(';') ?? [];
      for (const cookie of cookies) {
        const [name, value] = cookie.trim().split('=');
        if (name === 'session_token') {
          token = decodeURIComponent(value ?? '');
          break;
        }
      }
    }
    if (!token) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const session = verifySessionToken(token);
    if (!session) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true });
  });

  // POST /api/login — user login with username and password
  router.post('/api/login', async (req: Request, res: Response) => {
    try {
      const { username, password } = req.body as {
        username?: string;
        password?: string;
      };

      if (!username || !password) {
        res.status(400).json({ error: 'Missing username or password' });
        return;
      }

      const user = await validateCredentials(username, password);
      if (!user) {
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }

      const token = generateSessionToken(user);
      const isSecure = process.env['NODE_ENV'] === 'production';

      res
        .setHeader(
          'Set-Cookie',
          `session_token=${encodeURIComponent(token)}; HttpOnly${isSecure ? '; Secure' : ''}; SameSite=Strict; Path=/`,
        )
        .json({
          token,
          user: {
            id: user.id,
            username: user.username,
            role: user.role,
          },
        });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, 'Login failed');
      res.status(500).json({ error: 'Login failed', details: message });
    }
  });

  // POST /api/auth/change-password — authenticated password rotation.
  //
  // This router is mounted before the global authMiddleware, so authMiddleware
  // is applied at the route level for this single endpoint. The handler reads
  // the user id from req.user (set by authMiddleware) — never trusts a userId
  // from the request body — and validates the current password before writing
  // a new bcrypt hash. The plaintext password is never persisted or logged.
  router.post(
    '/api/auth/change-password',
    authMiddleware,
    async (req: AuthRequest, res: Response) => {
      try {
        const { currentPassword, newPassword } = req.body as {
          currentPassword?: string;
          newPassword?: string;
        };

        if (!req.user) {
          res.status(401).json({ error: 'Unauthorized' });
          return;
        }
        if (
          typeof currentPassword !== 'string' ||
          typeof newPassword !== 'string' ||
          currentPassword.length === 0 ||
          newPassword.length === 0
        ) {
          res.status(400).json({ error: 'Missing currentPassword or newPassword' });
          return;
        }
        if (newPassword === currentPassword) {
          res.status(400).json({ error: 'New password must differ from current password' });
          return;
        }

        const result = await changePassword(
          req.user.id,
          currentPassword,
          newPassword,
        );

        if (result.ok) {
          logger.info(
            { userId: req.user.id, username: req.user.username },
            'Password changed',
          );
          res.setHeader('Cache-Control', 'no-store');
          res.status(200).json({ ok: true });
          return;
        }

        if (result.reason === 'current-password-incorrect') {
          res.status(401).json({ error: 'Current password is incorrect' });
          return;
        }
        if (result.reason === 'weak-password') {
          res.status(400).json({
            error: 'New password must be at least 8 characters long',
          });
          return;
        }
        // user-not-found — extremely rare, the token references a deleted user.
        res.status(401).json({ error: 'User no longer exists' });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err: message }, 'Change password failed');
        res.status(500).json({ error: 'Change password failed' });
      }
    },
  );

  return router;
}
