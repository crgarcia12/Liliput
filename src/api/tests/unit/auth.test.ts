import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import bcryptjs from 'bcryptjs';
import { createApp } from '../../src/app.js';
import { getDb, resetDb } from '../../src/stores/db.js';
import { generateSessionToken, changePassword } from '../../src/services/auth-service.js';
import { Server as SocketServer } from 'socket.io';
import http from 'http';

// Matches the value set in vitest.config.ts -> env.DEFAULT_ADMIN_PASSWORD.
// Seeded on first boot by ensureDefaultAdminUser().
const SEED_PASSWORD = 'TestPassword-123456';

/** Reset the admin row to a known-good password between tests. */
function resetAdminPassword(): { adminId: string } {
  const db = getDb();
  const row = db
    .prepare('SELECT id FROM users WHERE username = ?')
    .get('admin') as { id: string } | undefined;
  if (!row) throw new Error('admin user not seeded — DB_PATH/DEFAULT_ADMIN_PASSWORD env wrong');
  const hash = bcryptjs.hashSync(SEED_PASSWORD, 4);
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
    hash,
    new Date().toISOString(),
    row.id,
  );
  return { adminId: row.id };
}

describe('Authentication System', () => {
  let app: express.Express;
  let io: SocketServer;
  let server: http.Server;

  beforeAll(() => {
    process.env['DB_PATH'] = ':memory:';
    resetDb();
    server = http.createServer();
    io = new SocketServer(server);
    app = createApp(io, { disableWebhookDispatcher: true });
  });

  afterAll(() => {
    server.close();
    io.close();
  });

  beforeEach(() => {
    // Restore the seed password between tests so rotation tests don't bleed.
    resetAdminPassword();
  });

  describe('POST /api/login', () => {
    it('should login successfully with correct credentials', async () => {
      const res = await request(app).post('/api/login').send({
        username: 'admin',
        password: SEED_PASSWORD,
      });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('token');
      expect(res.body).toHaveProperty('user');
      expect(res.body.user.username).toBe('admin');
      expect(res.body.user.role).toBe('ADMIN');
      expect(res.headers['set-cookie']).toBeDefined();
    });

    it('should fail with incorrect password', async () => {
      const res = await request(app).post('/api/login').send({
        username: 'admin',
        password: 'wrong-password',
      });

      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty('error');
    });

    it('should fail with nonexistent username', async () => {
      const res = await request(app).post('/api/login').send({
        username: 'nonexistent',
        password: 'any-password',
      });

      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty('error');
    });

    it('should fail with missing credentials', async () => {
      const res = await request(app).post('/api/login').send({
        username: 'admin',
      });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });
  });

  describe('Protected routes', () => {
    async function freshToken(): Promise<string> {
      const res = await request(app).post('/api/login').send({
        username: 'admin',
        password: SEED_PASSWORD,
      });
      return res.body.token as string;
    }

    it('should allow access with valid token', async () => {
      const token = await freshToken();
      const res = await request(app)
        .get('/api/agent')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).not.toBe(401);
    });

    it('should deny access without token', async () => {
      const res = await request(app).get('/api/agent');

      expect(res.status).toBe(401);
    });

    it('should deny access with invalid token', async () => {
      const res = await request(app)
        .get('/api/agent')
        .set('Authorization', 'Bearer invalid-token');

      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/health (unauthenticated)', () => {
    it('should allow access without authentication', async () => {
      const res = await request(app).get('/api/health');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('status');
    });
  });

  // ─── /api/auth/verify — gateway auth-probe endpoint ──────────────────
  //
  // Used by the NGINX `auth_request` subrequest. MUST always be 200 or 401
  // (never 304), MUST set Cache-Control: no-store, and MUST accept either
  // a Bearer header or a session_token cookie.
  describe('GET /api/auth/verify', () => {
    async function freshToken(): Promise<string> {
      const res = await request(app).post('/api/login').send({
        username: 'admin',
        password: SEED_PASSWORD,
      });
      return res.body.token as string;
    }

    it('returns 401 with no credentials', async () => {
      const res = await request(app).get('/api/auth/verify');
      expect(res.status).toBe(401);
    });

    it('returns 401 with malformed Authorization header', async () => {
      const res = await request(app)
        .get('/api/auth/verify')
        .set('Authorization', 'NotBearer something');
      expect(res.status).toBe(401);
    });

    it('returns 401 with invalid Bearer token', async () => {
      const res = await request(app)
        .get('/api/auth/verify')
        .set('Authorization', 'Bearer garbage.token.value');
      expect(res.status).toBe(401);
    });

    it('returns 200 with a valid Bearer token', async () => {
      const token = await freshToken();
      const res = await request(app)
        .get('/api/auth/verify')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('returns 200 with a valid session_token cookie', async () => {
      const token = await freshToken();
      const res = await request(app)
        .get('/api/auth/verify')
        .set('Cookie', `session_token=${encodeURIComponent(token)}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('returns 200 even when the request carries If-None-Match (gateway anti-304)', async () => {
      const token = await freshToken();
      const res = await request(app)
        .get('/api/auth/verify')
        .set('Authorization', `Bearer ${token}`)
        .set('If-None-Match', '"some-etag"');
      // Critical: anything other than 200/401 breaks auth_request at the gateway.
      expect(res.status).toBe(200);
    });
  });

  // ─── /api/auth/change-password ───────────────────────────────────────
  describe('POST /api/auth/change-password', () => {
    async function freshToken(): Promise<string> {
      const res = await request(app).post('/api/login').send({
        username: 'admin',
        password: SEED_PASSWORD,
      });
      return res.body.token as string;
    }

    it('returns 401 when called without a token', async () => {
      const res = await request(app)
        .post('/api/auth/change-password')
        .send({ currentPassword: SEED_PASSWORD, newPassword: 'NewPass-2026!' });
      expect(res.status).toBe(401);
    });

    it('returns 401 with an invalid token', async () => {
      const res = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', 'Bearer not-a-real-jwt')
        .send({ currentPassword: SEED_PASSWORD, newPassword: 'NewPass-2026!' });
      expect(res.status).toBe(401);
    });

    it('returns 400 when currentPassword is missing', async () => {
      const token = await freshToken();
      const res = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ newPassword: 'NewPass-2026!' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/missing/i);
    });

    it('returns 400 when newPassword is missing', async () => {
      const token = await freshToken();
      const res = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: SEED_PASSWORD });
      expect(res.status).toBe(400);
    });

    it('returns 400 when fields are empty strings', async () => {
      const token = await freshToken();
      const res = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: '', newPassword: '' });
      expect(res.status).toBe(400);
    });

    it('returns 401 when currentPassword is wrong', async () => {
      const token = await freshToken();
      const res = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({
          currentPassword: 'definitely-not-the-real-password',
          newPassword: 'NewPass-2026!',
        });
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/current password is incorrect/i);
    });

    it('returns 400 when newPassword is shorter than 8 characters', async () => {
      const token = await freshToken();
      const res = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: SEED_PASSWORD, newPassword: 'short' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/at least 8/);
    });

    it('returns 400 when newPassword equals currentPassword', async () => {
      const token = await freshToken();
      const res = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: SEED_PASSWORD, newPassword: SEED_PASSWORD });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/differ/i);
    });

    it('returns 401 when token references a non-existent user (cannot impersonate)', async () => {
      // Construct a JWT for a user-id that does not exist. authMiddleware
      // will accept it (signature is valid) but the route's userId lookup
      // must come from req.user — and changePassword refuses unknown ids.
      const fakeToken = generateSessionToken({
        id: 'ghost-user-id-that-does-not-exist',
        username: 'ghost',
        role: 'ADMIN',
      });
      const res = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${fakeToken}`)
        .send({ currentPassword: SEED_PASSWORD, newPassword: 'NewPass-2026!' });
      expect(res.status).toBe(401);
    });

    it('rotates the password successfully and invalidates the old one on /api/login', async () => {
      const token = await freshToken();
      const newPw = 'BrandNewPass-2026!';

      const change = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: SEED_PASSWORD, newPassword: newPw });
      expect(change.status).toBe(200);
      expect(change.body).toEqual({ ok: true });
      expect(change.headers['cache-control']).toBe('no-store');

      // Old password no longer works.
      const oldLogin = await request(app).post('/api/login').send({
        username: 'admin',
        password: SEED_PASSWORD,
      });
      expect(oldLogin.status).toBe(401);

      // New password works.
      const newLogin = await request(app).post('/api/login').send({
        username: 'admin',
        password: newPw,
      });
      expect(newLogin.status).toBe(200);
      expect(newLogin.body).toHaveProperty('token');
    });

    it('never returns the new password in the response body', async () => {
      const token = await freshToken();
      const newPw = 'Secret-Should-Not-Echo-9876';
      const res = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: SEED_PASSWORD, newPassword: newPw });
      expect(res.status).toBe(200);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(newPw);
      expect(body).not.toContain(SEED_PASSWORD);
    });

    it('stores the new password as a bcrypt hash, not plaintext', async () => {
      const token = await freshToken();
      const newPw = 'BcryptCheck-1234!';
      const res = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: SEED_PASSWORD, newPassword: newPw });
      expect(res.status).toBe(200);

      const db = getDb();
      const row = db
        .prepare('SELECT password_hash FROM users WHERE username = ?')
        .get('admin') as { password_hash: string };
      // bcrypt hashes start with $2a$, $2b$ or $2y$ and are 60 chars long.
      expect(row.password_hash).toMatch(/^\$2[aby]\$\d+\$/);
      expect(row.password_hash.length).toBe(60);
      // Plaintext must not appear anywhere in the stored hash.
      expect(row.password_hash).not.toContain(newPw);
    });

    it('updates users.updated_at on rotation', async () => {
      const db = getDb();
      const before = (
        db.prepare('SELECT updated_at FROM users WHERE username = ?').get('admin') as {
          updated_at: string;
        }
      ).updated_at;

      const token = await freshToken();
      // Force a perceptible gap so updated_at strictly changes.
      await new Promise((r) => setTimeout(r, 10));
      const res = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: SEED_PASSWORD, newPassword: 'UpdatedAtCheck-2026!' });
      expect(res.status).toBe(200);

      const after = (
        db.prepare('SELECT updated_at FROM users WHERE username = ?').get('admin') as {
          updated_at: string;
        }
      ).updated_at;
      expect(after).not.toBe(before);
      expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
    });

    it('supports back-to-back rotations within the same session', async () => {
      const token = await freshToken();
      const pw2 = 'FirstRotation-2026!';
      const pw3 = 'SecondRotation-2026!';

      const r1 = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: SEED_PASSWORD, newPassword: pw2 });
      expect(r1.status).toBe(200);

      // Existing JWT is still valid (stateless) — keep using it.
      const r2 = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: pw2, newPassword: pw3 });
      expect(r2.status).toBe(200);

      // Final login proves the chain landed correctly.
      const login = await request(app).post('/api/login').send({
        username: 'admin',
        password: pw3,
      });
      expect(login.status).toBe(200);
    });
  });

  // ─── Service-level tests for changePassword() ────────────────────────
  // Bypasses HTTP so we can assert on the exact result discriminant.
  describe('changePassword() service', () => {
    let adminId: string;
    beforeEach(() => {
      const r = resetAdminPassword();
      adminId = r.adminId;
    });

    it('returns ok:false reason:user-not-found for unknown user id', async () => {
      const r = await changePassword('nope-' + Date.now(), 'anything', 'NewPass-2026!');
      expect(r).toEqual({ ok: false, reason: 'user-not-found' });
    });

    it('returns ok:false reason:current-password-incorrect for wrong current', async () => {
      const r = await changePassword(adminId, 'definitely-wrong', 'NewPass-2026!');
      expect(r).toEqual({ ok: false, reason: 'current-password-incorrect' });
    });

    it('returns ok:false reason:weak-password for new password < 8 chars', async () => {
      const r = await changePassword(adminId, SEED_PASSWORD, 'short');
      expect(r).toEqual({ ok: false, reason: 'weak-password' });
    });

    it('returns ok:false reason:weak-password for non-string new password', async () => {
      // @ts-expect-error — intentionally bypassing type-checker to assert runtime guard
      const r = await changePassword(adminId, SEED_PASSWORD, undefined);
      expect(r).toEqual({ ok: false, reason: 'weak-password' });
    });

    it('returns ok:true and persists a new bcrypt hash on success', async () => {
      const newPw = 'ServiceLevelPass-2026!';
      const r = await changePassword(adminId, SEED_PASSWORD, newPw);
      expect(r).toEqual({ ok: true });

      const db = getDb();
      const hash = (
        db.prepare('SELECT password_hash FROM users WHERE id = ?').get(adminId) as {
          password_hash: string;
        }
      ).password_hash;
      expect(hash).toMatch(/^\$2[aby]\$\d+\$/);
      // And the new password verifies against it.
      expect(bcryptjs.compareSync(newPw, hash)).toBe(true);
      // The old password no longer verifies.
      expect(bcryptjs.compareSync(SEED_PASSWORD, hash)).toBe(false);
    });
  });
});

