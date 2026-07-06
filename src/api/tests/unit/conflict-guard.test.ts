/**
 * Tests for the per-round conflict guard.
 *
 * We mock the git plumbing (`git-client`), the Copilot turn runner
 * (`agent-loop`), and the GitHub REST helpers so we can assert the escalation
 * ladder without a real repository:
 *   Tier 0  base already contained  → 'clean', no probe/resolver
 *   Tier 1  base advanced, no conflict → 'no-conflict', no resolver
 *   Tier 2  real conflict, resolver succeeds → 'resolved', pushed
 *   Tier 2  real conflict, resolver fails → 'unresolved', merge aborted + labeled
 *   Tier 0  fetch fails → 'skipped'
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/engine/git-client.js');
vi.mock('../../src/engine/agent-loop.js');
vi.mock('../../src/engine/github-rest.js');

import * as git from '../../src/engine/git-client.js';
import { runAgentTurn } from '../../src/engine/agent-loop.js';
import { addLabels, ensureLabel } from '../../src/engine/github-rest.js';
import { guardMainConflicts, type ConflictGuardOptions } from '../../src/engine/conflict-guard.js';

const handle = { cwd: '/tmp/repo', repo: 'acme/widgets', branch: 'liliput/feature' };

function baseOpts(overrides: Partial<ConflictGuardOptions> = {}): ConflictGuardOptions {
  return {
    // Session is never touched unless the resolver runs; a stub is fine.
    agentSession: {} as ConflictGuardOptions['agentSession'],
    handle,
    baseBranch: 'main',
    repo: 'acme/widgets',
    autoPush: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(git.fetchRef).mockResolvedValue(undefined);
  vi.mocked(git.push).mockResolvedValue(undefined);
  vi.mocked(git.abortMerge).mockResolvedValue(undefined);
  vi.mocked(git.isWorkingTreeClean).mockResolvedValue(true);
  vi.mocked(ensureLabel).mockResolvedValue({ result: 'created' });
  vi.mocked(addLabels).mockResolvedValue(undefined);
});

describe('guardMainConflicts', () => {
  it('returns clean and skips the probe when base is already contained in HEAD', async () => {
    vi.mocked(git.isBaseMergedIntoHead).mockResolvedValue(true);

    const res = await guardMainConflicts(baseOpts());

    expect(res.status).toBe('clean');
    expect(git.probeMergeConflicts).not.toHaveBeenCalled();
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(git.mergeBaseIntoBranch).not.toHaveBeenCalled();
  });

  it('returns no-conflict without spawning a resolver when the base merges cleanly', async () => {
    vi.mocked(git.isBaseMergedIntoHead).mockResolvedValue(false);
    vi.mocked(git.probeMergeConflicts).mockResolvedValue({ conflicts: false, files: [] });

    const res = await guardMainConflicts(baseOpts());

    expect(res.status).toBe('no-conflict');
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(git.mergeBaseIntoBranch).not.toHaveBeenCalled();
  });

  it('resolves conflicts with a Copilot turn and pushes', async () => {
    vi.mocked(git.isBaseMergedIntoHead).mockResolvedValue(false);
    vi.mocked(git.probeMergeConflicts).mockResolvedValue({ conflicts: true, files: ['a.ts'] });
    // The real merge conflicts:
    vi.mocked(git.mergeBaseIntoBranch).mockRejectedValue(new Error('merge conflict'));
    // Before the resolver: conflicts present. After: cleared.
    vi.mocked(git.conflictedFiles)
      .mockResolvedValueOnce(['a.ts']) // files = ... first read
      .mockResolvedValueOnce(['a.ts']) // ... second read (non-empty branch)
      .mockResolvedValue([]); //          post-resolver read → resolved
    // isMergeComplete: MERGE_HEAD gone (rawGit throws) + tree clean.
    vi.mocked(git.rawGit).mockRejectedValue(new Error('no MERGE_HEAD'));
    vi.mocked(runAgentTurn).mockResolvedValue({
      summary: 'merged both sides',
      toolCallCount: 5,
    } as Awaited<ReturnType<typeof runAgentTurn>>);

    const onResolverStart = vi.fn();
    const onResolverEnd = vi.fn();
    const res = await guardMainConflicts(
      baseOpts({ onResolverStart, onResolverEnd }),
    );

    expect(res.status).toBe('resolved');
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    expect(git.push).toHaveBeenCalledTimes(1);
    expect(onResolverStart).toHaveBeenCalledTimes(1);
    expect(onResolverEnd).toHaveBeenCalledWith('merged both sides', true);
  });

  it('aborts and labels the PR when the resolver cannot clear conflicts', async () => {
    vi.mocked(git.isBaseMergedIntoHead).mockResolvedValue(false);
    vi.mocked(git.probeMergeConflicts).mockResolvedValue({ conflicts: true, files: ['a.ts'] });
    vi.mocked(git.mergeBaseIntoBranch).mockRejectedValue(new Error('merge conflict'));
    // Conflicts never clear.
    vi.mocked(git.conflictedFiles).mockResolvedValue(['a.ts']);
    vi.mocked(git.rawGit).mockResolvedValue({ stdout: 'deadbeef', stderr: '' });
    vi.mocked(runAgentTurn).mockResolvedValue({
      summary: 'gave up',
      toolCallCount: 1,
    } as Awaited<ReturnType<typeof runAgentTurn>>);

    const res = await guardMainConflicts(baseOpts({ prNumber: 42, maxResolveAttempts: 2 }));

    expect(res.status).toBe('unresolved');
    expect(runAgentTurn).toHaveBeenCalledTimes(2); // exhausted the budget
    expect(git.abortMerge).toHaveBeenCalledTimes(1);
    expect(addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'acme/widgets', issueNumber: 42, labels: ['dev:rebase-needed'] }),
    );
    expect(git.push).not.toHaveBeenCalled();
  });

  it('skips gracefully when the base branch cannot be fetched', async () => {
    vi.mocked(git.fetchRef).mockRejectedValue(new Error('network down'));

    const res = await guardMainConflicts(baseOpts());

    expect(res.status).toBe('skipped');
    expect(git.isBaseMergedIntoHead).not.toHaveBeenCalled();
    expect(runAgentTurn).not.toHaveBeenCalled();
  });
});
