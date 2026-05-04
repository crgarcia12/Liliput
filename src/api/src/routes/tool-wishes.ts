/**
 * GET /api/tool-wishes — list of tools agents have asked for.
 *
 * Two views:
 *  - default: aggregated by tool name, most-wished first
 *  - ?raw=1: every individual wish, newest first
 *
 * Operators use this to decide which CLIs to bake into the agent runtime
 * Dockerfile next.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { aggregateToolWishes, listToolWishes } from '../stores/tool-wish-store.js';

export function createToolWishesRouter(): Router {
  const router = Router();

  router.get('/api/tool-wishes', (req: Request, res: Response) => {
    const raw = req.query.raw === '1' || req.query.raw === 'true';
    if (raw) {
      res.json({ wishes: listToolWishes() });
      return;
    }
    res.json({ aggregates: aggregateToolWishes() });
  });

  return router;
}
