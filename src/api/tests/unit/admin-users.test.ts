import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

describe('GET /api/admin/users', () => {
  const app = createApp();

  it('should return 200 with user list for admin', async () => {
    // First user registered gets admin role
    await request(app)
      .post('/api/auth/register')
      .send({ username: 'adminuser', password: 'securepass123' });

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'adminuser', password: 'securepass123' });

    const cookies = loginRes.headers['set-cookie'];

    const res = await request(app)
      .get('/api/admin/users')
      .set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0].username).toBeDefined();
    expect(res.body[0].role).toBeDefined();
    expect(res.body[0].createdAt).toBeDefined();
  });

  it('should return 403 for non-admin users', async () => {
    // Register admin (first user)
    await request(app)
      .post('/api/auth/register')
      .send({ username: 'firstadmin', password: 'securepass123' });

    // Register a regular user (second user)
    await request(app)
      .post('/api/auth/register')
      .send({ username: 'regularuser', password: 'securepass123' });

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'regularuser', password: 'securepass123' });

    const cookies = loginRes.headers['set-cookie'];

    const res = await request(app)
      .get('/api/admin/users')
      .set('Cookie', cookies);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden');
  });

  it('should return 401 when not authenticated', async () => {
    const res = await request(app)
      .get('/api/admin/users');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Not authenticated');
  });

  it('should not include passwordHash or id in response', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ username: 'nohashuser', password: 'securepass123' });

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'nohashuser', password: 'securepass123' });

    const cookies = loginRes.headers['set-cookie'];

    const res = await request(app)
      .get('/api/admin/users')
      .set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    for (const user of res.body) {
      expect(user).not.toHaveProperty('passwordHash');
      expect(user).not.toHaveProperty('id');
    }
  });
});
