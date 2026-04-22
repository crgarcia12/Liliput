import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

describe('POST /api/auth/login', () => {
  const app = createApp();

  it('should return 200 and set JWT cookie on successful login', async () => {
    // Register a user first
    await request(app)
      .post('/api/auth/register')
      .send({ username: 'loginuser', password: 'securepass123' });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'loginuser', password: 'securepass123' });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Login successful');

    const cookies = res.headers['set-cookie'];
    expect(cookies).toBeDefined();
    expect(cookies.toString()).toMatch(/token=/);
  });

  it('should set JWT cookie with correct security attributes', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ username: 'cookieuser', password: 'securepass123' });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'cookieuser', password: 'securepass123' });

    const cookies = res.headers['set-cookie'];
    expect(cookies).toBeDefined();
    const cookieStr = cookies.toString();
    expect(cookieStr).toMatch(/HttpOnly/i);
    expect(cookieStr).toMatch(/Secure/i);
    expect(cookieStr).toMatch(/SameSite=Strict/i);
    expect(cookieStr).toMatch(/Path=\//);
    expect(cookieStr).toMatch(/Max-Age=86400/);
  });

  it('should return 401 for invalid password', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ username: 'wrongpass', password: 'securepass123' });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'wrongpass', password: 'wrongpassword' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid username or password');
  });

  it('should return 401 for non-existent user', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'nonexistent', password: 'somepassword' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid username or password');
  });

  it('should return 400 when fields are missing', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Username and password are required');
  });
});
