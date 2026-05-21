/**
 * Tests for the GitHub webhook receiver — HMAC verification, dedup, and
 * dispatcher contract.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import {
  createGitHubWebhookRouter,
  verifySignature,
  type WebhookDispatcher,
} from '../../src/routes/github-webhook.js';
import { getDb, resetDb } from '../../src/stores/db.js';

const SECRET = 'test-secret';

function sign(body: string, secret = SECRET): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function buildApp(opts: { secret?: string; dispatcher?: WebhookDispatcher } = {}): express.Express {
  const app = express();
  app.use(createGitHubWebhookRouter({ secret: opts.secret ?? SECRET, ...(opts.dispatcher ? { dispatcher: opts.dispatcher } : {}) }));
  return app;
}

describe('verifySignature', () => {
  it('accepts a correct signature', () => {
    const body = Buffer.from('{"hello":"world"}');
    const sig = sign(body.toString());
    expect(verifySignature(SECRET, body, sig)).toBe(true);
  });

  it('rejects a wrong signature', () => {
    const body = Buffer.from('{"hello":"world"}');
    expect(verifySignature(SECRET, body, 'sha256=deadbeef')).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifySignature(SECRET, Buffer.from('x'), undefined)).toBe(false);
  });

  it('rejects a header without sha256= prefix', () => {
    const body = Buffer.from('x');
    const raw = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    expect(verifySignature(SECRET, body, raw)).toBe(false);
  });

  it('is length-safe (does not throw on mismatched lengths)', () => {
    expect(verifySignature(SECRET, Buffer.from('x'), 'sha256=tooshort')).toBe(false);
  });
});

describe('POST /api/github/webhook', () => {
  beforeEach(() => {
    // Ensure the schema is loaded; resetDb wipes data.
    getDb();
    resetDb();
    getDb()
      .exec(`DELETE FROM github_deliveries;`);
  });

  it('returns 401 on signature mismatch', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/github/webhook')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', 'sha256=bad')
      .set('x-github-delivery', 'd1')
      .set('x-github-event', 'issues')
      .send('{"action":"opened"}');
    expect(res.status).toBe(401);
  });

  it('returns 503 when secret is not configured', async () => {
    const app = buildApp({ secret: '' });
    const res = await request(app)
      .post('/api/github/webhook')
      .set('content-type', 'application/json')
      .send('{"action":"opened"}');
    expect(res.status).toBe(503);
  });

  it('returns 400 when delivery or event header is missing', async () => {
    const app = buildApp();
    const body = '{"action":"opened"}';
    const res = await request(app)
      .post('/api/github/webhook')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', sign(body))
      .send(body);
    expect(res.status).toBe(400);
  });

  it('accepts a signed delivery, stores it, and dispatches', async () => {
    const dispatcher = vi.fn();
    const app = buildApp({ dispatcher });
    const body = JSON.stringify({
      action: 'labeled',
      repository: { full_name: 'crgarcia12/widget-shop' },
      issue: { number: 7 },
    });
    const res = await request(app)
      .post('/api/github/webhook')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', sign(body))
      .set('x-github-delivery', 'd-accept')
      .set('x-github-event', 'issues')
      .send(body);
    expect(res.status).toBe(202);

    // Allow the async dispatch microtask to complete.
    await new Promise((r) => setImmediate(r));

    expect(dispatcher).toHaveBeenCalledTimes(1);
    const arg = dispatcher.mock.calls[0]?.[0] as { deliveryId: string; event: string; action: string; repository: string };
    expect(arg.deliveryId).toBe('d-accept');
    expect(arg.event).toBe('issues');
    expect(arg.action).toBe('labeled');
    expect(arg.repository).toBe('crgarcia12/widget-shop');

    const row = getDb()
      .prepare('SELECT delivery_id, status FROM github_deliveries WHERE delivery_id = ?')
      .get('d-accept') as { delivery_id: string; status: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.status).toBe('processed');
  });

  it('dedupes redeliveries of the same delivery_id', async () => {
    const dispatcher = vi.fn();
    const app = buildApp({ dispatcher });
    const body = JSON.stringify({ action: 'opened', repository: { full_name: 'a/b' } });
    const sig = sign(body);

    const first = await request(app)
      .post('/api/github/webhook')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', sig)
      .set('x-github-delivery', 'dup-1')
      .set('x-github-event', 'issues')
      .send(body);
    expect(first.status).toBe(202);
    await new Promise((r) => setImmediate(r));

    const second = await request(app)
      .post('/api/github/webhook')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', sig)
      .set('x-github-delivery', 'dup-1')
      .set('x-github-event', 'issues')
      .send(body);
    expect(second.status).toBe(200);
    expect(second.body.deduplicated).toBe(true);

    // Dispatcher should have run exactly once for this delivery_id.
    expect(dispatcher).toHaveBeenCalledTimes(1);
  });

  it('records dispatcher errors without 5xx-ing the response', async () => {
    const dispatcher: WebhookDispatcher = () => {
      throw new Error('boom');
    };
    const app = buildApp({ dispatcher });
    const body = JSON.stringify({ action: 'opened', repository: { full_name: 'a/b' } });

    const res = await request(app)
      .post('/api/github/webhook')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', sign(body))
      .set('x-github-delivery', 'd-err')
      .set('x-github-event', 'issues')
      .send(body);
    expect(res.status).toBe(202);

    await new Promise((r) => setImmediate(r));

    const row = getDb()
      .prepare('SELECT status, error FROM github_deliveries WHERE delivery_id = ?')
      .get('d-err') as { status: string; error: string | null } | undefined;
    expect(row?.status).toBe('error');
    expect(row?.error).toMatch(/boom/);
  });
});
