import { describe, expect, it } from 'vitest';
import {
  assertPullRequestChecksPassing,
  evaluatePullRequestChecks,
  type PullRequestChecksSnapshot,
} from '../../src/engine/github-check-gate.js';

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function githubChecksFetch(
  snapshots: PullRequestChecksSnapshot[],
): { fetchImpl: typeof fetch; checkRunCalls: () => number } {
  let checkRunCallCount = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (/\/pulls\/\d+$/.test(url)) {
      return jsonResponse({ head: { sha: 'checked-head-sha' } });
    }
    if (url.includes('/check-runs')) {
      const snapshot =
        snapshots[Math.min(checkRunCallCount, snapshots.length - 1)]!;
      checkRunCallCount += 1;
      return jsonResponse({
        check_runs: snapshot.checkRuns.map((run) => ({
          name: run.name,
          status: run.status,
          conclusion: run.conclusion,
        })),
      });
    }
    if (url.endsWith('/status')) {
      const snapshot =
        snapshots[Math.min(Math.max(checkRunCallCount - 1, 0), snapshots.length - 1)]!;
      return jsonResponse({ statuses: snapshot.statuses });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return {
    fetchImpl,
    checkRunCalls: () => checkRunCallCount,
  };
}

describe('evaluatePullRequestChecks', () => {
  it('should allow repositories without configured checks', () => {
    expect(
      evaluatePullRequestChecks({ checkRuns: [], statuses: [] }),
    ).toEqual({ state: 'none', details: [] });
  });

  it('should accept completed successful checks', () => {
    expect(
      evaluatePullRequestChecks({
        checkRuns: [
          { name: 'build', status: 'completed', conclusion: 'success' },
          { name: 'docs', status: 'completed', conclusion: 'skipped' },
        ],
        statuses: [{ context: 'preview', state: 'success' }],
      }),
    ).toEqual({ state: 'passing', details: [] });
  });

  it('should block direct delivery when any CI check fails', () => {
    const result = evaluatePullRequestChecks({
      checkRuns: [
        { name: 'unit-tests', status: 'completed', conclusion: 'failure' },
      ],
      statuses: [],
    });

    expect(result.state).toBe('failing');
    expect(result.details).toContain('unit-tests (failure)');
  });

  it('should block direct delivery while checks are pending', () => {
    const result = evaluatePullRequestChecks({
      checkRuns: [
        { name: 'e2e', status: 'in_progress', conclusion: null },
      ],
      statuses: [],
    });

    expect(result.state).toBe('pending');
  });

  it('should wait for checks to appear and return the checked head SHA', async () => {
    const mocked = githubChecksFetch([
      { checkRuns: [], statuses: [] },
      {
        checkRuns: [
          { name: 'build', status: 'completed', conclusion: 'success' },
        ],
        statuses: [],
      },
    ]);
    let clock = 0;

    const result = await assertPullRequestChecksPassing('owner/repo', 42, 'token', {
      fetchImpl: mocked.fetchImpl,
      now: () => clock,
      sleep: async (delayMs) => {
        clock += delayMs;
      },
      timeoutMs: 100,
      noChecksGraceMs: 20,
      pollIntervalMs: 10,
      passingStabilityMs: 0,
    });

    expect(result).toEqual({
      state: 'passing',
      details: [],
      headSha: 'checked-head-sha',
    });
    expect(mocked.checkRunCalls()).toBe(2);
  });

  it('should time out instead of merging while checks remain pending', async () => {
    const mocked = githubChecksFetch([
      {
        checkRuns: [
          { name: 'build', status: 'in_progress', conclusion: null },
        ],
        statuses: [],
      },
    ]);
    let clock = 0;

    await expect(
      assertPullRequestChecksPassing('owner/repo', 42, 'token', {
        fetchImpl: mocked.fetchImpl,
        now: () => clock,
        sleep: async (delayMs) => {
          clock += delayMs;
        },
        timeoutMs: 20,
        noChecksGraceMs: 10,
        pollIntervalMs: 10,
        passingStabilityMs: 0,
      }),
    ).rejects.toThrow('Timed out');
  });
});
