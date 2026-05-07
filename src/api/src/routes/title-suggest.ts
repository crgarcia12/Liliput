import { Router, type Request, type Response } from 'express';
import { suggestTitle } from '../engine/title-suggest.js';
import { logger } from '../logger.js';

/**
 * POST /api/title-suggest { input: string } -> { title: string }
 *
 * Asks a cheap LLM for a 1-4 word Title-Case label for the given user prompt.
 * Used by the new-workstream form to keep the workstreams list readable.
 * Always returns a title — falls back to a heuristic on LLM failure.
 */
export function createTitleSuggestRouter(): Router {
  const router = Router();
  router.post('/api/title-suggest', async (req: Request, res: Response) => {
    const input = typeof req.body?.input === 'string' ? req.body.input : '';
    if (!input.trim()) {
      res.status(400).json({ error: 'input is required' });
      return;
    }
    try {
      const title = await suggestTitle(input);
      res.json({ title });
    } catch (err) {
      // suggestTitle is best-effort and shouldn't throw, but defend in depth.
      const m = err instanceof Error ? err.message : String(err);
      logger.warn({ err: m }, 'title-suggest route failed');
      res.json({ title: 'New Workstream' });
    }
  });
  return router;
}
