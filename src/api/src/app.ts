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
import { createTitleSuggestRouter } from './routes/title-suggest.js';
import { createGitHubWebhookRouter } from './routes/github-webhook.js';
import type { SpecGenerator } from './engine/spec-generator.js';

export interface AppOptions {
  /** Override the spec generator (used by tests to inject a mock). */
  specGenerator?: SpecGenerator;
  /** Override the GitHub webhook secret (tests). */
  githubWebhookSecret?: string;
}

export function createApp(io: SocketServer, options: AppOptions = {}): express.Express {
  const app = express();

  // Middleware
  app.use(cors());

  // GitHub webhook MUST be mounted BEFORE express.json() — HMAC verification
  // requires the raw request body. The webhook router installs its own
  // express.raw() middleware for the /api/github/webhook path only.
  if (options.githubWebhookSecret ?? process.env['GITHUB_WEBHOOK_SECRET']) {
    app.use(
      createGitHubWebhookRouter(
        options.githubWebhookSecret ? { secret: options.githubWebhookSecret } : {},
      ),
    );
  }

  app.use(express.json());

  // Routes
  app.use(healthRouter);
  app.use(createAuthRouter(io));
  app.use('/api/agent', createAgentRouter());
  // Workstreams routes register before the tasks router so DELETE /api/tasks/:id
  // (the hard-delete with cleanup) takes precedence over the legacy stub.
  app.use(createWorkstreamsRouter(io));
  app.use(createToolWishesRouter());
  app.use(createVerdictsRouter());
  app.use(createFeaturesRouter());
  app.use(createProjectsRouter());
  app.use(createTitleSuggestRouter());
  app.use(createTasksRouter(io, options.specGenerator));

  return app;
}
