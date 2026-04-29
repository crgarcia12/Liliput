import { Router } from 'express';
import type { Request, Response } from 'express';

const router = Router();

// Bump this manually when you want to verify a deploy went out.
// The web frontend reads this from /api/health and displays "BE x.y.z" in the footer.
export const BACKEND_VERSION = '0.0.6';

router.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'liliput-api', version: BACKEND_VERSION });
});

export default router;
