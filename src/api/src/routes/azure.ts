/**
 * Internal-only Azure routes.
 *
 * Mounted on a separate listener bound to 127.0.0.1 (see internal-server.ts)
 * and protected by an `X-Liliput-Internal: <token>` header. Only the
 * orchestrator agent — which runs in this same pod — can reach it.
 */

import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import {
  ensureAppRegistration,
  DEFAULT_ROLE_ALIASES,
} from '../engine/azure-app-registration.js';
import { logger } from '../logger.js';

function requireInternalToken(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env['LILIPUT_INTERNAL_TOKEN'];
  if (!expected) {
    res.status(503).json({ error: 'Internal API not configured (LILIPUT_INTERNAL_TOKEN unset)' });
    return;
  }
  const got = (req.header('x-liliput-internal') ?? '').trim();
  if (!got || got.length !== expected.length) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  // constant-time compare
  if (!timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

export function createAzureInternalRouter(): Router {
  const router = Router();
  router.use(requireInternalToken);

  router.post('/api/azure/app-registration/ensure', (req: Request, res: Response): void => {
    const body = req.body as Partial<{
      repo: string;
      namespace: string;
      roleAliases: string[];
      scope: string;
      extraSecretData: Record<string, string>;
      forceRotate: boolean;
    }>;
    if (!body || typeof body.repo !== 'string' || typeof body.namespace !== 'string') {
      res.status(400).json({ error: 'repo and namespace are required (strings)' });
      return;
    }

    const opts = {
      repo: body.repo,
      namespace: body.namespace,
      ...(body.roleAliases ? { roleAliases: body.roleAliases } : {}),
      ...(body.scope ? { scope: body.scope } : {}),
      ...(body.extraSecretData ? { extraSecretData: body.extraSecretData } : {}),
      ...(body.forceRotate ? { forceRotate: body.forceRotate } : {}),
    };

    ensureAppRegistration(opts)
      .then((result) => {
        // Audit log — never include the secret value.
        logger.info(
          {
            repo: opts.repo,
            namespace: opts.namespace,
            appId: result.appId,
            rotated: result.rotated,
            rolesAssigned: result.rolesAssigned,
            expiresAt: result.expiresAt,
          },
          'azure.app-registration.ensure: success',
        );
        res.json(result);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(
          { err: message, repo: opts.repo, namespace: opts.namespace },
          'azure.app-registration.ensure: failed',
        );
        res.status(500).json({ error: 'app-registration ensure failed', details: message });
      });
  });

  router.get('/api/azure/app-registration/roles', (_req: Request, res: Response): void => {
    res.json({ defaults: DEFAULT_ROLE_ALIASES, supported: DEFAULT_ROLE_ALIASES });
  });

  return router;
}
