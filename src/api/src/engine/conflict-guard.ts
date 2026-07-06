/**
 * Conflict guard — per-round divergence check against the base branch, with
 * Copilot-driven resolution.
 *
 * Runs once per iteration (right after the branch is committed + pushed, when
 * HEAD is a known clean SHA). Its job: keep the working branch free of merge
 * conflicts with the base branch (usually `main`) so the eventual PR merges
 * cleanly — and do it *cheaply*.
 *
 * ## Efficiency: escalate only as far as needed
 *
 *   Tier 0 — near-free skip.
 *     `git fetch origin <base>` then `git merge-base --is-ancestor`. If the base
 *     is already contained in HEAD there is provably nothing to reconcile →
 *     return immediately. This is the common case every round and costs one
 *     shallow fetch.
 *
 *   Tier 1 — non-destructive conflict probe.
 *     Only when the base advanced. `git merge-tree --write-tree` computes the
 *     merge *in memory* — no working-tree/index mutation, no checkout. Clean →
 *     nothing to do (a base that merges cleanly needs no action; we only act on
 *     real conflicts). No Copilot turn is spawned.
 *
 *   Tier 2 — Copilot only on a real conflict.
 *     Perform the actual `git merge` (which stops with conflict markers), then
 *     hand the workspace to a Copilot fixer turn that resolves the markers,
 *     stages, and commits. On success we optionally push. If the fixer can't
 *     resolve within its retry budget we `git merge --abort`, best-effort label
 *     the PR `dev:rebase-needed`, and return — the round never breaks.
 *
 * The LLM (the expensive part) is invoked in exactly one situation: a genuine
 * conflict exists. Everything else is plain git plumbing.
 */

import { runAgentTurn, type AgentSession, type LogFn, type ToolEventFn } from './agent-loop.js';
import * as git from './git-client.js';
import type { RepoHandle } from './git-client.js';
import { addLabels, ensureLabel } from './github-rest.js';
import { logger } from '../logger.js';

const RESOLVER_TIMEOUT_MS = parseInt(
  process.env['CONFLICT_RESOLVER_TIMEOUT_MS'] ?? '600000', // 10 min — bash + git
  10,
);

/** Max Copilot resolution attempts before we abort + label. */
const DEFAULT_MAX_RESOLVE_ATTEMPTS = parseInt(
  process.env['CONFLICT_RESOLVER_MAX_ATTEMPTS'] ?? '2',
  10,
);

const REBASE_NEEDED_LABEL = 'dev:rebase-needed';

export type ConflictGuardStatus =
  | 'clean' //     base already contained in HEAD — nothing to do
  | 'no-conflict' // base advanced but merges cleanly — nothing to do
  | 'resolved' //  conflicts existed and were resolved (and pushed if autoPush)
  | 'unresolved' // conflicts existed and could not be resolved (aborted + labeled)
  | 'skipped' //   probe inconclusive / guard could not run — non-fatal
  | 'error'; //    unexpected failure — swallowed, round continues

export interface ConflictGuardResult {
  status: ConflictGuardStatus;
  conflictedFiles: string[];
  /** 1-2 sentence summary of what the resolver did, when it ran. */
  summary?: string;
}

export interface ConflictGuardOptions {
  /** Shared Copilot SDK session for this task — gives the resolver repo context. */
  agentSession: AgentSession;
  handle: RepoHandle;
  /** Base branch to reconcile against (e.g. "main"). */
  baseBranch: string;
  /** "owner/repo" — for logs and labeling. */
  repo: string;
  /** Push the branch after a successful resolution. */
  autoPush: boolean;
  /** PR number to label when resolution fails. Optional (no PR yet → skip label). */
  prNumber?: number;
  maxResolveAttempts?: number;
  onLog?: (level: 'info' | 'warn' | 'error', message: string, command?: string, output?: string) => void;
  onToolEvent?: ToolEventFn;
  /** Called when a resolver (Copilot) turn is spawned, so the UI can show an agent. */
  onResolverStart?: () => void;
  /** Called when the resolver turn ends. */
  onResolverEnd?: (summary: string, resolved: boolean) => void;
}

function buildResolverPrompt(ctx: {
  baseBranch: string;
  branch: string;
  repo: string;
  files: string[];
  attempt: number;
  maxAttempts: number;
}): string {
  return [
    'You are the Liliput conflict-resolver agent. A `git merge` of the base branch',
    `into the working branch has left **merge conflicts** that you must resolve.`,
    '',
    `## Merge in progress (resolution attempt ${ctx.attempt}/${ctx.maxAttempts})`,
    '',
    `  - Repo: ${ctx.repo}`,
    `  - Working branch: ${ctx.branch}`,
    `  - Merging in: origin/${ctx.baseBranch}`,
    '',
    '## Conflicted files',
    '',
    ...(ctx.files.length ? ctx.files.map((f) => `  - ${f}`) : ['  (run `git diff --name-only --diff-filter=U` to list them)']),
    '',
    '## Your job',
    '',
    '  In THIS turn you ARE allowed to run git and bash.',
    '  1. Inspect each conflict: `git diff`, `git status`, open the files.',
    '  2. Resolve every conflict marker (`<<<<<<<`, `=======`, `>>>>>>>`) by',
    '     combining both sides so the code is correct and compiles — do NOT blindly',
    '     pick one side. Preserve the intent of BOTH the base-branch change and the',
    '     working-branch change wherever they are compatible.',
    '  3. Stage the resolved files: `git add <file>`.',
    '  4. Complete the merge: `git commit --no-edit` (the merge message is fine).',
    '  5. Verify there are no remaining conflicts: `git diff --check` and',
    '     `git diff --name-only --diff-filter=U` (must be empty).',
    '',
    '## Hard constraints',
    '',
    `  - Stay on branch \`${ctx.branch}\`. DO NOT switch branches.`,
    '  - DO NOT change the git remote URL.',
    '  - DO NOT run `git merge --abort` or `git reset --hard` — Liliput handles',
    '    abort/recovery if you cannot finish.',
    '  - DO NOT modify files under `infra/`, `k8s/`, or `.github/` unless they are',
    '    the actual conflicted files.',
    '  - Make the smallest change that correctly resolves each conflict.',
    '',
    'Reply with a 1-2 sentence summary of how you resolved the conflicts.',
  ].join('\n');
}

/**
 * Run the per-round conflict guard. Never throws — any failure is logged and
 * mapped to a non-fatal status so the surrounding pipeline round continues.
 */
export async function guardMainConflicts(
  opts: ConflictGuardOptions,
): Promise<ConflictGuardResult> {
  const { handle, baseBranch, repo } = opts;
  const log = opts.onLog ?? (() => {});
  const maxAttempts = opts.maxResolveAttempts ?? DEFAULT_MAX_RESOLVE_ATTEMPTS;

  try {
    // Tier 0 — fetch base + cheap ancestor check.
    try {
      await git.fetchRef(handle, baseBranch);
    } catch (err) {
      const m = err instanceof Error ? err.message.split('\n').pop()?.trim() : String(err);
      log('warn', `Conflict guard: could not fetch origin/${baseBranch} (${m}); skipping this round.`);
      return { status: 'skipped', conflictedFiles: [] };
    }

    if (await git.isBaseMergedIntoHead(handle, baseBranch)) {
      log('info', `Conflict guard: branch already contains origin/${baseBranch} — nothing to reconcile.`);
      return { status: 'clean', conflictedFiles: [] };
    }

    // Tier 1 — non-destructive probe.
    const probe = await git.probeMergeConflicts(handle, baseBranch);
    if (probe.conflicts === false) {
      log('info', `Conflict guard: origin/${baseBranch} advanced but merges cleanly — no action needed.`);
      return { status: 'no-conflict', conflictedFiles: [] };
    }
    if (probe.conflicts === null) {
      log(
        'warn',
        'Conflict guard: could not probe conflicts non-destructively (old git?); attempting a trial merge.',
      );
    } else {
      log(
        'info',
        `Conflict guard: ${probe.files.length || 'some'} file(s) would conflict with origin/${baseBranch} — resolving with Copilot.`,
      );
    }

    // Tier 2 — real merge → conflicts → Copilot resolution.
    return await resolveWithCopilot(opts, log, maxAttempts, probe.files);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    log('error', `Conflict guard failed unexpectedly (non-fatal): ${m}`);
    logger.warn({ repo, baseBranch, err: m }, 'conflict-guard: unexpected failure');
    await git.abortMerge(handle);
    return { status: 'error', conflictedFiles: [] };
  }
}

async function resolveWithCopilot(
  opts: ConflictGuardOptions,
  log: NonNullable<ConflictGuardOptions['onLog']>,
  maxAttempts: number,
  probedFiles: string[],
): Promise<ConflictGuardResult> {
  const { handle, baseBranch, repo } = opts;

  // Kick off the actual merge. When it conflicts it exits non-zero but leaves
  // MERGE_HEAD + conflict markers in place for the resolver to work on.
  try {
    await git.mergeBaseIntoBranch(handle, baseBranch);
    // No throw → merge was actually clean (probe was 'null'/stale). Done.
    log('info', `Conflict guard: merge of origin/${baseBranch} completed cleanly.`);
    if (opts.autoPush) await pushResolved(opts, log);
    return { status: 'no-conflict', conflictedFiles: [] };
  } catch {
    // Expected: merge stopped with conflicts. Fall through to resolution.
  }

  const files = (await git.conflictedFiles(handle)).length
    ? await git.conflictedFiles(handle)
    : probedFiles;

  let lastSummary = '(no summary)';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    opts.onResolverStart?.();
    const resolverLog: LogFn = (level, msg, cmd, out) => log(level, msg, cmd, out);
    try {
      const result = await runAgentTurn(opts.agentSession, {
        taskTitle: '(conflict-resolver)',
        taskDescription: `Resolve merge conflicts with ${baseBranch}`,
        isInitial: false,
        promptOverride: buildResolverPrompt({
          baseBranch,
          branch: handle.branch,
          repo,
          files,
          attempt,
          maxAttempts,
        }),
        timeoutMs: RESOLVER_TIMEOUT_MS,
        onLog: resolverLog,
        ...(opts.onToolEvent ? { onToolEvent: opts.onToolEvent } : {}),
      });
      lastSummary = result.summary;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      log('warn', `Conflict guard: resolver turn failed (attempt ${attempt}/${maxAttempts}): ${m}`);
    }

    // Did the resolver actually clear the conflicts and finish the merge?
    const remaining = await git.conflictedFiles(handle);
    const mergeFinished = await isMergeComplete(handle);
    if (remaining.length === 0 && mergeFinished) {
      log('info', `Conflict guard: conflicts resolved — ${lastSummary}`);
      opts.onResolverEnd?.(lastSummary, true);
      if (opts.autoPush) await pushResolved(opts, log);
      return { status: 'resolved', conflictedFiles: files, summary: lastSummary };
    }
    opts.onResolverEnd?.(lastSummary, false);
    log(
      'warn',
      `Conflict guard: ${remaining.length} conflict(s) still unresolved after attempt ${attempt}/${maxAttempts}.`,
    );
  }

  // Give up — abort the merge and flag for a human, non-blocking.
  await git.abortMerge(handle);
  await labelRebaseNeeded(opts, log);
  log(
    'warn',
    `Conflict guard: could not auto-resolve conflicts with ${baseBranch} after ${maxAttempts} attempt(s); merge aborted and PR flagged.`,
  );
  return { status: 'unresolved', conflictedFiles: files, summary: lastSummary };
}

/** True once the merge is committed (no MERGE_HEAD) and the tree is clean. */
async function isMergeComplete(handle: RepoHandle): Promise<boolean> {
  try {
    // MERGE_HEAD present → merge still in progress.
    await git.rawGit(handle, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
    return false;
  } catch {
    // No MERGE_HEAD → merge committed (or never started). Require clean tree.
    return git.isWorkingTreeClean(handle);
  }
}

async function pushResolved(
  opts: ConflictGuardOptions,
  log: NonNullable<ConflictGuardOptions['onLog']>,
): Promise<void> {
  try {
    await git.push(opts.handle);
    log('info', `Conflict guard: pushed resolved branch ${opts.handle.branch}.`);
  } catch (err) {
    const m = err instanceof Error ? err.message.split('\n').pop()?.trim() : String(err);
    log('warn', `Conflict guard: resolved locally but push failed (${m}); next round's push will retry.`);
  }
}

async function labelRebaseNeeded(
  opts: ConflictGuardOptions,
  log: NonNullable<ConflictGuardOptions['onLog']>,
): Promise<void> {
  if (!opts.prNumber) return;
  try {
    await ensureLabel({
      repo: opts.repo,
      name: REBASE_NEEDED_LABEL,
      color: 'e99695',
      description: 'PR branch has unresolved conflicts with the base branch.',
    });
    await addLabels({ repo: opts.repo, issueNumber: opts.prNumber, labels: [REBASE_NEEDED_LABEL] });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    log('warn', `Conflict guard: could not apply '${REBASE_NEEDED_LABEL}' label: ${m}`);
  }
}
