import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createProjectsRouter } from '../../src/routes/projects.js';
import { resetStore } from '../../src/stores/task-store.js';
import { RepoCreateError } from '../../src/services/github-repo-service.js';
import type { CreatedRepo } from '../../src/services/github-repo-service.js';

function makeRepo(name: string): CreatedRepo {
  return {
    owner: 'crgarcia12',
    name,
    fullName: `crgarcia12/${name}`,
    htmlUrl: `https://github.com/crgarcia12/${name}`,
    visibility: 'private',
    defaultBranch: 'main',
  };
}

function buildApp(opts: {
  exists?: ReturnType<typeof vi.fn>;
  whoami?: ReturnType<typeof vi.fn>;
  createRepo?: ReturnType<typeof vi.fn>;
  runSpec2cloudInit?: ReturnType<typeof vi.fn>;
  gitClient?: {
    clone: ReturnType<typeof vi.fn>;
    commitAll: ReturnType<typeof vi.fn>;
    push: ReturnType<typeof vi.fn>;
  };
  writeContract?: ReturnType<typeof vi.fn>;
}): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    createProjectsRouter({
      bootstrapDeps: {
        ...(opts.exists ? { exists: opts.exists } : {}),
        ...(opts.whoami ? { whoami: opts.whoami } : {}),
        ...(opts.createRepo ? { createRepo: opts.createRepo } : {}),
        ...(opts.runSpec2cloudInit ? { runSpec2cloudInit: opts.runSpec2cloudInit } : {}),
        ...(opts.gitClient ? { gitClient: opts.gitClient } : {}),
        ...(opts.writeContract ? { writeContract: opts.writeContract } : {}),
      },
      ...(opts.exists ? { exists: opts.exists } : {}),
      ...(opts.whoami ? { whoami: opts.whoami } : {}),
    }),
  );
  return app;
}

beforeEach(() => {
  resetStore();
});

describe('GET /api/projects/check-name', () => {
  it('returns available=false for invalid names without calling GitHub', async () => {
    const exists = vi.fn();
    const whoami = vi.fn();
    const app = buildApp({ exists, whoami });
    const r = await request(app).get('/api/projects/check-name?name=.bad-name');
    expect(r.status).toBe(200);
    expect(r.body.available).toBe(false);
    expect(exists).not.toHaveBeenCalled();
  });

  it('returns available=true when name is valid and not taken', async () => {
    const app = buildApp({
      exists: vi.fn().mockResolvedValue(false),
      whoami: vi.fn().mockResolvedValue('crgarcia12'),
    });
    const r = await request(app).get('/api/projects/check-name?name=fresh-app');
    expect(r.status).toBe(200);
    expect(r.body.available).toBe(true);
    expect(r.body.owner).toBe('crgarcia12');
  });

  it('returns available=false when name is taken', async () => {
    const app = buildApp({
      exists: vi.fn().mockResolvedValue(true),
      whoami: vi.fn().mockResolvedValue('crgarcia12'),
    });
    const r = await request(app).get('/api/projects/check-name?name=existing');
    expect(r.body.available).toBe(false);
    expect(r.body.reason).toMatch(/already exists/);
  });
});

describe('POST /api/projects', () => {
  it('rejects invalid names with 400', async () => {
    const app = buildApp({});
    const r = await request(app)
      .post('/api/projects')
      .send({ name: '.bad', description: 'hello', visibility: 'private' });
    expect(r.status).toBe(400);
    expect(r.body.field).toBe('name');
  });

  it('returns 409 when the repo already exists', async () => {
    const app = buildApp({
      whoami: vi.fn().mockResolvedValue('crgarcia12'),
      exists: vi.fn().mockResolvedValue(true),
    });
    const r = await request(app)
      .post('/api/projects')
      .send({ name: 'existing-app', description: 'hello there', visibility: 'private' });
    expect(r.status).toBe(409);
    expect(r.body.field).toBe('name');
  });

  it('happy path creates a task wired to the new repo', async () => {
    const app = buildApp({
      whoami: vi.fn().mockResolvedValue('crgarcia12'),
      exists: vi.fn().mockResolvedValue(false),
      createRepo: vi.fn().mockResolvedValue(makeRepo('new-app')),
      gitClient: {
        clone: vi.fn().mockResolvedValue({ cwd: '/tmp/fake', branch: 'main' }),
        commitAll: vi.fn().mockResolvedValue(undefined),
        push: vi.fn().mockResolvedValue(undefined),
      },
      runSpec2cloudInit: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '' }),
      writeContract: vi.fn().mockResolvedValue(undefined),
    });

    const r = await request(app)
      .post('/api/projects')
      .send({
        name: 'new-app',
        description: 'Build a Winamp clone in React.',
        visibility: 'private',
      });

    expect(r.status).toBe(201);
    expect(r.body.task).toBeTruthy();
    expect(r.body.task.repository).toBe('crgarcia12/new-app');
    expect(r.body.repository.fullName).toBe('crgarcia12/new-app');
    expect(r.body.partial).toBe(false);
  });

  it('records partial=true when spec2cloud init exits non-zero but still creates the task', async () => {
    const app = buildApp({
      whoami: vi.fn().mockResolvedValue('crgarcia12'),
      exists: vi.fn().mockResolvedValue(false),
      createRepo: vi.fn().mockResolvedValue(makeRepo('partial-app')),
      gitClient: {
        clone: vi.fn().mockResolvedValue({ cwd: '/tmp/fake', branch: 'main' }),
        commitAll: vi.fn().mockRejectedValue(new Error('No changes to commit.')),
        push: vi.fn().mockResolvedValue(undefined),
      },
      runSpec2cloudInit: vi.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'boom' }),
      writeContract: vi.fn().mockResolvedValue(undefined),
    });

    const r = await request(app)
      .post('/api/projects')
      .send({
        name: 'partial-app',
        description: 'Hello world',
        visibility: 'private',
      });

    expect(r.status).toBe(201);
    expect(r.body.partial).toBe(true);
    expect(r.body.warnings.length).toBeGreaterThan(0);
    expect(r.body.task).toBeTruthy();
  });

  it('maps RepoCreateError gh-down to 502', async () => {
    const app = buildApp({
      whoami: vi.fn().mockResolvedValue('crgarcia12'),
      exists: vi.fn().mockResolvedValue(false),
      createRepo: vi.fn().mockRejectedValue(new RepoCreateError('GitHub is down', 502, 'gh-down')),
    });
    const r = await request(app)
      .post('/api/projects')
      .send({ name: 'sad-app', description: 'hello', visibility: 'private' });
    expect(r.status).toBe(502);
  });
});
