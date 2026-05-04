/**
 * GET /api/workstreams/:id/features — list features for a workstream
 * GET /api/features/:id              — single feature detail
 *
 * Read-only for now. Mutation goes through the engine (decomposer + fan-out
 * in PR-B1+B4). The decomposer creates rows, the engine updates status.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import * as featureStore from '../stores/feature-store.js';
import * as wsStore from '../stores/workstream-store.js';
import { logger } from '../logger.js';

export function createFeaturesRouter(): Router {
  const router = Router();

  router.get(
    '/api/workstreams/:id/features',
    (req: Request, res: Response) => {
      try {
        const id = req.params['id'] as string;
        if (!wsStore.getWorkstream(id)) {
          res.status(404).json({ error: 'Workstream not found' });
          return;
        }
        const features = featureStore.listFeaturesByWorkstream(id);
        res.json({ features });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err: message }, 'Failed to list features');
        res
          .status(500)
          .json({ error: 'Failed to list features', details: message });
      }
    },
  );

  router.get('/api/features/:id', (req: Request, res: Response) => {
    try {
      const feature = featureStore.getFeature(req.params['id'] as string);
      if (!feature) {
        res.status(404).json({ error: 'Feature not found' });
        return;
      }
      res.json({ feature });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, 'Failed to get feature');
      res
        .status(500)
        .json({ error: 'Failed to get feature', details: message });
    }
  });

  return router;
}
