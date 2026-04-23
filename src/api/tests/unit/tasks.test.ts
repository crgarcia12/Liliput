import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { Server as SocketServer } from 'socket.io';
import http from 'node:http';
import { createTasksRouter } from '../../src/routes/tasks.js';
import { resetStore } from '../../src/stores/task-store.js';

function buildApp(): { app: express.Express; io: SocketServer } {
  const server = http.createServer();
  const io = new SocketServer(server);

  // Stub io.to().emit() so no actual sockets needed
  const emitStub = vi.fn();
  vi.spyOn(io, 'to').mockReturnValue({ emit: emitStub } as never);

  const app = express();
  app.use(express.json());
  app.use(createTasksRouter(io));
  return { app, io };
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
  it('should send a chat message and transition to specifying', async () => {
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
    expect(res.body.task.spec).toBeDefined();
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
      .send({ title: 'T', description: 'D' });

    const id = createRes.body.task.id;

    // Move to specifying first
    await request(app)
      .post(`/api/tasks/${id}/chat`)
      .send({ message: 'Details' });

    const res = await request(app).post(`/api/tasks/${id}/approve-spec`);
    expect(res.status).toBe(200);
    expect(res.body.task.status).toBe('building');
    expect(res.body.task.agents.length).toBeGreaterThan(0);
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
