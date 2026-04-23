import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import healthRouter from '../../src/routes/health.js';

function buildApp(): express.Express {
  const app = express();
  app.use(healthRouter);
  return app;
}

describe('GET /api/health', () => {
  it('should return status ok', async () => {
    const res = await request(buildApp()).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', service: 'liliput-api' });
  });
});
