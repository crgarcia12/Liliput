/**
 * Tests for the loop reconciler — polling fallback for missed webhooks.
 *
 * We don't exercise the timer (that's a wiring concern). We exercise
 * `reconcileTargetRepo` end-to-end with a fetch stub and injected
 * `spawnDevTask` / `runRmReview` spies.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetDb } from '../../src/stores/db.js';
import * as workstreamStore from '../../src/stores/workstream-store.js';
import * as featureStore from '../../src/stores/feature-store.js';
import * as targetRepoStore from '../../src/stores/target-repo-store.js';
import { reconcileTargetRepo, reconcileAllRepos } from '../../src/engine/loop-reconciler.js';

beforeEach(() => {
  resetDb();
  process.env['GITHUB_TOKEN'] = 'test-token';
});

interface RouteHandler {
  match: (method: string, url: string) => boolean;
  respond: (req: { method: string; url: string; body?: unknown }) => {
    status: number;
    body?: unknown;
  };
}

function makeFetch(routes: RouteHandler[]) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url });
    const r = routes.find((h) => h.match(method, url));
    if (!r) throw new Error(`unhandled fetch: ${method} ${url}`);
    const { status, body } = r.respond({ method, url });
    return new Response(body !== undefined ? JSON.stringify(body) : null, {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const ISSUES_URL =
  'https://api.github.com/repos/owner/repo/issues?state=open&labels=pm%3Aready&per_page=100';
const PULLS_URL = 'https://api.github.com/repos/owner/repo/pulls?state=open&per_page=100';

function seedMappedFeature(opts: { issueNumber: number }) {
  const ws = workstreamStore.createWorkstream('owner/repo', 'auth', 'Auth');
  const feature = featureStore.createFeature({
    workstreamId: ws.id,
    name: 'Login',
    slug: '01-login',
    kind: 'feature',
  });
  featureStore.updateFeature(feature.id, {
    githubIssueNumber: opts.issueNumber,
    githubIssueUrl: `https://github.com/owner/repo/issues/${opts.issueNumber}`,
  });
  return { ws, feature: featureStore.getFeature(feature.id)! };
}

describe('reconcileTargetRepo', () => {
  it('enqueues dev pickup for a pm:ready issue that has no claim yet', async () => {
    const { feature } = seedMappedFeature({ issueNumber: 7 });
    const spawn = vi.fn().mockResolvedValue({ taskId: 'task-r1' });
    const { fetchImpl } = makeFetch([
      {
        match: (m, u) => m === 'GET' && u === ISSUES_URL,
        respond: () => ({
          status: 200,
          body: [
            {
              number: 7,
              state: 'open',
              title: 'Login',
              body: 'body',
              html_url: 'https://x/7',
              labels: [{ name: 'pm:ready' }],
            },
          ],
        }),
      },
      {
        match: (m, u) => m === 'GET' && u === PULLS_URL,
        respond: () => ({ status: 200, body: [] }),
      },
    ]);
    const res = await reconcileTargetRepo('owner/repo', null, {
      fetchImpl,
      spawnDevTask: spawn,
      runRmReview: vi.fn(),
    });
    expect(res.issuesScanned).toBe(1);
    expect(res.issuesEnqueued).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][0].featureId).toBe(feature.id);
  });

  it('does NOT enqueue an issue already mapped + previously dispatched', async () => {
    // Simulate that the webhook dispatcher already claimed this exact
    // state_key — the reconciler must not double-dispatch.
    seedMappedFeature({ issueNumber: 7 });
    // Manually insert a claimed job so reconciler hits UNIQUE constraint.
    const { getDb } = await import('../../src/stores/db.js');
    getDb()
      .prepare(
        `INSERT INTO github_jobs
           (id, repository, kind, state_key, issue_number, pr_number, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        'existing-job',
        'owner/repo',
        'dev-pickup',
        'dev-pickup:owner/repo#7',
        7,
        null,
        'completed',
        new Date().toISOString(),
        new Date().toISOString(),
      );

    const spawn = vi.fn();
    const { fetchImpl } = makeFetch([
      {
        match: (m, u) => m === 'GET' && u === ISSUES_URL,
        respond: () => ({
          status: 200,
          body: [
            {
              number: 7,
              state: 'open',
              title: 'Login',
              body: 'body',
              html_url: 'https://x/7',
              labels: [{ name: 'pm:ready' }],
            },
          ],
        }),
      },
      {
        match: (m, u) => m === 'GET' && u === PULLS_URL,
        respond: () => ({ status: 200, body: [] }),
      },
    ]);
    const res = await reconcileTargetRepo('owner/repo', null, {
      fetchImpl,
      spawnDevTask: spawn,
      runRmReview: vi.fn(),
    });
    expect(res.issuesScanned).toBe(1);
    expect(res.issuesEnqueued).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('heals a lost mapping via the hidden body marker', async () => {
    const ws = workstreamStore.createWorkstream('owner/repo', 'orphan', 'Orphan');
    const feature = featureStore.createFeature({
      workstreamId: ws.id,
      name: 'X',
      slug: '01-x',
      kind: 'feature',
    });
    // Feature has NO github_issue_number (simulating PM crash).
    const spawn = vi.fn().mockResolvedValue({ taskId: 'r-heal' });
    const { fetchImpl } = makeFetch([
      {
        match: (m, u) => m === 'GET' && u === ISSUES_URL,
        respond: () => ({
          status: 200,
          body: [
            {
              number: 42,
              state: 'open',
              title: 'X',
              body: `<!-- liliput:feature-id=${feature.id} -->\nrest`,
              html_url: 'https://github.com/owner/repo/issues/42',
              labels: [{ name: 'pm:ready' }],
            },
          ],
        }),
      },
      {
        match: (m, u) => m === 'GET' && u === PULLS_URL,
        respond: () => ({ status: 200, body: [] }),
      },
    ]);
    const res = await reconcileTargetRepo('owner/repo', null, {
      fetchImpl,
      spawnDevTask: spawn,
      runRmReview: vi.fn(),
    });
    expect(res.issuesHealed).toBe(1);
    expect(res.issuesEnqueued).toBe(1);
    const healed = featureStore.getFeature(feature.id)!;
    expect(healed.githubIssueNumber).toBe(42);
  });

  it('ignores PR objects returned on the issues endpoint', async () => {
    seedMappedFeature({ issueNumber: 7 });
    const spawn = vi.fn();
    const { fetchImpl } = makeFetch([
      {
        match: (m, u) => m === 'GET' && u === ISSUES_URL,
        respond: () => ({
          status: 200,
          body: [
            {
              number: 7,
              pull_request: { url: 'pr' }, // ← signals "this is actually a PR"
              state: 'open',
              title: 't',
              body: 'b',
              html_url: 'x',
              labels: [{ name: 'pm:ready' }],
            },
          ],
        }),
      },
      {
        match: (m, u) => m === 'GET' && u === PULLS_URL,
        respond: () => ({ status: 200, body: [] }),
      },
    ]);
    const res = await reconcileTargetRepo('owner/repo', null, {
      fetchImpl,
      spawnDevTask: spawn,
      runRmReview: vi.fn(),
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(res.issuesEnqueued).toBe(0);
  });

  it('runs RM review on every open non-draft PR with rm:review', async () => {
    const rm = vi.fn().mockResolvedValue({ action: 'merge' });
    const { fetchImpl } = makeFetch([
      {
        match: (m, u) => m === 'GET' && u === ISSUES_URL,
        respond: () => ({ status: 200, body: [] }),
      },
      {
        match: (m, u) => m === 'GET' && u === PULLS_URL,
        respond: () => ({
          status: 200,
          body: [
            {
              number: 10,
              state: 'open',
              draft: false,
              title: 'a',
              html_url: 'x/10',
              labels: [{ name: 'rm:review' }],
              head: { sha: 'aaaaaaaaaaaa' },
            },
            // skipped: draft
            {
              number: 11,
              state: 'open',
              draft: true,
              title: 'b',
              html_url: 'x/11',
              labels: [{ name: 'rm:review' }],
              head: { sha: 'bbbbbbbbbbbb' },
            },
            // skipped: missing label
            {
              number: 12,
              state: 'open',
              draft: false,
              title: 'c',
              html_url: 'x/12',
              labels: [],
              head: { sha: 'cccccccccccc' },
            },
          ],
        }),
      },
    ]);
    const res = await reconcileTargetRepo('owner/repo', null, {
      fetchImpl,
      spawnDevTask: vi.fn(),
      runRmReview: rm,
    });
    expect(res.prsScanned).toBe(3);
    expect(res.prsReviewed).toBe(1);
    expect(rm).toHaveBeenCalledTimes(1);
    expect(rm).toHaveBeenCalledWith('owner/repo', 10);
  });

  it('counts an error and continues when listIssuesByLabel fails', async () => {
    const { fetchImpl } = makeFetch([
      {
        match: (m, u) => m === 'GET' && u === ISSUES_URL,
        respond: () => ({ status: 500, body: { message: 'boom' } }),
      },
      {
        match: (m, u) => m === 'GET' && u === PULLS_URL,
        respond: () => ({ status: 200, body: [] }),
      },
    ]);
    const res = await reconcileTargetRepo('owner/repo', null, {
      fetchImpl,
      spawnDevTask: vi.fn(),
      runRmReview: vi.fn(),
    });
    expect(res.errors).toBe(1);
    // We still tried PRs.
    expect(res.prsScanned).toBe(0);
  });
});

describe('reconcileAllRepos', () => {
  it('only reconciles repos in bootstrap_state=ready', async () => {
    targetRepoStore.ensureTargetRepo('a/ready');
    targetRepoStore.updateTargetRepo('a/ready', {
      bootstrapState: 'ready',
      webhookStatus: 'active',
    });
    targetRepoStore.ensureTargetRepo('b/pending');
    const { fetchImpl } = makeFetch([
      {
        match: (m, u) =>
          m === 'GET' && u.startsWith('https://api.github.com/repos/a/ready/issues'),
        respond: () => ({ status: 200, body: [] }),
      },
      {
        match: (m, u) =>
          m === 'GET' && u.startsWith('https://api.github.com/repos/a/ready/pulls'),
        respond: () => ({ status: 200, body: [] }),
      },
    ]);
    const out = await reconcileAllRepos(null, { fetchImpl });
    expect(out).toHaveLength(1);
    expect(out[0].repo).toBe('a/ready');
  });
});
