import { Router } from 'express';
import type { Request, Response } from 'express';
import * as taskStore from '../stores/task-store.js';
import * as workstreamStore from '../stores/workstream-store.js';
import {
  bootstrapProject,
  ProjectBootstrapError,
  type BootstrapDeps,
} from '../services/project-bootstrap.js';
import {
  validateRepoName,
  getAuthenticatedUserLogin,
  repoExists,
  RepoCreateError,
} from '../services/github-repo-service.js';
import { logger } from '../logger.js';

export interface ProjectsRouterDeps {
  /** Allow tests to inject a fully-mocked bootstrap deps bag. */
  bootstrapDeps?: Partial<BootstrapDeps>;
  /** Override the existence-check used by GET /api/projects/check-name. */
  exists?: typeof repoExists;
  /** Override the whoami used by GET /api/projects/check-name. */
  whoami?: typeof getAuthenticatedUserLogin;
}

interface CreateProjectBody {
  name?: string;
  description?: string;
  visibility?: 'public' | 'private';
  initialBranch?: string;
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
}

export function createProjectsRouter(deps: ProjectsRouterDeps = {}): Router {
  const router = Router();

  // POST /api/projects — greenfield: create GitHub repo + spec2cloud init + start task.
  router.post('/api/projects', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as CreateProjectBody;
      logger.info(
        {
          path: '/api/projects',
          name: body.name,
          visibility: body.visibility,
          initialBranch: body.initialBranch,
          model: body.model,
          reasoningEffort: body.reasoningEffort,
          hasDescription: !!body.description,
        },
        'POST /api/projects received',
      );
      const result = await bootstrapProject(
        {
          name: (body.name ?? '').trim(),
          description: body.description ?? '',
          visibility: body.visibility ?? 'private',
          ...(body.initialBranch ? { initialBranch: body.initialBranch.trim() } : {}),
          ...(body.model ? { model: body.model.trim() } : {}),
          ...(body.reasoningEffort ? { reasoningEffort: body.reasoningEffort } : {}),
        },
        {
          taskStore,
          workstreamStore,
          ...deps.bootstrapDeps,
        },
      );
      logger.info(
        { taskId: result.task.id, repo: result.repository.fullName, partial: result.partial },
        'Project created via POST /api/projects',
      );
      res.status(201).json(result);
    } catch (err: unknown) {
      if (err instanceof ProjectBootstrapError) {
        res.status(err.status).json({
          error: err.message,
          ...(err.field ? { field: err.field } : {}),
        });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, 'POST /api/projects failed');
      res.status(500).json({ error: 'Failed to create project', details: message });
    }
  });

  // GET /api/projects/check-name?name=foo — debounced live validation
  // for the create form. Returns { available, reason? }. Never 5xx-noisy
  // to the form: GitHub failures map to `{ available: false, reason: ... }`
  // so the user sees a clear message.
  router.get('/api/projects/check-name', async (req: Request, res: Response) => {
    const raw = (req.query['name'] as string | undefined) ?? '';
    const validation = validateRepoName(raw);
    if (!validation.ok) {
      res.json({ available: false, reason: validation.reason });
      return;
    }
    try {
      const whoami = deps.whoami ?? getAuthenticatedUserLogin;
      const exists = deps.exists ?? repoExists;
      const owner = await whoami();
      const taken = await exists(owner, raw.trim());
      if (taken) {
        res.json({ available: false, reason: `A repo named "${raw.trim()}" already exists under ${owner}.` });
        return;
      }
      res.json({ available: true, owner });
    } catch (err: unknown) {
      if (err instanceof RepoCreateError) {
        res.json({ available: false, reason: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err: message }, 'check-name failed');
      res.json({ available: false, reason: `Could not check name with GitHub: ${message}` });
    }
  });

  return router;
}
