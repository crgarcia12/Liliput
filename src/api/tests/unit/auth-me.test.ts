import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

describe('GET /api/auth/me', () => {
  const app = createApp();

  it('should return 200 with user profile when authenticated', async () => {
    // Register and login
    await request(app)
      .post('/api/auth/register')
      .send({ username: 'meuser', password: 'securepass123' });

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'meuser', password: 'securepass123' });

    const cookies = loginRes.headers['set-cookie'];

    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body.username).toBe('meuser');
    expect(res.body.role).toBeDefined();
    expect(res.body.createdAt).toBeDefined();
  });

  it('should return 401 when not authenticated', async () => {
    const res = await request(app)
      .get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Not authenticated');
  });

  it('should return 401 with expired JWT', async () => {
    // Use a token that has expired (crafted with past expiry)
    const expiredToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VybmFtZSI6InRlc3QiLCJpYXQiOjE2MDAwMDAwMDAsImV4cCI6MTYwMDAwMDAwMX0.invalid';
    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', [`token=${expiredToken}`]);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Not authenticated');
  });

  it('should return 401 with malformed JWT', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', ['token=not-a-valid-jwt']);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Not authenticated');
  });
});
