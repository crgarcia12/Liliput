import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { Server } from 'socket.io';
import { createApp } from '../../src/app.js';
import { resetStore, createTask } from '../../src/stores/task-store.js';
import { recordVerdict } from '../../src/stores/verdict-store.js';

const io = new Server();
const app = createApp(io);

beforeEach(() => {
  resetStore();
});

describe('verdict routes', () => {
  it('GET /api/verdicts returns empty when none recorded', async () => {
    const r = await request(app).get('/api/verdicts');
    expect(r.status).toBe(200);
    expect(r.body.verdicts).toEqual([]);
  });

  it('GET /api/verdicts returns all newest first', async () => {
    const t = createTask({ title: 'T', description: 'D' });
    recordVerdict(t.id, 'a1', 'continue', 'a', null);
    recordVerdict(t.id, 'a1', 'done', 'b', null);
    const r = await request(app).get('/api/verdicts');
    expect(r.body.verdicts).toHaveLength(2);
    expect(r.body.verdicts[0].status).toBe('done');
  });

  it('GET /api/verdicts?taskId filters by task', async () => {
    const t1 = createTask({ title: 'T1', description: 'D' });
    const t2 = createTask({ title: 'T2', description: 'D' });
    recordVerdict(t1.id, null, 'done', null, null);
    recordVerdict(t2.id, null, 'continue', null, null);
    const r = await request(app).get(`/api/verdicts?taskId=${t1.id}`);
    expect(r.body.verdicts).toHaveLength(1);
    expect(r.body.verdicts[0].status).toBe('done');
  });

  it('GET /api/tasks/:id/verdicts returns task verdicts', async () => {
    const t = createTask({ title: 'T', description: 'D' });
    recordVerdict(t.id, null, 'blocked', 'no creds', null);
    const r = await request(app).get(`/api/tasks/${t.id}/verdicts`);
    expect(r.body.verdicts).toHaveLength(1);
    expect(r.body.verdicts[0].reason).toBe('no creds');
  });

  it('GET /api/tasks/:id/verdicts/latest returns most recent', async () => {
    const t = createTask({ title: 'T', description: 'D' });
    recordVerdict(t.id, null, 'continue', null, null);
    recordVerdict(t.id, null, 'done', 'wrap', null);
    const r = await request(app).get(`/api/tasks/${t.id}/verdicts/latest`);
    expect(r.status).toBe(200);
    expect(r.body.verdict.status).toBe('done');
  });

  it('GET /api/tasks/:id/verdicts/latest returns 404 when none', async () => {
    const t = createTask({ title: 'T', description: 'D' });
    const r = await request(app).get(`/api/tasks/${t.id}/verdicts/latest`);
    expect(r.status).toBe(404);
  });
});
