/**
 * GET /api/verdicts — agent verdicts (done/blocked/continue declarations).
 *
 *   GET /api/verdicts                  → all verdicts, newest first
 *   GET /api/verdicts?taskId=<id>     → filter by task
 *   GET /api/tasks/:id/verdicts       → same, RESTful shape
 *   GET /api/tasks/:id/verdicts/latest → single most recent verdict (or 404)
 *
 * Used by the UI (eventually) to surface what an agent declared on its last
 * turn, and to power "blocked tasks" lists for the operator.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { latestVerdictForTask, listVerdicts } from '../stores/verdict-store.js';

export function createVerdictsRouter(): Router {
  const router = Router();

  router.get('/api/verdicts', (req: Request, res: Response) => {
    const taskId = typeof req.query['taskId'] === 'string' ? req.query['taskId'] : undefined;
    res.json({ verdicts: listVerdicts(taskId) });
  });

  router.get('/api/tasks/:id/verdicts', (req: Request, res: Response) => {
    res.json({ verdicts: listVerdicts(req.params['id'] as string) });
  });

  router.get('/api/tasks/:id/verdicts/latest', (req: Request, res: Response) => {
    const v = latestVerdictForTask(req.params['id'] as string);
    if (!v) {
      res.status(404).json({ error: 'no verdict recorded for this task' });
      return;
    }
    res.json({ verdict: v });
  });

  return router;
}
