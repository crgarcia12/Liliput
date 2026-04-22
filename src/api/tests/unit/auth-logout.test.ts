import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

describe('POST /api/auth/logout', () => {
  const app = createApp();

  it('should return 200 and clear the auth cookie', async () => {
    // Register and login first
    await request(app)
      .post('/api/auth/register')
      .send({ username: 'logoutuser', password: 'securepass123' });

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'logoutuser', password: 'securepass123' });

    const loginCookies = loginRes.headers['set-cookie'];

    const res = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', loginCookies);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Logged out successfully');

    // Cookie should be cleared (Max-Age=0 or Expires in the past)
    const cookies = res.headers['set-cookie'];
    expect(cookies).toBeDefined();
    const cookieStr = cookies.toString();
    expect(cookieStr).toMatch(/token=/);
    expect(cookieStr).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
  });

  it('should return 200 even when not logged in (idempotent)', async () => {
    const res = await request(app)
      .post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Logged out successfully');
  });
});
