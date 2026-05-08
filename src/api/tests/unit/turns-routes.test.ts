import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { Server } from 'socket.io';
import { createApp } from '../../src/app.js';
import { resetStore, createTask, addChatMessage } from '../../src/stores/task-store.js';
import * as turnStore from '../../src/stores/turn-store.js';

const io = new Server();
const app = createApp(io);

beforeEach(() => {
  resetStore();
});

describe('turn routes', () => {
  it('GET /api/tasks/:id/turns returns the initial turn after task creation', async () => {
    const t = createTask('My task', 'Build the thing', 'owner/repo');
    const r = await request(app).get(`/api/tasks/${t.id}/turns`);
    expect(r.status).toBe(200);
    expect(r.body.turns.length).toBe(1);
    expect(r.body.turns[0].status).toBe('open');
    expect(r.body.turns[0].userMessage).toBe('Build the thing');
  });

  it('a gulliver chat message opens a new turn and closes the previous one', () => {
    const t = createTask('My task', 'first', 'owner/repo');
    addChatMessage(t.id, 'gulliver', 'second message');
    const turns = turnStore.listTurnsForTask(t.id);
    expect(turns.length).toBe(2);
    // turns ordered ASC by openedAt
    expect(turns[0]!.status).toBe('completed');
    expect(turns[1]!.status).toBe('open');
    expect(turns[1]!.userMessage).toBe('second message');
  });

  it('GET /api/repos/:repo/usage rolls up tokens across workstreams of a repo', async () => {
    const t = createTask('A', 'd', 'crg/foo');
    const turn = turnStore.getCurrentTurn(t.id)!;
    turnStore.recordUsage(turn.id, { inputTokens: 100, outputTokens: 50, calls: 1 });
    const repo = encodeURIComponent('crg/foo');
    const r = await request(app).get(`/api/repos/${repo}/usage`);
    expect(r.status).toBe(200);
    expect(r.body.inputTokens).toBe(100);
    expect(r.body.outputTokens).toBe(50);
    expect(r.body.totalTokens).toBe(150);
  });

  it('GET /api/workstreams/:id/usage rolls up tokens across all turns of a workstream', async () => {
    // Need a real workstream row for the FK
    const wsStore = await import('../../src/stores/workstream-store.js');
    const ws = wsStore.createWorkstream('crg/foo', 'WS1');
    const t = createTask('A', 'd', 'crg/foo', { workstreamId: ws.id });
    const turn = turnStore.getCurrentTurn(t.id)!;
    turnStore.recordUsage(turn.id, { inputTokens: 7, outputTokens: 3, calls: 1 });
    const r = await request(app).get(`/api/workstreams/${ws.id}/usage`);
    expect(r.body.inputTokens).toBe(7);
    expect(r.body.totalTokens).toBe(10);
  });
});
