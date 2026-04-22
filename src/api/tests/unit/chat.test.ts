import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

describe('Chat Endpoints', () => {
  const app = createApp();

  it('POST /api/chat/sessions should create a session', async () => {
    const res = await request(app).post('/api/chat/sessions');
    expect(res.status).toBe(201);
    expect(res.body.sessionId).toBeDefined();
  });

  it('POST /api/chat/sessions/:id/messages should require message', async () => {
    const res = await request(app)
      .post('/api/chat/sessions/test-id/messages')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Message is required');
  });

  it('POST /api/chat/sessions/:id/messages should return reply', async () => {
    const res = await request(app)
      .post('/api/chat/sessions/test-id/messages')
      .send({ message: 'Hello' });
    expect(res.status).toBe(200);
    expect(res.body.reply).toBeDefined();
  });
});
