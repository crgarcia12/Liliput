import express from 'express';
import cors from 'cors';
import type { Server as SocketServer } from 'socket.io';
import healthRouter from './routes/health.js';
import { createTasksRouter } from './routes/tasks.js';
import { createAuthRouter } from './routes/auth.js';
import type { SpecGenerator } from './engine/spec-generator.js';

export interface AppOptions {
  /** Override the spec generator (used by tests to inject a mock). */
  specGenerator?: SpecGenerator;
}

export function createApp(io: SocketServer, options: AppOptions = {}): express.Express {
  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json());

  // Routes
  app.use(healthRouter);
  app.use(createAuthRouter(io));
  app.use(createTasksRouter(io, options.specGenerator));

  return app;
}
