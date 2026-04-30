import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { Server as SocketServer } from 'socket.io';
import http from 'node:http';
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
    expect(generator).toHaveBeenCalledWith('My Title', expect.stringContaining('Extra'));
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

  it('should return 404 for nonexistent task', async () => {
    const { app } = buildApp();
    const res = await request(app).delete('/api/tasks/nonexistent');
    expect(res.status).toBe(404);
  });
});
