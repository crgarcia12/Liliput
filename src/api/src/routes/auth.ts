import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Server as SocketServer } from 'socket.io';
import { getAuthStatus, subscribeAuthStatus } from '../engine/auth-status.js';
import { probeAuth } from '../engine/spec-generator.js';
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

  return router;
}
