import { type Express } from 'express';

export function mapHealthEndpoints(app: Express): void {
  app.get('/health', (_req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
  });

  app.get('/api/info', (_req, res) => {
    res.json({ version: '1.0.0', framework: 'spec2cloud' });
  });
}
