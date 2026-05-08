/**
 * Internal HTTP listener — bound to 127.0.0.1 only.
 *
 * Used to expose privileged tools (currently: Azure app-registration) to the
 * orchestrator agent that runs in this same pod. Never exposed beyond
 * loopback. The route is also gated by `X-Liliput-Internal: <token>` header.
 */

import express from 'express';
import http from 'node:http';
import { createAzureInternalRouter } from './routes/azure.js';
import { logger } from './logger.js';

const DEFAULT_PORT = 5002;

export function startInternalServer(): http.Server | null {
  if (!process.env['LILIPUT_INTERNAL_TOKEN']) {
    logger.info(
      'LILIPUT_INTERNAL_TOKEN not set — internal API listener disabled. Set the env var to enable Azure app-registration tooling.',
    );
    return null;
  }
  const port = parseInt(process.env['LILIPUT_INTERNAL_PORT'] ?? String(DEFAULT_PORT), 10);

  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use(createAzureInternalRouter());

  const server = http.createServer(app);
  server.listen(port, '127.0.0.1', () => {
    logger.info({ port }, '🔒 Liliput internal API listening on 127.0.0.1');
  });
  return server;
}
