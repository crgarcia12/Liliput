import { Router } from 'express';
import type { Request, Response } from 'express';

const router = Router();

router.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'liliput-api' });
});

export default router;
