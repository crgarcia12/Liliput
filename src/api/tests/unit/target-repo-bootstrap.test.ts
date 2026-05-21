/**
 * Tests for target-repo-bootstrap engine.
 *
 * Behavior under test:
 *   - Fast path: target_repos.bootstrap_state='ready' -> no GitHub calls.
 *   - First run: 7 labels ensured + webhook created -> state='ready', webhook 'active'.
 *   - Webhook URL exists already -> 'existing' + no createWebhook call.
 *   - Webhook fails (e.g. 403 admin:repo_hook missing) -> 'polling_fallback'.
 *   - Missing LILIPUT_PUBLIC_URL -> webhook skipped, 'polling_fallback'.
 *   - Label create fails -> bootstrap_state='failed'.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../../src/stores/db.js';
import {
  ensureTargetRepoBootstrapped,
  STATE_MACHINE_LABELS,
} from '../../src/engine/target-repo-bootstrap.js';
import * as targetRepoStore from '../../src/stores/target-repo-store.js';

beforeEach(() => {
  process.env['COPILOT_GITHUB_TOKEN'] = 'tok-bs';
  process.env['LILIPUT_PUBLIC_URL'] = 'https://liliput.example.com';
  process.env['GITHUB_WEBHOOK_SECRET'] = 'wh-secret';
  resetDb();
});

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

function makeFakeFetch(
  handlers: Array<{
    match: (call: Call) => boolean;
    status: number;
    body: unknown;
  }>,
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const bodyStr = typeof init?.body === 'string' ? init.body : '';
    const call: Call = { url, method, body: bodyStr ? JSON.parse(bodyStr) : undefined };
    calls.push(call);
    const handler = handlers.find((h) => h.match(call));
    if (!handler) {
      throw new Error(`Unstubbed call: ${method} ${url}`);
    }
    return new Response(JSON.stringify(handler.body), {
      status: handler.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('ensureTargetRepoBootstrapped', () => {
  it('fast-paths when already ready', async () => {
    targetRepoStore.ensureTargetRepo('o/r');
    targetRepoStore.updateTargetRepo('o/r', { bootstrapState: 'ready', webhookStatus: 'active', webhookId: 42 });

    const { fetchImpl, calls } = makeFakeFetch([]);
    const r = await ensureTargetRepoBootstrapped('o/r', { fetchImpl });

    expect(r.bootstrapState).toBe('ready');
    expect(r.webhookAction).toBe('skipped');
    expect(calls.length).toBe(0);
  });

  it('creates all labels and a fresh webhook on first run', async () => {
    const { fetchImpl, calls } = makeFakeFetch([
      // All label POSTs return 201 created.
      {
        match: (c) => c.method === 'POST' && c.url.endsWith('/labels'),
        status: 201,
        body: { name: 'whatever' },
      },
      // GET hooks returns empty.
      {
        match: (c) => c.method === 'GET' && /\/hooks\?/.test(c.url),
        status: 200,
        body: [],
      },
      // POST hooks returns the new id.
      {
        match: (c) => c.method === 'POST' && /\/hooks$/.test(c.url),
        status: 201,
        body: { id: 1234 },
      },
    ]);

    const r = await ensureTargetRepoBootstrapped('o/r', { fetchImpl });

    expect(r.bootstrapState).toBe('ready');
    expect(r.webhookStatus).toBe('active');
    expect(r.webhookId).toBe(1234);
    expect(r.webhookAction).toBe('created');
    expect(r.labelsCreated).toBe(STATE_MACHINE_LABELS.length);
    expect(r.labelsExisting).toBe(0);

    // Webhook body includes the expected events + URL.
    const hookCreate = calls.find((c) => c.method === 'POST' && /\/hooks$/.test(c.url));
    expect(hookCreate).toBeDefined();
    const body = hookCreate!.body as { config: { url: string; secret: string }; events: string[] };
    expect(body.config.url).toBe('https://liliput.example.com/api/github/webhook');
    expect(body.config.secret).toBe('wh-secret');
    expect(body.events).toEqual(['issues', 'pull_request', 'check_suite', 'check_run']);

    // DB persisted.
    const row = targetRepoStore.getTargetRepo('o/r')!;
    expect(row.bootstrapState).toBe('ready');
    expect(row.webhookStatus).toBe('active');
    expect(row.webhookId).toBe(1234);
  });

  it('detects an existing webhook URL and does not recreate it', async () => {
    const { fetchImpl, calls } = makeFakeFetch([
      { match: (c) => c.method === 'POST' && c.url.endsWith('/labels'), status: 422, body: { errors: [{ code: 'already_exists' }] } },
      {
        match: (c) => c.method === 'GET' && /\/hooks\?/.test(c.url),
        status: 200,
        body: [
          {
            id: 999,
            active: true,
            events: ['issues'],
            config: { url: 'https://liliput.example.com/api/github/webhook' },
          },
        ],
      },
    ]);

    const r = await ensureTargetRepoBootstrapped('o/r', { fetchImpl });

    expect(r.webhookAction).toBe('existing');
    expect(r.webhookId).toBe(999);
    expect(r.labelsExisting).toBe(STATE_MACHINE_LABELS.length);
    expect(r.labelsCreated).toBe(0);
    const hookCreate = calls.find((c) => c.method === 'POST' && /\/hooks$/.test(c.url));
    expect(hookCreate).toBeUndefined();
  });

  it('falls back to polling when webhook creation fails (e.g. token scope)', async () => {
    const { fetchImpl } = makeFakeFetch([
      { match: (c) => c.method === 'POST' && c.url.endsWith('/labels'), status: 201, body: {} },
      { match: (c) => c.method === 'GET' && /\/hooks\?/.test(c.url), status: 200, body: [] },
      { match: (c) => c.method === 'POST' && /\/hooks$/.test(c.url), status: 403, body: { message: 'Resource not accessible' } },
    ]);

    const r = await ensureTargetRepoBootstrapped('o/r', { fetchImpl });

    expect(r.bootstrapState).toBe('ready'); // bootstrap still succeeds!
    expect(r.webhookStatus).toBe('polling_fallback');
    expect(r.webhookAction).toBe('failed');
    expect(r.warnings.some((w) => /Webhook creation failed/.test(w))).toBe(true);
  });

  it('skips webhook + polling-fallback when PUBLIC_URL is missing', async () => {
    delete process.env['LILIPUT_PUBLIC_URL'];
    const { fetchImpl, calls } = makeFakeFetch([
      { match: (c) => c.method === 'POST' && c.url.endsWith('/labels'), status: 201, body: {} },
    ]);
    const r = await ensureTargetRepoBootstrapped('o/r', { fetchImpl });
    expect(r.webhookStatus).toBe('polling_fallback');
    expect(calls.filter((c) => /\/hooks/.test(c.url)).length).toBe(0);
  });

  it('marks bootstrap_state=failed when a label cannot be created', async () => {
    const { fetchImpl } = makeFakeFetch([
      { match: (c) => c.method === 'POST' && c.url.endsWith('/labels'), status: 403, body: { message: 'forbidden' } },
    ]);
    const r = await ensureTargetRepoBootstrapped('o/r', { fetchImpl });
    expect(r.bootstrapState).toBe('failed');
    const row = targetRepoStore.getTargetRepo('o/r')!;
    expect(row.bootstrapState).toBe('failed');
    expect(row.lastError).toMatch(/ensureLabel/);
  });
});
