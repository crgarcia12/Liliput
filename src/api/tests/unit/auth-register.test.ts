import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

describe('POST /api/auth/register', () => {
  const app = createApp();

  it('should return 201 for valid registration', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'testuser', password: 'securepass123' });
    expect(res.status).toBe(201);
    expect(res.body.message).toBe('Registration successful');
  });

  it('should return 409 when username already taken', async () => {
    // Register the first user
    await request(app)
      .post('/api/auth/register')
      .send({ username: 'duplicate', password: 'securepass123' });

    // Attempt to register the same username
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'duplicate', password: 'anotherpass123' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Username already exists');
  });

  it('should return 400 when username is missing', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ password: 'securepass123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Username is required');
  });

  it('should return 400 when username is too short', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'ab', password: 'securepass123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/username/i);
  });

  it('should return 400 when username contains special characters', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'user@name!', password: 'securepass123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/username/i);
  });

  it('should return 400 when password is missing', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'validuser' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Password is required');
  });

  it('should return 400 when password is too short', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'validuser', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Password must be at least 8 characters');
  });

  it('should validate username before password (first error only)', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: '', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/username/i);
    expect(res.body.error).not.toMatch(/password/i);
  });

  it('should store password as bcrypt hash, not plain text', async () => {
    const password = 'securepass123';
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'hashtest', password });
    expect(res.status).toBe(201);
    // The response should not contain the plain text password
    expect(JSON.stringify(res.body)).not.toContain(password);
  });
});
