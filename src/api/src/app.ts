import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { logger } from './logger.js';
import { mapHealthEndpoints } from './routes/health.js';
import { mapChatEndpoints } from './routes/chat.js';
import { mapAuthEndpoints } from './routes/auth.js';
import { mapAdminEndpoints } from './routes/admin.js';
import { clearUsers, addUser, getUserByUsername, deleteUser } from './models/user-store.js';

export function createApp(): express.Express {
  const app = express();

  // Middleware
  app.use(helmet());
  app.use(cors());
  app.use(express.json());
  app.use(cookieParser());
  app.use(pinoHttp({ logger }));

  // Routes
  mapHealthEndpoints(app);
  mapChatEndpoints(app);
  mapAuthEndpoints(app);
  mapAdminEndpoints(app);

  // Test-only: reset endpoint for e2e test isolation
  if (process.env.NODE_ENV !== 'production') {
    app.post('/api/test/reset', (_req, res) => {
      clearUsers();
      res.json({ message: 'Store cleared' });
    });

    app.post('/api/test/create-user', async (req, res) => {
      const { username, password, role, createdAt } = req.body;
      const bcrypt = await import('bcryptjs');
      const crypto = await import('node:crypto');
      const passwordHash = await bcrypt.default.hash(password, 10);
      addUser({
        id: crypto.randomUUID(),
        username,
        passwordHash,
        role: role || 'user',
        createdAt: createdAt ? new Date(createdAt) : new Date(),
      });
      res.json({ message: 'User created' });
    });

    app.get('/api/test/user-hash/:username', (req, res) => {
      const user = getUserByUsername(req.params.username);
      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      res.json({ passwordHash: user.passwordHash });
    });

    app.delete('/api/test/users/:username', (req, res) => {
      const user = getUserByUsername(req.params.username);
      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      deleteUser(user.id);
      res.json({ message: 'User deleted' });
    });
  }

  return app;
}
