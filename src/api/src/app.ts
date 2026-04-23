import express from 'express';
import cors from 'cors';
import type { Server as SocketServer } from 'socket.io';
import healthRouter from './routes/health.js';
import { createTasksRouter } from './routes/tasks.js';

export function createApp(io: SocketServer): express.Express {
  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json());

  // Routes
  app.use(healthRouter);
  app.use(createTasksRouter(io));

  return app;
}
