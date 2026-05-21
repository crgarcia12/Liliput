/**
 * Unit tests for the PM issue-flow.
 *
 * We mock the GitHub fetch API and exercise the recoverable ordering
 * specified in `pm-issue-flow.ts`:
 *   - labels ensured before issue creation
 *   - issue created WITHOUT pm:ready
 *   - feature.githubIssueNumber persisted BEFORE pm:ready is applied
 *   - idempotent on second invocation
 *   - resilient when pm:ready label-apply fails (issue still persisted)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetDb } from '../../src/stores/db.js';
import * as workstreamStore from '../../src/stores/workstream-store.js';
import * as featureStore from '../../src/stores/feature-store.js';
import {
  createIssueForFeature,
  emitIssuesForWorkstream,
  renderIssueBody,
  extractFeatureIdMarker,
} from '../../src/engine/pm-issue-flow.js';

beforeEach(() => {
  process.env['COPILOT_GITHUB_TOKEN'] = 'test-token';
  resetDb();
});

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

/** Build a fake fetch that records calls and returns scripted responses
 *  keyed by `<METHOD> <pathname>`. Unmatched URLs throw so a missing stub
 *  shows up as a clear test failure. */
function makeFakeFetch(
  responses: Record<string, { status: number; body: unknown } | (() => { status: number; body: unknown })>,
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const u = new URL(url);
    const key = `${method} ${u.pathname}`;
    const bodyStr = typeof init?.body === 'string' ? init.body : '';
    calls.push({ url, method, body: bodyStr ? JSON.parse(bodyStr) : undefined });
    const handler = responses[key];
    if (!handler) {
      throw new Error(`Unstubbed fetch call: ${key}`);
    }
    const { status, body } = typeof handler === 'function' ? handler() : handler;
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('pm-issue-flow', () => {
  describe('createIssueForFeature', () => {
    it('ensures labels, creates issue without pm:ready, persists mapping, then applies pm:ready', async () => {
      const ws = workstreamStore.createWorkstream('owner/repo', 'billing', 'Billing flow');
      const feature = featureStore.createFeature({
        workstreamId: ws.id,
        name: 'Payment refund',
        slug: '01-payment-refund',
        kind: 'feature',
        description: 'Refund a payment via API.',
        position: 0,
      });

      const { fetchImpl, calls } = makeFakeFetch({
        'POST /repos/owner/repo/labels': { status: 201, body: { name: 'workstream:billing' } },
        'POST /repos/owner/repo/issues': {
          status: 201,
          body: { number: 42, html_url: 'https://github.com/owner/repo/issues/42', node_id: 'I_kw1' },
        },
        'POST /repos/owner/repo/issues/42/labels': { status: 200, body: [{ name: 'pm:ready' }] },
      });

      const result = await createIssueForFeature('owner/repo', ws, feature, { fetchImpl });

      expect(result.status).toBe('created');
      expect(result.issueNumber).toBe(42);
      expect(result.issueUrl).toBe('https://github.com/owner/repo/issues/42');

      // Verify the ordering: labels first, issue next, then add-labels.
      const ordering = calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
      const labelEnsureFirst = ordering.indexOf('POST /repos/owner/repo/labels');
      const issueCreate = ordering.indexOf('POST /repos/owner/repo/issues');
      const addLabel = ordering.indexOf('POST /repos/owner/repo/issues/42/labels');
      expect(labelEnsureFirst).toBeGreaterThanOrEqual(0);
      expect(labelEnsureFirst).toBeLessThan(issueCreate);
      expect(issueCreate).toBeLessThan(addLabel);

      // The CREATE call must NOT include pm:ready (race-safety).
      const createCall = calls.find((c) => c.method === 'POST' && new URL(c.url).pathname === '/repos/owner/repo/issues');
      expect(createCall).toBeDefined();
      const createBody = createCall!.body as { labels: string[] };
      expect(createBody.labels).toContain('workstream:billing');
      expect(createBody.labels).not.toContain('pm:ready');

      // DB: feature.githubIssueNumber + url persisted.
      const after = featureStore.getFeature(feature.id);
      expect(after?.githubIssueNumber).toBe(42);
      expect(after?.githubIssueUrl).toBe('https://github.com/owner/repo/issues/42');

      // DB: workstream.githubLabel persisted.
      const wsAfter = workstreamStore.getWorkstream(ws.id);
      expect(wsAfter?.githubLabel).toBe('workstream:billing');
    });

    it('is idempotent — second call returns existing without hitting GitHub', async () => {
      const ws = workstreamStore.createWorkstream('owner/repo', 'a', 'ws');
      const feature = featureStore.createFeature({
        workstreamId: ws.id,
        name: 'F',
        slug: '01-f',
        kind: 'feature',
      });
      featureStore.updateFeature(feature.id, {
        githubIssueNumber: 7,
        githubIssueUrl: 'https://github.com/owner/repo/issues/7',
      });

      const fetchImpl = vi.fn() as unknown as typeof fetch;
      const result = await createIssueForFeature('owner/repo', ws, feature, { fetchImpl });

      expect(result).toEqual({
        status: 'existing',
        issueNumber: 7,
        issueUrl: 'https://github.com/owner/repo/issues/7',
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('treats 422 "already_exists" label response as success', async () => {
      const ws = workstreamStore.createWorkstream('owner/repo', 'x', 'ws');
      const feature = featureStore.createFeature({ workstreamId: ws.id, name: 'F', slug: '01-f', kind: 'feature' });

      let labelCallCount = 0;
      const { fetchImpl } = makeFakeFetch({
        'POST /repos/owner/repo/labels': () => {
          labelCallCount++;
          return {
            status: 422,
            body: { message: 'Validation Failed', errors: [{ code: 'already_exists' }] },
          };
        },
        'POST /repos/owner/repo/issues': {
          status: 201,
          body: { number: 11, html_url: 'https://github.com/owner/repo/issues/11', node_id: 'I_kw2' },
        },
        'POST /repos/owner/repo/issues/11/labels': { status: 200, body: [] },
      });

      const result = await createIssueForFeature('owner/repo', ws, feature, { fetchImpl });
      expect(result.status).toBe('created');
      expect(labelCallCount).toBe(2); // workstream:x + pm:ready
    });

    it('persists mapping even when pm:ready apply fails', async () => {
      const ws = workstreamStore.createWorkstream('owner/repo', 'b', 'ws');
      const feature = featureStore.createFeature({ workstreamId: ws.id, name: 'F', slug: '01-f', kind: 'feature' });

      const { fetchImpl } = makeFakeFetch({
        'POST /repos/owner/repo/labels': { status: 201, body: {} },
        'POST /repos/owner/repo/issues': {
          status: 201,
          body: { number: 99, html_url: 'https://github.com/owner/repo/issues/99', node_id: 'I_kw3' },
        },
        'POST /repos/owner/repo/issues/99/labels': { status: 502, body: { message: 'bad gateway' } },
      });

      const result = await createIssueForFeature('owner/repo', ws, feature, { fetchImpl });
      expect(result.status).toBe('created');
      expect(result.issueNumber).toBe(99);
      const after = featureStore.getFeature(feature.id);
      // Critical recoverability invariant: the DB knows the issue number even
      // though pm:ready never got applied — reconciler can heal it.
      expect(after?.githubIssueNumber).toBe(99);
    });

    it('throws when issue creation fails (no mapping persisted)', async () => {
      const ws = workstreamStore.createWorkstream('owner/repo', 'c', 'ws');
      const feature = featureStore.createFeature({ workstreamId: ws.id, name: 'F', slug: '01-f', kind: 'feature' });

      const { fetchImpl } = makeFakeFetch({
        'POST /repos/owner/repo/labels': { status: 201, body: {} },
        'POST /repos/owner/repo/issues': { status: 500, body: { message: 'boom' } },
      });

      await expect(
        createIssueForFeature('owner/repo', ws, feature, { fetchImpl }),
      ).rejects.toThrow(/POST \/issues/);
      const after = featureStore.getFeature(feature.id);
      expect(after?.githubIssueNumber).toBeUndefined();
    });
  });

  describe('emitIssuesForWorkstream', () => {
    it('skips integration kind, counts per-feature outcomes, and survives individual failures', async () => {
      const ws = workstreamStore.createWorkstream('owner/repo', 'mix', 'ws');
      const f1 = featureStore.createFeature({ workstreamId: ws.id, name: 'A', slug: '01-a', kind: 'feature' });
      const f2 = featureStore.createFeature({ workstreamId: ws.id, name: 'B', slug: '02-b', kind: 'feature' });
      const fInt = featureStore.createFeature({ workstreamId: ws.id, name: 'Int', slug: '99-int', kind: 'integration' });

      let nextIssue = 100;
      let f2Failed = false;
      const responses: Record<string, () => { status: number; body: unknown }> = {
        'POST /repos/owner/repo/labels': () => ({ status: 201, body: {} }),
        'POST /repos/owner/repo/issues': () => {
          // Fail the second create.
          if (nextIssue === 101 && !f2Failed) {
            f2Failed = true;
            return { status: 500, body: { message: 'oops' } };
          }
          const num = nextIssue++;
          return { status: 201, body: { number: num, html_url: `https://x/issues/${num}`, node_id: 'I' } };
        },
      };
      // Will need a labels-on-issue stub for the success path
      responses['POST /repos/owner/repo/issues/100/labels'] = () => ({ status: 200, body: [] });

      const { fetchImpl } = makeFakeFetch(responses);
      const stats = await emitIssuesForWorkstream('owner/repo', ws, [f1, f2, fInt], { fetchImpl });

      expect(stats.created).toBe(1);
      expect(stats.failed).toBe(1);
      expect(stats.existing).toBe(0);
      // Integration never resulted in any GitHub call.
      expect(featureStore.getFeature(fInt.id)?.githubIssueNumber).toBeUndefined();
    });
  });

  describe('renderIssueBody / extractFeatureIdMarker', () => {
    it('round-trips the feature-id marker', () => {
      const ws: import('../../../shared/types/index.js').Workstream = {
        id: 'ws-1',
        repository: 'o/r',
        name: 'auth',
        createdAt: '',
        updatedAt: '',
      };
      const feature: import('../../../shared/types/index.js').Feature = {
        id: 'feat-abc-123',
        workstreamId: 'ws-1',
        name: 'Login',
        slug: '01-login',
        kind: 'feature',
        status: 'pending',
        position: 0,
        createdAt: '',
        updatedAt: '',
      };
      const body = renderIssueBody(ws, feature);
      expect(body).toContain('<!-- liliput:feature-id=feat-abc-123 -->');
      expect(extractFeatureIdMarker(body)).toBe('feat-abc-123');
    });

    it('returns null for missing marker', () => {
      expect(extractFeatureIdMarker('no marker here')).toBeNull();
      expect(extractFeatureIdMarker(null)).toBeNull();
      expect(extractFeatureIdMarker(undefined)).toBeNull();
    });
  });
});
