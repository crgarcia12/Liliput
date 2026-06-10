/**
 * /api/profile/agents — per-user agent-model defaults.
 *
 *   GET    /api/profile/agents              → list (auto-seeds cheap defaults)
 *   PUT    /api/profile/agents/:role        → upsert one role
 *   DELETE /api/profile/agents/:role        → reset one role
 *
 * Auth: every route requires `req.user.id` (mounted under the global
 * authMiddleware in app.ts). The role path param is validated against
 * AGENT_CONFIG_ROLES.
 */

import { Router } from 'express';
import type { Response } from 'express';
import type { AuthRequest } from '../middleware/auth-middleware.js';
import {
  AGENT_CONFIG_ROLES,
  type AgentConfigRole,
  type UserAgentDefault,
  type UserAgentDefaultsResponse,
  type UpdateUserAgentDefaultRequest,
} from '../../../shared/types/index.js';
import {
  listDefaults,
  setDefault,
  deleteDefault,
  seedCheapDefaultsIfEmpty,
  type StoredUserDefault,
} from '../stores/user-defaults-store.js';
import { resolveAgentConfig } from '../engine/agent-config.js';
import { logger } from '../logger.js';

function isAgentConfigRole(value: string): value is AgentConfigRole {
  return (AGENT_CONFIG_ROLES as readonly string[]).includes(value);
}

function isReasoningEffort(value: unknown): value is 'low' | 'medium' | 'high' | 'xhigh' {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh';
}

function buildResponse(userId: string, stored: StoredUserDefault[]): UserAgentDefaultsResponse {
  const byRole = new Map(stored.map((s) => [s.role, s]));
  const defaults: UserAgentDefault[] = AGENT_CONFIG_ROLES.map((role) => {
    const pin = byRole.get(role);
    // Resolve with NO task pin — we want the user-level effective config.
    const resolved = resolveAgentConfig({ ownerUserId: userId }, role);
    return {
      role,
      effectiveModel: resolved.model,
      ...(resolved.reasoningEffort ? { effectiveReasoningEffort: resolved.reasoningEffort } : {}),
      pinnedModel: pin?.model ?? null,
      pinnedReasoningEffort: pin?.reasoningEffort ?? null,
      source: resolved.source === 'task' ? 'user' : resolved.source,
    };
  });
  return { defaults };
}

export function createProfileRouter(): Router {
  const router = Router();

  router.get('/api/profile/agents', (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    try {
      seedCheapDefaultsIfEmpty(userId);
      const stored = listDefaults(userId);
      res.json(buildResponse(userId, stored));
    } catch (err) {
      logger.error({ err, userId }, 'GET /api/profile/agents failed');
      res.status(500).json({ error: 'Failed to load agent defaults' });
    }
  });

  router.put('/api/profile/agents/:role', (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const roleParam = req.params['role'];
    const role = typeof roleParam === 'string' ? roleParam : '';
    if (!role || !isAgentConfigRole(role)) {
      res.status(400).json({
        error: 'Invalid role',
        allowed: AGENT_CONFIG_ROLES,
      });
      return;
    }
    const body = (req.body ?? {}) as UpdateUserAgentDefaultRequest;
    if (
      body.reasoningEffort !== undefined &&
      body.reasoningEffort !== null &&
      !isReasoningEffort(body.reasoningEffort)
    ) {
      res.status(400).json({ error: 'Invalid reasoningEffort' });
      return;
    }
    try {
      setDefault(userId, role, {
        model: body.model === undefined ? null : body.model,
        reasoningEffort: body.reasoningEffort === undefined ? null : body.reasoningEffort,
      });
      const stored = listDefaults(userId);
      res.json(buildResponse(userId, stored));
    } catch (err) {
      logger.error({ err, userId, role }, 'PUT /api/profile/agents/:role failed');
      res.status(500).json({ error: 'Failed to save agent default' });
    }
  });

  router.delete('/api/profile/agents/:role', (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const roleParam = req.params['role'];
    const role = typeof roleParam === 'string' ? roleParam : '';
    if (!role || !isAgentConfigRole(role)) {
      res.status(400).json({
        error: 'Invalid role',
        allowed: AGENT_CONFIG_ROLES,
      });
      return;
    }
    try {
      deleteDefault(userId, role);
      const stored = listDefaults(userId);
      res.json(buildResponse(userId, stored));
    } catch (err) {
      logger.error({ err, userId, role }, 'DELETE /api/profile/agents/:role failed');
      res.status(500).json({ error: 'Failed to reset agent default' });
    }
  });

  return router;
}
