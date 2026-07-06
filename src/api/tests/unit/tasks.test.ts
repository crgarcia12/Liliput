import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { Server as SocketServer } from 'socket.io';
import http from 'node:http';

// Stub repo verification so tests don't need real GitHub access.
vi.mock('../../src/engine/github-pr.js', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    verifyRepositoryAccess: vi.fn(async () => ({ ok: true, defaultBranch: 'main' })),
  };
});

import { createTasksRouter } from '../../src/routes/tasks.js';
import { createWorkstreamsRouter } from '../../src/routes/workstreams.js';
import { resetStore } from '../../src/stores/task-store.js';
import type { SpecGenerator } from '../../src/engine/spec-generator.js';

const FAKE_SPEC = '# Specification: T\n\n## Overview\nMocked spec.';

function buildApp(opts: { specGenerator?: SpecGenerator } = {}): {
  app: express.Express;
  io: SocketServer;
  generator: SpecGenerator;
} {
  const server = http.createServer();
  const io = new SocketServer(server);

  // Stub io.to().emit() so no actual sockets needed
  const emitStub = vi.fn();
  vi.spyOn(io, 'to').mockReturnValue({ emit: emitStub } as never);

  // Default mock generator: resolves immediately with a static spec.
  const generator: SpecGenerator = opts.specGenerator ?? vi.fn(async () => FAKE_SPEC);

  const app = express();
  app.use(express.json());
  // Workstreams router owns DELETE /api/tasks/:id (hard delete with teardown).
  // It must be mounted before the tasks router for route precedence.
  app.use(createWorkstreamsRouter(io));
  app.use(createTasksRouter(io, generator));
  return { app, io, generator };
}

/** Wait for the async spec generator to settle (queued microtasks). */
async function flushAsync(): Promise<void> {
  // Two macrotask hops cover: HTTP response → background promise → store update.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  resetStore();
});

describe('POST /api/tasks', () => {
  it('should create a new task', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/tasks')
      .send({ title: 'My Task', description: 'Build something' });

    expect(res.status).toBe(201);
    expect(res.body.task).toBeDefined();
    expect(res.body.task.title).toBe('My Task');
    expect(res.body.task.status).toBe('clarifying');
    expect(res.body.task.chatHistory).toHaveLength(1); // system welcome
  });

  it('should return 400 when title is missing', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/tasks')
      .send({ description: 'No title' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('should reject loudly when the repository is not accessible', async () => {
    const ghPr = await import('../../src/engine/github-pr.js');
    vi.mocked(ghPr.verifyRepositoryAccess).mockResolvedValueOnce({
      ok: false,
      status: 404,
      reason: 'Repository "crgarcia12/typo" not found.',
    });

    const { app } = buildApp();
    const res = await request(app)
      .post('/api/tasks')
      .send({ title: 'T', description: 'D', repository: 'crgarcia12/typo' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not found');
    expect(res.body.field).toBe('repository');
  });

  it('should accept and persist a valid model id', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/tasks')
      .send({ title: 'T', description: 'D', model: 'gpt-5-mini' });

    expect(res.status).toBe(201);
    expect(res.body.task.model).toBe('gpt-5-mini');
  });

  it('should reject unknown model ids with 400', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/tasks')
      .send({ title: 'T', description: 'D', model: 'imagined-model-7' });

    expect(res.status).toBe(400);
    expect(res.body.field).toBe('model');
  });
});

describe('GET /api/models', () => {
  it('should return the curated model list and default', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/models');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.options)).toBe(true);
    expect(res.body.options.length).toBeGreaterThan(0);
    expect(res.body.default).toBeDefined();
    // default must be one of the options
    const ids = res.body.options.map((m: { id: string }) => m.id);
    expect(ids).toContain(res.body.default);
  });
});

describe('PATCH /api/tasks/:id/model', () => {
  it('should switch a live task to a valid model and emit a system chat message', async () => {
    const { app } = buildApp();
    const created = await request(app)
      .post('/api/tasks')
      .send({ title: 'T', description: 'D', model: 'claude-sonnet-4.5' });
    expect(created.status).toBe(201);
    const id = created.body.task.id as string;

    const res = await request(app)
      .patch(`/api/tasks/${id}/model`)
      .send({ model: 'gpt-5-mini' });
    expect(res.status).toBe(200);
    expect(res.body.task.model).toBe('gpt-5-mini');
    // System message about the switch should be appended
    const last = res.body.task.chatHistory[res.body.task.chatHistory.length - 1];
    expect(last.role).toBe('system');
    expect(last.content).toContain('gpt-5-mini');
  });

  it('should reject unknown models with 400', async () => {
    const { app } = buildApp();
    const created = await request(app).post('/api/tasks').send({ title: 'T', description: 'D' });
    const id = created.body.task.id as string;
    const res = await request(app)
      .patch(`/api/tasks/${id}/model`)
      .send({ model: 'made-up-llm' });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('model');
  });

  it('should 404 when the task does not exist', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .patch('/api/tasks/nonexistent/model')
      .send({ model: 'gpt-5' });
    expect(res.status).toBe(404);
  });

  it('should 400 when model is missing from the body', async () => {
    const { app } = buildApp();
    const created = await request(app).post('/api/tasks').send({ title: 'T', description: 'D' });
    const id = created.body.task.id as string;
    const res = await request(app).patch(`/api/tasks/${id}/model`).send({});
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/tasks/:id/reviewer', () => {
  it('should turn checking off when reviewerModel is cleared', async () => {
    const { app } = buildApp();
    const created = await request(app)
      .post('/api/tasks')
      .send({ title: 'T', description: 'D', reviewerModel: 'gpt-5-mini' });
    expect(created.status).toBe(201);
    expect(created.body.task.reviewerEnabled).toBe(true);
    const id = created.body.task.id as string;

    const res = await request(app)
      .patch(`/api/tasks/${id}/reviewer`)
      .send({ reviewerModel: null });

    expect(res.status).toBe(200);
    expect(res.body.task.reviewerModel).toBeUndefined();
    expect(res.body.task.reviewerEnabled).toBe(false);
  });
});

describe('GET /api/tasks', () => {
  it('should list tasks', async () => {
    const { app } = buildApp();

    await request(app).post('/api/tasks').send({ title: 'A', description: 'a' });
    await request(app).post('/api/tasks').send({ title: 'B', description: 'b' });

    const res = await request(app).get('/api/tasks');
    expect(res.status).toBe(200);
    expect(res.body.tasks).toHaveLength(2);
  });
});

describe('GET /api/tasks/:id', () => {
  it('should get a task by id', async () => {
    const { app } = buildApp();
    const createRes = await request(app)
      .post('/api/tasks')
      .send({ title: 'T', description: 'D' });

    const id = createRes.body.task.id;
    const res = await request(app).get(`/api/tasks/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.task.id).toBe(id);
  });

  it('should return 404 for missing task', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/tasks/nonexistent');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/tasks/:id/chat', () => {
  it('should transition to specifying immediately and produce spec asynchronously', async () => {
    const { app } = buildApp();
    const createRes = await request(app)
      .post('/api/tasks')
      .send({ title: 'T', description: 'D' });

    const id = createRes.body.task.id;
    const res = await request(app)
      .post(`/api/tasks/${id}/chat`)
      .send({ message: 'More details about the feature' });

    expect(res.status).toBe(200);
    expect(res.body.task.status).toBe('specifying');
    // Spec is generated asynchronously — not yet present in the HTTP response.
    expect(res.body.task.spec).toBeUndefined();

    // After awaiting, the mock generator has resolved and the store holds the spec.
    await flushAsync();
    const detailRes = await request(app).get(`/api/tasks/${id}`);
    expect(detailRes.body.task.spec).toBe(FAKE_SPEC);
  });

  it('should call the injected generator with task title + chat context', async () => {
    const generator = vi.fn(async () => FAKE_SPEC);
    const { app } = buildApp({ specGenerator: generator });
    const createRes = await request(app)
      .post('/api/tasks')
      .send({ title: 'My Title', description: 'Original' });

    const id = createRes.body.task.id;
    await request(app).post(`/api/tasks/${id}/chat`).send({ message: 'Extra' });

    await flushAsync();
    expect(generator).toHaveBeenCalledTimes(1);
    expect(generator).toHaveBeenCalledWith(
      'My Title',
      expect.stringContaining('Extra'),
      expect.objectContaining({ taskId: expect.any(String) }),
    );
  });

  it('should report a system error message when spec generation rejects', async () => {
    const generator = vi.fn(async () => {
      throw new Error('boom');
    });
    const { app } = buildApp({ specGenerator: generator });
    const createRes = await request(app)
      .post('/api/tasks')
      .send({ title: 'T', description: 'D' });

    const id = createRes.body.task.id;
    await request(app).post(`/api/tasks/${id}/chat`).send({ message: 'm' });

    await flushAsync();
    const detailRes = await request(app).get(`/api/tasks/${id}`);
    const lastMsg = detailRes.body.task.chatHistory.at(-1);
    expect(lastMsg.content).toMatch(/Spec generation failed/);
  });

  it('should return 400 when message is missing', async () => {
    const { app } = buildApp();
    const createRes = await request(app)
      .post('/api/tasks')
      .send({ title: 'T', description: 'D' });

    const id = createRes.body.task.id;
    const res = await request(app)
      .post(`/api/tasks/${id}/chat`)
      .send({});

    expect(res.status).toBe(400);
  });
});

describe('POST /api/tasks/:id/approve-spec', () => {
  it('should approve spec and start building', async () => {
    const { app } = buildApp();
    const createRes = await request(app)
      .post('/api/tasks')
      .send({ title: 'T', description: 'D', repository: 'https://github.com/example/repo' });

    const id = createRes.body.task.id;

    // Move to specifying first; wait for the async spec to land.
    await request(app)
      .post(`/api/tasks/${id}/chat`)
      .send({ message: 'Details' });
    await flushAsync();

    const res = await request(app).post(`/api/tasks/${id}/approve-spec`);
    expect(res.status).toBe(200);
    expect(res.body.task.status).toBe('building');
    // startBuild spawns the architect agent asynchronously; let it land.
    await flushAsync();
    const detail = await request(app).get(`/api/tasks/${id}`);
    expect(detail.body.task.agents.length).toBeGreaterThan(0);
  });

  it('should return 400 when not in specifying status', async () => {
    const { app } = buildApp();
    const createRes = await request(app)
      .post('/api/tasks')
      .send({ title: 'T', description: 'D' });

    const id = createRes.body.task.id;
    const res = await request(app).post(`/api/tasks/${id}/approve-spec`);
    expect(res.status).toBe(400);
  });

  it('should approve an edited spec passed in the request body', async () => {
    const { app } = buildApp();
    const createRes = await request(app)
      .post('/api/tasks')
      .send({ title: 'T', description: 'D', repository: 'https://github.com/example/repo' });
    const id = createRes.body.task.id;

    await request(app).post(`/api/tasks/${id}/chat`).send({ message: 'Details' });
    await flushAsync();

    const edited = '# Specification: T\n\n## Overview\nEdited by the user.';
    const res = await request(app).post(`/api/tasks/${id}/approve-spec`).send({ spec: edited });
    expect(res.status).toBe(200);
    expect(res.body.task.status).toBe('building');
    expect(res.body.task.spec).toBe(edited);
  });
});

describe('PATCH /api/tasks/:id/spec', () => {
  it('should save an edited spec while specifying', async () => {
    const { app } = buildApp();
    const createRes = await request(app)
      .post('/api/tasks')
      .send({ title: 'T', description: 'D', repository: 'https://github.com/example/repo' });
    const id = createRes.body.task.id;

    await request(app).post(`/api/tasks/${id}/chat`).send({ message: 'Details' });
    await flushAsync();

    const edited = '# Specification: T\n\n## Overview\nManually edited spec.';
    const res = await request(app).patch(`/api/tasks/${id}/spec`).send({ spec: edited });
    expect(res.status).toBe(200);
    expect(res.body.task.spec).toBe(edited);
    expect(res.body.task.status).toBe('specifying');
  });

  it('should return 400 when spec is empty', async () => {
    const { app } = buildApp();
    const createRes = await request(app)
      .post('/api/tasks')
      .send({ title: 'T', description: 'D', repository: 'https://github.com/example/repo' });
    const id = createRes.body.task.id;

    await request(app).post(`/api/tasks/${id}/chat`).send({ message: 'Details' });
    await flushAsync();

    const res = await request(app).patch(`/api/tasks/${id}/spec`).send({ spec: '   ' });
    expect(res.status).toBe(400);
  });

  it('should return 400 when not in specifying status', async () => {
    const { app } = buildApp();
    const createRes = await request(app)
      .post('/api/tasks')
      .send({ title: 'T', description: 'D' });
    const id = createRes.body.task.id;

    const res = await request(app).patch(`/api/tasks/${id}/spec`).send({ spec: 'x' });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/tasks/:id', () => {
  it('should delete a task', async () => {
    const { app } = buildApp();
    const createRes = await request(app)
      .post('/api/tasks')
      .send({ title: 'T', description: 'D' });

    const id = createRes.body.task.id;
    const res = await request(app).delete(`/api/tasks/${id}`);
    expect(res.status).toBe(204);

    const getRes = await request(app).get(`/api/tasks/${id}`);
    expect(getRes.status).toBe(404);
  });

  it('should return 204 for nonexistent task (idempotent delete)', async () => {
    const { app } = buildApp();
    const res = await request(app).delete('/api/tasks/nonexistent');
    expect(res.status).toBe(204);
  });
});
