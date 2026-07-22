import express from 'express';
import cors from 'cors';
import type { Server as SocketServer } from 'socket.io';
import healthRouter from './routes/health.js';
import { createTasksRouter } from './routes/tasks.js';
import { createAuthRouter } from './routes/auth.js';
import { createAgentRouter } from './routes/agent.js';
import { createWorkstreamsRouter } from './routes/workstreams.js';
import { createToolWishesRouter } from './routes/tool-wishes.js';
import { createVerdictsRouter } from './routes/verdicts.js';
import { createFeaturesRouter } from './routes/features.js';
import { createProjectsRouter } from './routes/projects.js';
import { createProfileRouter } from './routes/profile.js';
import { createTitleSuggestRouter } from './routes/title-suggest.js';
import { createAutonomousCampaignsRouter } from './routes/autonomous-campaigns.js';
import { createGitHubWebhookRouter } from './routes/github-webhook.js';
import { createWebhookDispatcher } from './engine/webhook-dispatcher.js';
import { authMiddleware } from './middleware/auth-middleware.js';
import type { SpecGenerator } from './engine/spec-generator.js';

export interface AppOptions {
  /** Override the spec generator (used by tests to inject a mock). */
  specGenerator?: SpecGenerator;
  /** Override the GitHub webhook secret (tests). */
  githubWebhookSecret?: string;
  /** Disable the real webhook dispatcher (tests use the default no-op). */
  disableWebhookDispatcher?: boolean;
  /** Disable authentication middleware (tests only). */
  disableAuthMiddleware?: boolean;
}

export function createApp(io: SocketServer, options: AppOptions = {}): express.Express {
  const app = express();

  // Middleware
  app.use(cors());

  // GitHub webhook MUST be mounted BEFORE express.json() — HMAC verification
  // requires the raw request body. The webhook router installs its own
  // express.raw() middleware for the /api/github/webhook path only.
  if (options.githubWebhookSecret ?? process.env['GITHUB_WEBHOOK_SECRET']) {
    const dispatcher = options.disableWebhookDispatcher
      ? undefined
      : createWebhookDispatcher(io);
    app.use(
      createGitHubWebhookRouter({
        ...(options.githubWebhookSecret ? { secret: options.githubWebhookSecret } : {}),
        ...(dispatcher ? { dispatcher } : {}),
      }),
    );
  }

  app.use(express.json());

  // Routes
  app.use(healthRouter);
  app.use(createAuthRouter(io));

  // All routes below require authentication (unless disabled for tests)
  if (!options.disableAuthMiddleware) {
    app.use(authMiddleware);
  }

  app.use('/api/agent', createAgentRouter());
  // Workstreams routes register before the tasks router so DELETE /api/tasks/:id
  // (the hard-delete with cleanup) takes precedence over the legacy stub.
  app.use(createWorkstreamsRouter(io));
  app.use(createToolWishesRouter());
  app.use(createVerdictsRouter());
  app.use(createFeaturesRouter());
  app.use(createProjectsRouter());
  app.use(createProfileRouter());
  app.use(createTitleSuggestRouter());
  app.use(createAutonomousCampaignsRouter(io));
  app.use(createTasksRouter(io, options.specGenerator));

  return app;
}
