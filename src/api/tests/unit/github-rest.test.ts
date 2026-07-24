/**
 * Unit tests for the thin GitHub REST helper.
 * Focus: error handling + idempotency contract — happy paths are covered
 * implicitly by `pm-issue-flow.test.ts`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ensureLabel,
  createIssue,
  addLabels,
  removeLabel,
  addComment,
  GitHubApiError,
  getGitHubToken,
  isCommitReachableFromBranch,
} from '../../src/engine/github-rest.js';

beforeEach(() => {
  process.env['COPILOT_GITHUB_TOKEN'] = 'tok-rest';
});

function makeResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('github-rest', () => {
  describe('getGitHubToken', () => {
    it('returns the configured token', () => {
      expect(getGitHubToken()).toBe('tok-rest');
    });
    it('throws when no token env var is set', () => {
      delete process.env['COPILOT_GITHUB_TOKEN'];
      delete process.env['GH_TOKEN'];
      delete process.env['GITHUB_TOKEN'];
      expect(() => getGitHubToken()).toThrow(/No GitHub token/);
    });
  });

  describe('ensureLabel', () => {
    it('returns "created" on 201', async () => {
      const fetchImpl = (async () => makeResponse(201, { name: 'x' })) as typeof fetch;
      const r = await ensureLabel({ repo: 'o/r', name: 'x', fetchImpl });
      expect(r.result).toBe('created');
    });
    it('returns "existed" on 422 already_exists', async () => {
      const fetchImpl = (async () =>
        makeResponse(422, { errors: [{ code: 'already_exists' }] })) as typeof fetch;
      const r = await ensureLabel({ repo: 'o/r', name: 'x', fetchImpl });
      expect(r.result).toBe('existed');
    });
    it('throws on 422 for any other reason', async () => {
      const fetchImpl = (async () =>
        makeResponse(422, { message: 'invalid name' })) as typeof fetch;
      await expect(
        ensureLabel({ repo: 'o/r', name: 'x', fetchImpl }),
      ).rejects.toBeInstanceOf(GitHubApiError);
    });
    it('throws on 500', async () => {
      const fetchImpl = (async () => makeResponse(500, { message: 'bang' })) as typeof fetch;
      await expect(
        ensureLabel({ repo: 'o/r', name: 'x', fetchImpl }),
      ).rejects.toBeInstanceOf(GitHubApiError);
    });
    it('truncates label description to 100 chars', async () => {
      let sent: { description?: string } = {};
      const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
        sent = JSON.parse((init?.body ?? '{}') as string);
        return makeResponse(201, {});
      }) as typeof fetch;
      await ensureLabel({
        repo: 'o/r',
        name: 'x',
        description: 'a'.repeat(250),
        fetchImpl,
      });
      expect(sent.description?.length).toBe(100);
    });
  });

  describe('createIssue', () => {
    it('returns number + htmlUrl + nodeId from the response', async () => {
      const fetchImpl = (async () =>
        makeResponse(201, {
          number: 7,
          html_url: 'https://x/issues/7',
          node_id: 'I_node',
        })) as typeof fetch;
      const r = await createIssue({ repo: 'o/r', title: 't', body: 'b', fetchImpl });
      expect(r).toEqual({ number: 7, htmlUrl: 'https://x/issues/7', nodeId: 'I_node' });
    });
    it('throws GitHubApiError on non-2xx', async () => {
      const fetchImpl = (async () => makeResponse(403, { message: 'no' })) as typeof fetch;
      await expect(
        createIssue({ repo: 'o/r', title: 't', body: 'b', fetchImpl }),
      ).rejects.toBeInstanceOf(GitHubApiError);
    });
  });

  describe('addLabels / removeLabel / addComment', () => {
    it('addLabels resolves on 2xx', async () => {
      const fetchImpl = (async () => makeResponse(200, [])) as typeof fetch;
      await expect(
        addLabels({ repo: 'o/r', issueNumber: 1, labels: ['x'], fetchImpl }),
      ).resolves.toBeUndefined();
    });
    it('removeLabel treats 404 as success', async () => {
      const fetchImpl = (async () => makeResponse(404, { message: 'gone' })) as typeof fetch;
      await expect(
        removeLabel({ repo: 'o/r', issueNumber: 1, label: 'x', fetchImpl }),
      ).resolves.toBeUndefined();
    });
    it('removeLabel throws on 500', async () => {
      const fetchImpl = (async () => makeResponse(500, {})) as typeof fetch;
      await expect(
        removeLabel({ repo: 'o/r', issueNumber: 1, label: 'x', fetchImpl }),
      ).rejects.toBeInstanceOf(GitHubApiError);
    });
    it('addComment URL-encodes the label segment correctly (sanity)', async () => {
      // removeLabel encodes the label name; verify a colon-containing label
      // round-trips through encodeURIComponent.
      let calledUrl = '';
      const fetchImpl = (async (input: RequestInfo | URL) => {
        calledUrl = typeof input === 'string' ? input : (input as URL).toString();
        return new Response(null, { status: 204 });
      }) as typeof fetch;
      await removeLabel({ repo: 'o/r', issueNumber: 1, label: 'pm:ready', fetchImpl });
      expect(calledUrl).toContain('/labels/pm%3Aready');
    });
    it('addComment posts the body', async () => {
      let sentBody = '';
      const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
        sentBody = (init?.body ?? '') as string;
        return makeResponse(201, {});
      }) as typeof fetch;
      await addComment({ repo: 'o/r', issueNumber: 1, body: 'hello', fetchImpl });
      expect(JSON.parse(sentBody)).toEqual({ body: 'hello' });
    });
  });

  describe('isCommitReachableFromBranch', () => {
    it('should accept a commit that is an ancestor of the branch tip', async () => {
      let calledUrl = '';
      const fetchImpl = (async (input: RequestInfo | URL) => {
        calledUrl =
          typeof input === 'string' ? input : (input as URL).toString();
        return makeResponse(200, { status: 'ahead' });
      }) as typeof fetch;

      await expect(
        isCommitReachableFromBranch({
          repo: 'o/r',
          commitSha: 'merge-sha',
          branch: 'release/main',
          fetchImpl,
        }),
      ).resolves.toBe(true);
      expect(calledUrl).toContain(
        '/compare/merge-sha...release%2Fmain',
      );
    });

    it('should reject a commit that is not on the branch history', async () => {
      const fetchImpl = (async () =>
        makeResponse(200, { status: 'diverged' })) as typeof fetch;

      await expect(
        isCommitReachableFromBranch({
          repo: 'o/r',
          commitSha: 'merge-sha',
          branch: 'main',
          fetchImpl,
        }),
      ).resolves.toBe(false);
    });
  });
});
