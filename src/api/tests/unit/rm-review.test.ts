/**
 * Tests for the Release Manager review engine.
 *
 * `runRmReview` is exercised end-to-end with a fetch-stub that records calls
 * and replies with canned PR / check / comment responses. We assert on:
 *   - the resulting `RmDecision` shape
 *   - which side-effect endpoints got called (merge, close, label, comment)
 *
 * `buildChecklist` + `countAttempts` + `extractClosesIssueNumber` are also
 * unit-tested directly because they are pure.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetDb } from '../../src/stores/db.js';
import * as workstreamStore from '../../src/stores/workstream-store.js';
import * as featureStore from '../../src/stores/feature-store.js';
import {
  runRmReview,
  buildChecklist,
  countAttempts,
  extractClosesIssueNumber,
  MAX_ATTEMPTS,
  type ChecklistItem,
} from '../../src/engine/rm-review.js';

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

/** Build a fetch impl that dispatches over a list of route handlers. The
 *  first match wins. Records every call for later assertion. */
function makeFetch(routes: RouteHandler[]) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown;
    if (init?.body && typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ method, url, body });
    const route = routes.find((r) => r.match(method, url));
    if (!route) {
      throw new Error(`unhandled fetch: ${method} ${url}`);
    }
    const { status, body: respBody } = route.respond({ method, url, body });
    return new Response(respBody !== undefined ? JSON.stringify(respBody) : null, {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function seedFeatureMappedToPr(opts: { issueNumber: number; prNumber: number }) {
  const ws = workstreamStore.createWorkstream('owner/repo', 'auth', 'Auth');
  const feature = featureStore.createFeature({
    workstreamId: ws.id,
    name: 'Login',
    slug: '01-login',
    kind: 'feature',
  });
  featureStore.updateFeature(feature.id, {
    githubIssueNumber: opts.issueNumber,
    githubPrNumber: opts.prNumber,
  });
  return featureStore.getFeature(feature.id)!;
}

const PR_URL = 'https://api.github.com/repos/owner/repo/pulls/42';
const CHECKS_URL = 'https://api.github.com/repos/owner/repo/commits/SHA1/check-runs?per_page=100';
const COMMENTS_URL_ISSUE = (n: number) =>
  `https://api.github.com/repos/owner/repo/issues/${n}/comments?per_page=100`;

function happyPathPr(overrides?: Partial<Record<string, unknown>>): unknown {
  return {
    number: 42,
    state: 'open',
    draft: false,
    merged: false,
    mergeable: true,
    mergeable_state: 'clean',
    title: 'Add login',
    body: 'Closes #7\n\n- [x] AC: user can log in\n- [x] AC: invalid creds rejected',
    html_url: 'https://x/42',
    labels: [{ name: 'rm:review' }],
    head: { sha: 'SHA1', ref: 'feat/login' },
    base: { ref: 'main' },
    user: { login: 'liliput' },
    ...overrides,
  };
}

describe('pure helpers', () => {
  it('extractClosesIssueNumber handles closes/fixes/resolves case-insensitively', () => {
    expect(extractClosesIssueNumber('Closes #12')).toBe(12);
    expect(extractClosesIssueNumber('fixes #34 and more text')).toBe(34);
    expect(extractClosesIssueNumber('Resolves #99\nblah')).toBe(99);
    expect(extractClosesIssueNumber('no link here')).toBeNull();
    expect(extractClosesIssueNumber('mentions #5 but no keyword')).toBeNull();
  });

  it('countAttempts returns the max marker N seen in any comment', () => {
    expect(countAttempts([])).toBe(0);
    expect(countAttempts(['hello'])).toBe(0);
    expect(
      countAttempts([
        '<!-- liliput:rm:attempt=1 -->\nfirst',
        '<!-- liliput:rm:attempt=2 -->\nsecond',
      ]),
    ).toBe(2);
    // unrelated comments don't increase
    expect(
      countAttempts([
        '<!-- liliput:rm:attempt=3 -->\nthird',
        'human comment with no marker',
      ]),
    ).toBe(3);
  });
});

describe('buildChecklist', () => {
  const basePr = happyPathPr() as Parameters<typeof buildChecklist>[0]['pr'];

  it('passes everything on a clean PR with all green checks', () => {
    const items = buildChecklist({
      pr: basePr,
      checks: [
        { id: 1, name: 'ci', status: 'completed', conclusion: 'success', html_url: '' },
      ],
      issueNumber: 7,
      body: basePr.body ?? '',
    });
    expect(items.every((c: ChecklistItem) => c.passed)).toBe(true);
  });

  it('fails when checks are still running', () => {
    const items = buildChecklist({
      pr: basePr,
      checks: [{ id: 1, name: 'ci', status: 'in_progress', conclusion: null, html_url: '' }],
      issueNumber: 7,
      body: basePr.body ?? '',
    });
    const ci = items.find((c) => c.name === 'CI checks passing')!;
    expect(ci.passed).toBe(false);
    expect(ci.detail).toContain('still running');
  });

  it('fails when checks are failing', () => {
    const items = buildChecklist({
      pr: basePr,
      checks: [{ id: 1, name: 'ci', status: 'completed', conclusion: 'failure', html_url: '' }],
      issueNumber: 7,
      body: basePr.body ?? '',
    });
    expect(items.find((c) => c.name === 'CI checks passing')!.passed).toBe(false);
  });

  it('fails when PR body does not close the linked issue', () => {
    const items = buildChecklist({
      pr: { ...basePr, body: 'no closes line\n- [x] AC' } as typeof basePr,
      checks: [{ id: 1, name: 'ci', status: 'completed', conclusion: 'success', html_url: '' }],
      issueNumber: 7,
      body: 'no closes line\n- [x] AC',
    });
    expect(items.find((c) => c.name === 'PR closes the linked issue')!.passed).toBe(false);
  });

  it('fails when not all AC checkboxes are ticked', () => {
    const body = 'Closes #7\n- [x] one\n- [ ] two';
    const items = buildChecklist({
      pr: { ...basePr, body } as typeof basePr,
      checks: [{ id: 1, name: 'ci', status: 'completed', conclusion: 'success', html_url: '' }],
      issueNumber: 7,
      body,
    });
    expect(items.find((c) => c.name === 'Acceptance criteria checked')!.passed).toBe(false);
  });

  it('passes AC check when there are no checkboxes at all', () => {
    const body = 'Closes #7\n\nNo checkbox AC.';
    const items = buildChecklist({
      pr: { ...basePr, body } as typeof basePr,
      checks: [{ id: 1, name: 'ci', status: 'completed', conclusion: 'success', html_url: '' }],
      issueNumber: 7,
      body,
    });
    expect(items.find((c) => c.name === 'Acceptance criteria checked')!.passed).toBe(true);
  });

  it('fails when blocked:human label is present', () => {
    const items = buildChecklist({
      pr: { ...basePr, labels: [{ name: 'blocked:human' }] } as typeof basePr,
      checks: [{ id: 1, name: 'ci', status: 'completed', conclusion: 'success', html_url: '' }],
      issueNumber: 7,
      body: basePr.body ?? '',
    });
    expect(items.find((c) => c.name === 'No `blocked:human` label')!.passed).toBe(false);
  });

  it('skips/neutral CI conclusions count as passing', () => {
    const items = buildChecklist({
      pr: basePr,
      checks: [
        { id: 1, name: 'a', status: 'completed', conclusion: 'skipped', html_url: '' },
        { id: 2, name: 'b', status: 'completed', conclusion: 'neutral', html_url: '' },
        { id: 3, name: 'c', status: 'completed', conclusion: 'success', html_url: '' },
      ],
      issueNumber: 7,
      body: basePr.body ?? '',
    });
    expect(items.find((c) => c.name === 'CI checks passing')!.passed).toBe(true);
  });
});

describe('runRmReview', () => {
  it('merges + closes the issue when every check passes', async () => {
    seedFeatureMappedToPr({ issueNumber: 7, prNumber: 42 });
    const { fetchImpl, calls } = makeFetch([
      {
        match: (m, u) => m === 'GET' && u === PR_URL,
        respond: () => ({ status: 200, body: happyPathPr() }),
      },
      {
        match: (m, u) => m === 'GET' && u === CHECKS_URL,
        respond: () => ({
          status: 200,
          body: {
            check_runs: [
              { id: 1, name: 'ci', status: 'completed', conclusion: 'success', html_url: '' },
            ],
          },
        }),
      },
      {
        match: (m, u) => m === 'GET' && u === COMMENTS_URL_ISSUE(7),
        respond: () => ({ status: 200, body: [] }),
      },
      {
        match: (m, u) => m === 'PUT' && u === 'https://api.github.com/repos/owner/repo/pulls/42/merge',
        respond: () => ({ status: 200, body: { merged: true, sha: 'mergeSHA', message: 'ok' } }),
      },
      {
        match: (m, u) => m === 'PATCH' && u === 'https://api.github.com/repos/owner/repo/issues/7',
        respond: () => ({ status: 200, body: {} }),
      },
      {
        match: (m, u) => m === 'POST' && /labels$/.test(u),
        respond: () => ({ status: 200, body: [] }),
      },
      {
        match: (m, u) => m === 'DELETE' && /labels\//.test(u),
        respond: () => ({ status: 200, body: {} }),
      },
      {
        match: (m, u) => m === 'POST' && /comments$/.test(u),
        respond: () => ({ status: 201, body: { id: 1 } }),
      },
    ]);

    const decision = await runRmReview('owner/repo', 42, { fetchImpl });
    expect(decision.action).toBe('merge');
    expect(decision.attempt).toBe(1);

    // Merge was called with the head SHA we expected.
    const merge = calls.find((c) => c.method === 'PUT');
    expect(merge).toBeDefined();
    expect((merge!.body as Record<string, unknown>)['sha']).toBe('SHA1');

    // Issue 7 was explicitly PATCHed closed.
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch).toBeDefined();
    expect((patch!.body as Record<string, unknown>)['state']).toBe('closed');
  });

  it('skips draft PRs without touching any mutation endpoints', async () => {
    seedFeatureMappedToPr({ issueNumber: 7, prNumber: 42 });
    const { fetchImpl, calls } = makeFetch([
      {
        match: (m, u) => m === 'GET' && u === PR_URL,
        respond: () => ({ status: 200, body: happyPathPr({ draft: true }) }),
      },
    ]);
    const decision = await runRmReview('owner/repo', 42, { fetchImpl });
    expect(decision.action).toBe('skip');
    expect(decision.reasons).toContain('draft PR');
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('skips an already-merged PR', async () => {
    seedFeatureMappedToPr({ issueNumber: 7, prNumber: 42 });
    const { fetchImpl } = makeFetch([
      {
        match: (m, u) => m === 'GET' && u === PR_URL,
        respond: () => ({ status: 200, body: happyPathPr({ merged: true }) }),
      },
    ]);
    const decision = await runRmReview('owner/repo', 42, { fetchImpl });
    expect(decision.action).toBe('skip');
  });

  it('requests changes when CI is failing (attempt 1)', async () => {
    seedFeatureMappedToPr({ issueNumber: 7, prNumber: 42 });
    const { fetchImpl, calls } = makeFetch([
      {
        match: (m, u) => m === 'GET' && u === PR_URL,
        respond: () => ({ status: 200, body: happyPathPr() }),
      },
      {
        match: (m, u) => m === 'GET' && u === CHECKS_URL,
        respond: () => ({
          status: 200,
          body: {
            check_runs: [
              { id: 1, name: 'ci', status: 'completed', conclusion: 'failure', html_url: '' },
            ],
          },
        }),
      },
      {
        match: (m, u) => m === 'GET' && u === COMMENTS_URL_ISSUE(7),
        respond: () => ({ status: 200, body: [] }),
      },
      {
        match: (m, u) => m === 'POST' && /comments$/.test(u),
        respond: () => ({ status: 201, body: { id: 1 } }),
      },
      {
        match: (m, u) => m === 'POST' && /labels$/.test(u),
        respond: () => ({ status: 200, body: [] }),
      },
      {
        match: (m, u) => m === 'DELETE' && /labels\//.test(u),
        respond: () => ({ status: 200, body: {} }),
      },
    ]);
    const decision = await runRmReview('owner/repo', 42, { fetchImpl });
    expect(decision.action).toBe('request-changes');
    expect(decision.attempt).toBe(1);

    // PR was labeled `rm:changes-requested` (not the issue).
    const labelPost = calls.find(
      (c) =>
        c.method === 'POST' &&
        c.url.endsWith('/issues/42/labels') &&
        Array.isArray((c.body as Record<string, unknown>)['labels']),
    );
    expect(labelPost).toBeDefined();
    expect((labelPost!.body as { labels: string[] }).labels).toContain('rm:changes-requested');

    // No merge was attempted.
    expect(calls.find((c) => c.method === 'PUT')).toBeUndefined();
  });

  it('escalates after MAX_ATTEMPTS failed attempts', async () => {
    seedFeatureMappedToPr({ issueNumber: 7, prNumber: 42 });
    // Pretend MAX_ATTEMPTS prior attempts already happened.
    const priorComments = Array.from({ length: MAX_ATTEMPTS }, (_, i) => ({
      id: i + 1,
      body: `<!-- liliput:rm:attempt=${i + 1} -->\nrequest changes`,
      user: { login: 'bot' },
      created_at: new Date().toISOString(),
    }));
    const { fetchImpl, calls } = makeFetch([
      {
        match: (m, u) => m === 'GET' && u === PR_URL,
        respond: () => ({ status: 200, body: happyPathPr() }),
      },
      {
        match: (m, u) => m === 'GET' && u === CHECKS_URL,
        respond: () => ({
          status: 200,
          body: {
            check_runs: [
              { id: 1, name: 'ci', status: 'completed', conclusion: 'failure', html_url: '' },
            ],
          },
        }),
      },
      {
        match: (m, u) => m === 'GET' && u === COMMENTS_URL_ISSUE(7),
        respond: () => ({ status: 200, body: priorComments }),
      },
      {
        match: (m, u) => m === 'POST' && /comments$/.test(u),
        respond: () => ({ status: 201, body: { id: 99 } }),
      },
      {
        match: (m, u) => m === 'POST' && /labels$/.test(u),
        respond: () => ({ status: 200, body: [] }),
      },
      {
        match: (m, u) => m === 'DELETE' && /labels\//.test(u),
        respond: () => ({ status: 200, body: {} }),
      },
    ]);
    const decision = await runRmReview('owner/repo', 42, { fetchImpl });
    expect(decision.action).toBe('escalate');

    // PR + linked issue both received `blocked:human`.
    const labelPosts = calls.filter(
      (c) =>
        c.method === 'POST' &&
        /\/labels$/.test(c.url) &&
        Array.isArray((c.body as Record<string, unknown>)['labels']),
    );
    const allLabels = labelPosts.flatMap((p) => (p.body as { labels: string[] }).labels);
    expect(allLabels).toContain('blocked:human');

    expect(calls.find((c) => c.method === 'PUT')).toBeUndefined();
  });

  it('returns skip when the PR does not exist (404)', async () => {
    const { fetchImpl } = makeFetch([
      {
        match: (m, u) => m === 'GET' && u === PR_URL,
        respond: () => ({ status: 404, body: { message: 'Not Found' } }),
      },
    ]);
    // Suppress error log noise from the GitHubApiError path.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const decision = await runRmReview('owner/repo', 42, { fetchImpl });
    expect(decision.action).toBe('skip');
    spy.mockRestore();
  });
});
