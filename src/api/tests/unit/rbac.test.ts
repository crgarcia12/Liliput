import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

describe('Role-Based Access Control — role assignment', () => {
  it('should assign admin role to the first registered user', async () => {
    const app = createApp();

    await request(app)
      .post('/api/auth/register')
      .send({ username: 'firstuser', password: 'securepass123' });

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'firstuser', password: 'securepass123' });

    const cookies = loginRes.headers['set-cookie'];

    const meRes = await request(app)
      .get('/api/auth/me')
      .set('Cookie', cookies);
    expect(meRes.status).toBe(200);
    expect(meRes.body.role).toBe('admin');
  });

  it('should assign user role to subsequent registered users', async () => {
    const app = createApp();

    // First user gets admin
    await request(app)
      .post('/api/auth/register')
      .send({ username: 'admin1', password: 'securepass123' });

    // Second user should get 'user' role
    await request(app)
      .post('/api/auth/register')
      .send({ username: 'regular1', password: 'securepass123' });

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'regular1', password: 'securepass123' });

    const cookies = loginRes.headers['set-cookie'];

    const meRes = await request(app)
      .get('/api/auth/me')
      .set('Cookie', cookies);
    expect(meRes.status).toBe(200);
    expect(meRes.body.role).toBe('user');
  });
});
