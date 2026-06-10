/**
 * Reviewer-Agent triggers and feedback orchestration.
 *
 * Sits between the main pipeline (agent-engine.ts, routes/tasks.ts) and the
 * underlying `reviewer-loop.ts`. Owns:
 *   - Reading the per-task reviewer config (enabled? model? effort?)
 *   - Calling `reviewEvent` with the right context shape
 *   - Persisting feedback to `task.pendingReviewerFeedback` + chat
 *   - Emitting socket events for the UI
 *   - Hard guarantee that any reviewer failure NEVER breaks the main pipeline
 *
 * MVP triggers:
 *   - `triggerSpecReview` — after a spec is drafted (fire-and-forget). No
 *     workspace. Feedback (if any) shows up in chat and is queued for the
 *     coder's first turn.
 *   - `triggerPipelineReview` — after `validateAndHealLoop` ends, before the
 *     task flips to 'review' status. Has full context (spec + diff +
 *     deploy outcome). Blocking, but bounded by REVIEWER_TIMEOUT_MS so a
 *     wedged reviewer can't stall ship/review.
 */

import type { Server as SocketServer } from 'socket.io';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Task, ReviewerFeedbackKind } from '../../../shared/types/index.js';
import * as store from '../stores/task-store.js';
import { logger } from '../logger.js';
import {
  reviewEvent,
  makeFeedbackRecord,
  REVIEWER_MAX_ATTEMPTS,
  type ReviewContext,
  type ReviewerConfig,
} from './reviewer-loop.js';
import { resolveAgentSdkParams } from './agent-config.js';
import { getDefault as getUserAgentDefault } from '../stores/user-defaults-store.js';

const execFileP = promisify(execFile);

/** Cap the diff-stat we send to the reviewer at this many characters so a
 *  huge auto-formatter run doesn't blow the prompt budget. */
const DIFF_STAT_MAX_CHARS = 6_000;
/** Cap the changed-files list at this many entries. */
const CHANGED_FILES_MAX = 200;

/** Is the reviewer enabled for this task? */
function reviewerEnabled(task: Task): boolean {
  if (task.reviewerEnabled === false) return false;
  if (task.reviewerEnabled === true) return true;
  // Implicit: enabled when a reviewerModel is set OR the user has a reviewer
  // model pinned in their profile (so cheap-defaults seeding for new users
  // turns the reviewer on automatically).
  if (task.reviewerModel && task.reviewerModel.trim()) return true;
  if (task.ownerUserId) {
    try {
      const stored = getUserAgentDefault(task.ownerUserId, 'reviewer');
      if (stored?.model) return true;
    } catch {
      // Non-fatal — fall through to disabled.
    }
  }
  return false;
}

function reviewerConfig(task: Task): ReviewerConfig {
  const sdk = resolveAgentSdkParams(task, 'reviewer', {
    ...(task.reviewerModel ? { taskModel: task.reviewerModel } : {}),
    ...(task.reviewerReasoningEffort ? { taskReasoningEffort: task.reviewerReasoningEffort } : {}),
  });
  return {
    model: sdk.model,
    ...(sdk.reasoningEffort ? { reasoningEffort: sdk.reasoningEffort } : {}),
  };
}

/** Append a reviewer feedback record to the task and return the updated task. */
function persistFeedback(
  taskId: string,
  kind: ReviewerFeedbackKind,
  text: string,
  sha?: string,
): Task | undefined {
  const task = store.getTask(taskId);
  if (!task) return undefined;
  const existing = task.pendingReviewerFeedback ?? [];
  const record = makeFeedbackRecord(kind, text, sha);
  const updated = store.updateTask(taskId, {
    pendingReviewerFeedback: [...existing, record],
  });
  return updated;
}

/** Emit a `chat:message` with role='reviewer' so the UI shows the feedback
 *  in the terminal with the reviewer's styling. */
function postReviewerChat(io: SocketServer, taskId: string, text: string): void {
  const msg = store.addChatMessage(taskId, 'reviewer', text, undefined, 'Reviewer');
  if (msg) io.to(`task:${taskId}`).emit('chat:message', msg);
}

/** Compose the chat-friendly version of feedback so it stands out. */
function formatFeedbackForChat(kind: ReviewerFeedbackKind, feedback: string): string {
  const kindLabel: Record<ReviewerFeedbackKind, string> = {
    spec: 'spec draft',
    'coder-initial': 'initial code changes',
    'coder-iter': 'iteration changes',
    deploy: 'deployment + validation',
    plan: 'implementation plan',
  };
  return `🔍 **Reviewer feedback on ${kindLabel[kind]}:**\n\n${feedback}`;
}

/** Run a spec review on the given task. Fire-and-forget — caller does not
 *  await. Failure is logged and never propagates. */
export function triggerSpecReview(io: SocketServer, taskId: string, spec: string): void {
  void (async () => {
    try {
      const task = store.getTask(taskId);
      if (!task) return;
      if (!reviewerEnabled(task)) return;
      const ctx: ReviewContext = {
        kind: 'spec',
        ...(task.repository ? { repository: task.repository } : {}),
        taskTitle: task.title,
        taskDescription: task.description,
        spec,
      };
      const result = await reviewEvent(ctx, reviewerConfig(task));
      if (!result.feedback) {
        logger.info({ taskId, reason: result.reason }, 'reviewer-trigger: spec review — no feedback');
        return;
      }
      postReviewerChat(io, taskId, formatFeedbackForChat('spec', result.feedback));
      persistFeedback(taskId, 'spec', result.feedback);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ taskId, err: msg }, 'reviewer-trigger: spec review threw (swallowed)');
    }
  })();
}

interface PipelineReviewContext {
  /** Absolute path to the cloned workspace. */
  workspaceRoot: string;
  /** SHA of the just-committed-and-pushed code. */
  sha: string;
  /** Optional base SHA to diff against. Defaults to `HEAD~1`. */
  baseSha?: string;
  /** What kind of pipeline this is — initial run vs. follow-up iteration vs.
   *  pure rebuild (no coder turn but the deploy still warrants a sanity check). */
  kind: 'coder-initial' | 'coder-iter' | 'deploy';
  /** Coder's own summary / VERDICT line. */
  coderSummary?: string;
  /** Live dev URL (after deploy). */
  devUrl?: string;
  /** Did the post-deploy health loop converge? */
  validationHealthy?: boolean;
  /** How many validate-and-heal attempts were consumed. */
  validateAttemptsUsed?: number;
  /** Free-form summary of the validation outcome (e.g. last probe error). */
  validationSummary?: string;
}

/** Compute the diff stat + changed-files list for the reviewer's prompt. */
async function collectDiffContext(
  workspaceRoot: string,
  sha: string,
  baseSha?: string,
): Promise<{ diffStat?: string; changedFiles?: string[] }> {
  const range = baseSha ? `${baseSha}..${sha}` : `${sha}~1..${sha}`;
  let diffStat: string | undefined;
  let changedFiles: string[] | undefined;
  try {
    const { stdout } = await execFileP('git', ['diff', '--stat', range], {
      cwd: workspaceRoot,
    });
    diffStat = stdout.length > DIFF_STAT_MAX_CHARS
      ? stdout.substring(0, DIFF_STAT_MAX_CHARS) + '\n…(truncated)'
      : stdout;
  } catch (err) {
    logger.warn(
      { workspaceRoot, sha, err: err instanceof Error ? err.message : String(err) },
      'reviewer-trigger: git diff --stat failed (non-fatal)',
    );
  }
  try {
    const { stdout } = await execFileP('git', ['diff', '--name-only', range], {
      cwd: workspaceRoot,
    });
    changedFiles = stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, CHANGED_FILES_MAX);
  } catch (err) {
    logger.warn(
      { workspaceRoot, sha, err: err instanceof Error ? err.message : String(err) },
      'reviewer-trigger: git diff --name-only failed (non-fatal)',
    );
  }
  return {
    ...(diffStat ? { diffStat } : {}),
    ...(changedFiles ? { changedFiles } : {}),
  };
}

/** Verify the workspace exists and looks like a git checkout. Returns true
 *  when safe to run a workspace-bound review; false otherwise (the caller
 *  should skip — workspace reviews against a phantom path would just fail). */
async function isUsableWorkspace(workspaceRoot: string): Promise<boolean> {
  try {
    await fs.access(path.join(workspaceRoot, '.git'));
    return true;
  } catch {
    return false;
  }
}

/** Run a pipeline review (coder + deploy combined). Blocks the caller until
 *  the reviewer finishes (or times out) so feedback shows BEFORE the task
 *  flips to 'review' status. Caller must already be on the main pipeline
 *  thread — concurrent invocations on the same workspaceRoot are unsafe. */
export async function triggerPipelineReview(
  io: SocketServer,
  taskId: string,
  ctx: PipelineReviewContext,
): Promise<{ feedback: string | null }> {
  try {
    const task = store.getTask(taskId);
    if (!task) return { feedback: null };
    if (!reviewerEnabled(task)) return { feedback: null };
    if (!(await isUsableWorkspace(ctx.workspaceRoot))) {
      logger.warn(
        { taskId, workspaceRoot: ctx.workspaceRoot },
        'reviewer-trigger: workspace not usable, skipping pipeline review',
      );
      return { feedback: null };
    }

    // Build the prompt context with diff stat + changed files.
    const diffCtx = await collectDiffContext(ctx.workspaceRoot, ctx.sha, ctx.baseSha);

    // Compose deploy-augmented coder summary (always present in coder-* runs;
    // serves as the validation block for 'deploy' kind too).
    let mergedSummary: string | undefined = ctx.coderSummary;
    if (ctx.devUrl || ctx.validationHealthy !== undefined || ctx.validationSummary) {
      const lines: string[] = [];
      if (ctx.coderSummary) {
        lines.push(ctx.coderSummary);
        lines.push('');
      }
      lines.push('### Deploy + validation outcome');
      if (ctx.devUrl) lines.push(`- Dev URL: ${ctx.devUrl}`);
      if (ctx.validationHealthy !== undefined) {
        lines.push(`- Validation: ${ctx.validationHealthy ? 'healthy ✅' : 'NOT healthy ⚠️ (cap or preempt)'}`);
      }
      if (ctx.validateAttemptsUsed !== undefined) {
        lines.push(`- Validate attempts used: ${ctx.validateAttemptsUsed}`);
      }
      if (ctx.validationSummary) {
        lines.push('');
        lines.push(ctx.validationSummary);
      }
      mergedSummary = lines.join('\n');
    }

    // Build the discriminated-union review context per kind.
    let reviewCtx: ReviewContext;
    if (ctx.kind === 'deploy') {
      reviewCtx = {
        kind: 'deploy',
        workspaceRoot: ctx.workspaceRoot,
        sha: ctx.sha,
        taskTitle: task.title,
        taskDescription: task.description,
        ...(task.spec ? { spec: task.spec } : {}),
        ...(ctx.devUrl ? { devUrl: ctx.devUrl } : {}),
        ...(ctx.validationHealthy !== undefined
          ? { validationOutcome: (ctx.validationHealthy ? 'healthy' : 'exhausted') as 'healthy' | 'exhausted' }
          : {}),
        ...(mergedSummary ? { validationSummary: mergedSummary } : {}),
      };
    } else {
      reviewCtx = {
        kind: ctx.kind,
        workspaceRoot: ctx.workspaceRoot,
        sha: ctx.sha,
        taskTitle: task.title,
        taskDescription: task.description,
        ...(task.spec ? { spec: task.spec } : {}),
        ...(mergedSummary ? { coderSummary: mergedSummary } : {}),
        ...(diffCtx.diffStat ? { diffStat: diffCtx.diffStat } : {}),
        ...(diffCtx.changedFiles ? { changedFiles: diffCtx.changedFiles } : {}),
      };
    }

    const reviewerCfg = reviewerConfig(task);
    logger.info(
      {
        taskId,
        sha: ctx.sha,
        kind: ctx.kind,
        model: reviewerCfg.model ?? '(default)',
        effort: reviewerCfg.reasoningEffort ?? '(auto)',
      },
      'reviewer-trigger: starting pipeline review',
    );
    const result = await reviewEvent(reviewCtx, reviewerCfg);
    if (!result.feedback) {
      logger.info({ taskId, reason: result.reason }, 'reviewer-trigger: pipeline review — no feedback');
      return { feedback: null };
    }
    postReviewerChat(io, taskId, formatFeedbackForChat(ctx.kind, result.feedback));
    persistFeedback(taskId, ctx.kind, result.feedback, ctx.sha);
    return { feedback: result.feedback };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ taskId, err: msg }, 'reviewer-trigger: pipeline review threw (swallowed)');
    return { feedback: null };
  }
}

/**
 * Consume reviewer feedback to inject into the next coder turn.
 *
 * Returns the formatted text (suitable for prepending to a follow-up prompt)
 * AND mutates the task to either:
 *   - increment the attempts counter and drop the entry from the queue, OR
 *   - if the per-kind cap is reached, surface the feedback as unresolved to
 *     the user and drop the entry without further injection.
 *
 * Returns `null` when there's nothing to inject.
 */
export function consumeReviewerFeedbackForCoder(
  io: SocketServer,
  taskId: string,
): string | null {
  const task = store.getTask(taskId);
  if (!task) return null;
  const queue = task.pendingReviewerFeedback ?? [];
  if (queue.length === 0) return null;

  // Drop stale feedback: workspace-anchored entries whose sha no longer
  // matches the task's current HEAD (commitSha) are considered superseded.
  const currentSha = task.commitSha;
  const fresh = queue.filter((entry) => {
    if (!entry.sha) return true; // spec-level feedback never goes stale
    if (!currentSha) return true; // no current sha known — keep
    return entry.sha === currentSha;
  });
  if (fresh.length === 0) {
    store.updateTask(taskId, { pendingReviewerFeedback: [] });
    return null;
  }

  // Per-kind attempt budget. If injecting would push us past the cap, surface
  // to the user as unresolved and stop the loop.
  const attemptsMap = { ...(task.reviewerAttempts ?? {}) } as Partial<
    Record<ReviewerFeedbackKind, number>
  >;
  const linesToInject: string[] = [];
  const remaining: typeof fresh = [];
  for (const entry of fresh) {
    const used = attemptsMap[entry.kind] ?? 0;
    if (used >= REVIEWER_MAX_ATTEMPTS) {
      // Surface as unresolved — user-visible warning.
      const warn = store.addChatMessage(
        taskId,
        'system',
        `⚠️ Reviewer flagged this ${REVIEWER_MAX_ATTEMPTS} times but the coder hasn't resolved it. Not auto-injecting again. Latest feedback:\n\n${entry.text}`,
      );
      if (warn) io.to(`task:${taskId}`).emit('chat:message', warn);
      continue; // drop entry
    }
    linesToInject.push(`(${entry.kind}, sha=${entry.sha ? entry.sha.substring(0, 7) : '—'})\n${entry.text}`);
    attemptsMap[entry.kind] = used + 1;
  }
  // Drop everything fresh (consumed or surfaced); keep nothing pending.
  store.updateTask(taskId, {
    pendingReviewerFeedback: remaining,
    reviewerAttempts: attemptsMap,
  });
  if (linesToInject.length === 0) return null;
  return [
    '## Reviewer feedback from previous step',
    '',
    'The Reviewer Agent flagged the following concerns. Address them in this',
    'turn (or explain why they do not apply):',
    '',
    ...linesToInject.map((line) => line),
  ].join('\n');
}
