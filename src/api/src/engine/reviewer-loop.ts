/**
 * Reviewer Agent — a second Copilot SDK session that watches the work of the
 * coder/spec/deploy phases and posts feedback to chat ONLY when it finds
 * something important (bug, security issue, missed requirement, wrong
 * approach). Silent otherwise.
 *
 * Design tenets:
 *  - SERIALIZED — never runs concurrently with the coder. Triggered at stable
 *    gates: after spec draft (no workspace), after `commitAndPush` (HEAD is a
 *    known SHA), and after `validateAndHealLoop` reaches steady-state.
 *  - EPHEMERAL — one fresh SDK session per review event; disposed after.
 *  - COMMIT-ANCHORED — workspace reviews are anchored to the just-committed
 *    SHA, so feedback can be matched against HEAD when the coder consumes it.
 *  - DEFENSIVE — after every workspace review, `git reset --hard HEAD &&
 *    git clean -fd` undoes any accidental writes from the reviewer (the
 *    prompt says "read-only" but we don't trust prompts for safety).
 *  - BOUNDED — capped by `REVIEWER_TIMEOUT_MS` (default 120s). Any failure
 *    is logged and treated as "no feedback" — the main pipeline never
 *    breaks because the reviewer hiccupped.
 */

import { approveAll } from '@github/copilot-sdk';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { getCopilotClient, isSdkConnectionClosed, resetCopilotClient } from './copilot-client.js';
import {
  deriveReasoningEffort,
  type ReasoningEffort,
  type ReviewerFeedback,
  type ReviewerFeedbackKind,
} from '../../../shared/types/index.js';
import { setForceEffort } from './force-effort.js';
import { logger } from '../logger.js';
import type { UsageFn } from './agent-loop.js';
import { registerTaskAborter } from './task-interrupt-registry.js';

const execFileP = promisify(execFile);

const REVIEWER_TIMEOUT_MS = parseInt(process.env['REVIEWER_TIMEOUT_MS'] ?? '120000', 10);
const REVIEWER_DEFAULT_MODEL =
  process.env['COPILOT_REVIEWER_MODEL'] ?? process.env['COPILOT_MODEL'] ?? 'claude-sonnet-4.5';
/** Max times the same feedback "kind" can be auto-injected into a coder
 *  prompt before we stop the loop and surface it as unresolved. */
export const REVIEWER_MAX_ATTEMPTS = parseInt(process.env['REVIEWER_MAX_ATTEMPTS'] ?? '3', 10);

const FIRST_LINE_NO_FEEDBACK = /^no[\s-]?feedback\b/i;
const FIRST_LINE_FEEDBACK = /^feedback\b/i;

export interface ReviewerConfig {
  /** Optional model override. Falls back to `COPILOT_REVIEWER_MODEL` env. */
  model?: string;
  /** Optional reasoning-effort override. Auto-derived from model id suffix
   *  when missing (e.g. `*-xhigh` → 'xhigh'). */
  reasoningEffort?: ReasoningEffort;
  taskId?: string;
  onUsage?: UsageFn;
}

function forwardUsageEvent(
  event: { type: string; data?: unknown },
  onUsage: UsageFn | undefined,
): void {
  if (!onUsage || event.type !== 'assistant.usage') return;
  const data = event.data as {
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    duration?: number;
    copilotUsage?: { totalNanoAiu?: number };
  };
  onUsage({
    model: data.model,
    ...(data.inputTokens != null ? { inputTokens: data.inputTokens } : {}),
    ...(data.outputTokens != null ? { outputTokens: data.outputTokens } : {}),
    ...(data.cacheReadTokens != null
      ? { cacheReadTokens: data.cacheReadTokens }
      : {}),
    ...(data.cacheWriteTokens != null
      ? { cacheWriteTokens: data.cacheWriteTokens }
      : {}),
    ...(data.copilotUsage?.totalNanoAiu != null
      ? { nanoAiu: data.copilotUsage.totalNanoAiu }
      : {}),
    ...(data.duration != null ? { durationMs: data.duration } : {}),
  });
}

export interface ReviewContextSpec {
  kind: 'spec';
  /** Repository the task targets (e.g. "owner/repo"). Optional. */
  repository?: string;
  taskTitle: string;
  taskDescription: string;
  /** The generated spec markdown the reviewer should critique. */
  spec: string;
}

export interface ReviewContextCoder {
  kind: 'coder-initial' | 'coder-iter';
  /** Absolute path to the cloned workspace (so the reviewer can `read`,
   *  `grep`, `glob`, `bash`). The reviewer's prompt says "read-only" and
   *  any accidental writes are reverted after the turn. */
  workspaceRoot: string;
  /** The SHA the coder just committed. Used to (a) bind feedback to a
   *  stable commit for staleness checking, and (b) revert the worktree
   *  after the review turn if the reviewer wrote anything. */
  sha: string;
  taskTitle: string;
  taskDescription: string;
  spec?: string;
  /** The coder's own final summary / VERDICT line, captured from
   *  `runAgentTurn`'s result. Helps the reviewer cross-check claims. */
  coderSummary?: string;
  /** Output of `git diff --stat baseSha..HEAD` (or equivalent). Truncated
   *  by the caller if huge. */
  diffStat?: string;
  /** List of changed file paths (one per line). */
  changedFiles?: string[];
}

export interface ReviewContextDeploy {
  kind: 'deploy';
  workspaceRoot: string;
  sha: string;
  taskTitle: string;
  taskDescription: string;
  spec?: string;
  /** Live dev URL the user will eventually browse. */
  devUrl?: string;
  /** Summary of the validation/heal loop outcome. */
  validationSummary?: string;
  /** Was the validate loop "healthy" or "exhausted"? */
  validationOutcome?: 'healthy' | 'exhausted';
}

export type ReviewContext = ReviewContextSpec | ReviewContextCoder | ReviewContextDeploy | ReviewContextPlan;

export interface ReviewContextPlan {
  kind: 'plan';
  /** Repository the task targets (e.g. "owner/repo"). Optional. */
  repository?: string;
  taskTitle: string;
  /** The (possibly rewritten) request the plan is meant to satisfy. */
  taskDescription: string;
  /** The Architect's implementation plan markdown the critic should critique. */
  plan: string;
}

export interface ReviewResult {
  /** Parsed feedback. Null when the reviewer said NO-FEEDBACK or when the
   *  call failed / timed out (we never break the pipeline on reviewer
   *  failures — the conservative interpretation is "no feedback"). */
  feedback: string | null;
  /** True when the reviewer call actually ran end-to-end (vs. timed out /
   *  errored / was disabled by config). Useful for activity logging. */
  ran: boolean;
  /** Raw reply for debugging. Truncated to first 2000 chars. */
  rawReply?: string;
  /** Reason this review didn't produce feedback (when feedback === null). */
  reason?:
    | 'no-feedback'         // Reviewer explicitly said NO-FEEDBACK
    | 'parse-failed'        // Reply didn't match the expected first-line format
    | 'timeout'
    | 'sdk-error'
    | 'disabled'            // Reviewer is disabled on this task
    | 'attempts-exhausted'; // Per-kind retry cap hit
}

function buildSystemPreamble(): string {
  return [
    'You are the **Reviewer Agent** for Liliput. A different agent (the Coder)',
    'just produced some work (a spec, a code change, or a deploy outcome). Your',
    'job is to spot IMPORTANT problems the Coder may have missed — correctness',
    'bugs, security holes, missed requirements, wrong approach, dangerous edits.',
    '',
    '🛑 You are READ-ONLY. Do NOT write, edit, create, or delete files. Do NOT',
    'commit, push, or run any command that mutates state. Use only `read`,',
    '`grep`, `glob`, and read-only `bash` (e.g. `git log`, `git diff`,',
    '`cat`, `ls`, `wc -l`). Liliput sanitises the worktree after your turn',
    'so any accidental writes will be reverted — keep yourself honest.',
    '',
    '🎚 Be DISCERNING. Silence is the default. Only speak up when the issue is',
    'genuinely important — something a careful senior engineer would block a PR',
    'on. Do NOT comment on:',
    '  - style, formatting, naming, comments',
    '  - missing tests UNLESS the change is risky and has zero coverage',
    '  - things the Coder already addressed correctly',
    '  - hypothetical "could be better" refactors with no concrete bug',
    '',
    '✅ DO flag (when present):',
    '  - logic bugs, off-by-one, wrong condition, broken happy path',
    '  - security holes: missing auth check, secret leak, injection, XSS,',
    '    insecure default, weakened crypto, sensitive data in logs',
    '  - acceptance-criteria items the Coder skipped or implemented wrong',
    '  - architectural mismatch with the existing codebase patterns',
    '  - dependency / config changes that will break prod (wrong env var,',
    '    breaking semver bump, dropped TLS, public exposure)',
    '',
    '📝 OUTPUT FORMAT (strict — Liliput parses your first line):',
    '',
    '  Either reply with EXACTLY this single token (case-insensitive) and nothing else:',
    '      NO-FEEDBACK',
    '',
    '  OR start your reply with the literal token (case-insensitive):',
    '      FEEDBACK',
    '  followed by 1 to 3 short bullet points (`- …`) describing the concrete issues.',
    '  Keep each bullet under 200 characters. Reference file paths, line numbers,',
    '  or commit SHAs where useful. Do not include preamble like "After reviewing,..."',
    '  before the FEEDBACK token.',
    '',
    'If you are unsure whether something matters, lean toward NO-FEEDBACK.',
  ].join('\n');
}

function buildSpecPrompt(ctx: ReviewContextSpec): string {
  return [
    buildSystemPreamble(),
    '',
    '---',
    '',
    '## What you are reviewing now: **the draft specification**',
    '',
    `Target repository: ${ctx.repository ?? '(none specified)'}`,
    `Task title: ${ctx.taskTitle}`,
    '',
    '### User request',
    '',
    ctx.taskDescription,
    '',
    '### Draft specification',
    '',
    '```markdown',
    ctx.spec,
    '```',
    '',
    'Review the spec. Important things to look for:',
    '  - Acceptance Criteria that contradict the user request, are unverifiable, or miss a major requirement',
    '  - Technical Approach that fights the existing repo conventions',
    '  - Out-of-Scope that excludes something the user explicitly asked for',
    '  - Gherkin scenarios that are vague, use placeholders, or do not map to the AC items',
    '  - Security/auth/data-handling implications the spec ignores',
    '',
    'Reply with `NO-FEEDBACK` or `FEEDBACK\\n- …` per the format above.',
  ].join('\n');
}

function buildCoderPrompt(ctx: ReviewContextCoder): string {
  const isInitial = ctx.kind === 'coder-initial';
  return [
    buildSystemPreamble(),
    '',
    '---',
    '',
    `## What you are reviewing now: **the Coder's ${isInitial ? 'initial' : 'follow-up'} commit**`,
    '',
    `Task title: ${ctx.taskTitle}`,
    `Workspace: ${ctx.workspaceRoot}`,
    `Reviewed commit: \`${ctx.sha}\``,
    '',
    '### Original user request',
    '',
    ctx.taskDescription,
    '',
    ctx.spec ? '### Approved specification' : '',
    ctx.spec ? '' : '',
    ctx.spec ? '```markdown' : '',
    ctx.spec ?? '',
    ctx.spec ? '```' : '',
    ctx.spec ? '' : '',
    ctx.coderSummary ? '### Coder\'s self-reported summary / verdict' : '',
    ctx.coderSummary ? '' : '',
    ctx.coderSummary ?? '',
    ctx.coderSummary ? '' : '',
    ctx.diffStat ? '### `git diff --stat` of the reviewed commit' : '',
    ctx.diffStat ? '' : '',
    ctx.diffStat ? '```' : '',
    ctx.diffStat ?? '',
    ctx.diffStat ? '```' : '',
    ctx.diffStat ? '' : '',
    ctx.changedFiles && ctx.changedFiles.length > 0 ? '### Changed files' : '',
    ctx.changedFiles && ctx.changedFiles.length > 0 ? '' : '',
    ...(ctx.changedFiles && ctx.changedFiles.length > 0
      ? ctx.changedFiles.map((f) => `- \`${f}\``)
      : []),
    '',
    'You are inside the working directory of the cloned target repo at the reviewed SHA.',
    'Use `git diff HEAD~1..HEAD -- <file>` (read-only) to inspect changes, `cat` or',
    'the `read` tool to read full files, `grep` to search. Do NOT run tests, build,',
    'or any command with side effects — the next pipeline phase handles that.',
    '',
    'Reply with `NO-FEEDBACK` or `FEEDBACK\\n- …` per the format above.',
  ]
    .filter((s) => s !== '')
    .join('\n');
}

function buildDeployPrompt(ctx: ReviewContextDeploy): string {
  return [
    buildSystemPreamble(),
    '',
    '---',
    '',
    '## What you are reviewing now: **the deploy + validation outcome**',
    '',
    `Task title: ${ctx.taskTitle}`,
    `Workspace: ${ctx.workspaceRoot}`,
    `Deployed commit: \`${ctx.sha}\``,
    `Dev URL: ${ctx.devUrl ?? '(not available)'}`,
    `Validation outcome: ${ctx.validationOutcome ?? '(unknown)'}`,
    '',
    '### Original user request',
    '',
    ctx.taskDescription,
    '',
    ctx.spec ? '### Approved specification' : '',
    ctx.spec ? '' : '',
    ctx.spec ? '```markdown' : '',
    ctx.spec ?? '',
    ctx.spec ? '```' : '',
    ctx.spec ? '' : '',
    ctx.validationSummary ? '### Validation summary' : '',
    ctx.validationSummary ? '' : '',
    ctx.validationSummary ?? '',
    '',
    'Important things to look for:',
    '  - Validation reports "healthy" but key acceptance scenarios are not actually covered',
    '  - Build output / startup logs hint at a config problem (missing env, wrong port)',
    '  - Health probes pass but the dev URL would return a stub / 404 / error page',
    '  - Deploy left behind secrets, debug toggles, or insecure defaults',
    '',
    'You may `curl` the dev URL (read-only HEAD/GET) and `kubectl` is available for',
    'reads (logs, get pods). Do NOT redeploy or apply changes — flag concerns only.',
    '',
    'Reply with `NO-FEEDBACK` or `FEEDBACK\\n- …` per the format above.',
  ]
    .filter((s) => s !== '')
    .join('\n');
}

function buildPlanPrompt(ctx: ReviewContextPlan): string {
  return [
    buildSystemPreamble(),
    '',
    '---',
    '',
    '## What you are reviewing now: **the implementation plan**',
    '',
    `Target repository: ${ctx.repository ?? '(none specified)'}`,
    `Task title: ${ctx.taskTitle}`,
    '',
    '### User request',
    '',
    ctx.taskDescription,
    '',
    '### Proposed implementation plan',
    '',
    '```markdown',
    ctx.plan,
    '```',
    '',
    'Critique the plan BEFORE any code is written. Important things to look for:',
    '  - Steps that miss a major requirement from the user request',
    '  - A sequencing/dependency mistake that will cause rework',
    '  - An approach that fights the existing repo conventions or is needlessly risky',
    '  - Security / data-handling concerns the plan ignores',
    '  - Missing test or verification steps for the core behavior',
    '',
    'Reply with `NO-FEEDBACK` or `FEEDBACK\\n- …` per the format above.',
  ]
    .filter((s) => s !== '')
    .join('\n');
}

/** Parse the reviewer's reply. Lenient on whitespace and case but strict on
 *  the first-line token so positive boilerplate ("Looks good — NO-FEEDBACK")
 *  doesn't get mis-parsed. */
export function parseReviewerReply(raw: string): { feedback: string | null; matched: boolean } {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { feedback: null, matched: false };
  const firstLine = trimmed.split('\n')[0]?.trim() ?? '';
  if (FIRST_LINE_NO_FEEDBACK.test(firstLine)) {
    return { feedback: null, matched: true };
  }
  if (FIRST_LINE_FEEDBACK.test(firstLine)) {
    // Strip the leading FEEDBACK token + optional separator (": " or "—") and
    // return everything after the first line.
    const rest = trimmed.substring(firstLine.length).trim();
    return { feedback: rest.length > 0 ? rest : firstLine, matched: true };
  }
  return { feedback: null, matched: false };
}

/** Build the prompt for a given review context. Exported for tests. */
export function buildReviewPrompt(ctx: ReviewContext): string {
  switch (ctx.kind) {
    case 'spec':
      return buildSpecPrompt(ctx);
    case 'coder-initial':
    case 'coder-iter':
      return buildCoderPrompt(ctx);
    case 'deploy':
      return buildDeployPrompt(ctx);
    case 'plan':
      return buildPlanPrompt(ctx);
  }
}

function resolveModel(cfg: ReviewerConfig): { model: string; effort: ReasoningEffort | undefined } {
  const model = cfg.model && cfg.model.trim() ? cfg.model.trim() : REVIEWER_DEFAULT_MODEL;
  const effort = cfg.reasoningEffort ?? deriveReasoningEffort(model);
  return { model, effort };
}

/** Best-effort: revert any accidental writes the reviewer made. Called after
 *  every workspace-bound review. Logs but never throws — the next pipeline
 *  phase has its own retry safety. */
async function sanitiseWorkspace(workspaceRoot: string): Promise<void> {
  try {
    await execFileP('git', ['reset', '--hard', 'HEAD'], { cwd: workspaceRoot });
    await execFileP('git', ['clean', '-fd'], { cwd: workspaceRoot });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { workspaceRoot, err: msg },
      'reviewer-loop: post-review worktree sanitise failed (non-fatal)',
    );
  }
}

/** Run one reviewer turn for the given context. Never throws — failures are
 *  logged and surfaced as `{ feedback: null, ran: false }`. */
export async function reviewEvent(
  ctx: ReviewContext,
  cfg: ReviewerConfig,
): Promise<ReviewResult> {
  const { model, effort } = resolveModel(cfg);
  const prompt = buildReviewPrompt(ctx);
  const workspaceRoot = 'workspaceRoot' in ctx ? ctx.workspaceRoot : undefined;
  const startedAt = Date.now();
  logger.info(
    {
      kind: ctx.kind,
      model,
      effort,
      promptBytes: prompt.length,
      hasWorkspace: !!workspaceRoot,
    },
    'reviewer-loop: starting review turn',
  );

  // setForceEffort is a process-global state — safe here because the
  // reviewer runs SERIALIZED with the coder (never concurrent). The next
  // coder turn calls setForceEffort again with its own effort.
  setForceEffort(effort);

  let client;
  try {
    client = await getCopilotClient();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, 'reviewer-loop: getCopilotClient failed — skipping review');
    return { feedback: null, ran: false, reason: 'sdk-error' };
  }

  let session;
  try {
    session = await client.createSession({
      model,
      ...(effort ? { reasoningEffort: effort } : {}),
      ...(workspaceRoot ? { workingDirectory: workspaceRoot } : {}),
      enableConfigDiscovery: false, // Don't load target-repo skills for the reviewer
      onPermissionRequest: approveAll,
      onEvent: (event) => {
        forwardUsageEvent(event, cfg.onUsage);
      },
    });
    if (effort) {
      try {
        await session.setModel(model, { reasoningEffort: effort });
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), model, effort },
          'reviewer-loop: setModel(reasoningEffort) failed — continuing',
        );
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err: msg, model, effort },
      'reviewer-loop: createSession failed — skipping review',
    );
    if (isSdkConnectionClosed(err)) {
      void resetCopilotClient();
    }
    return { feedback: null, ran: false, reason: 'sdk-error' };
  }

  const unregisterAborter = cfg.taskId
    ? registerTaskAborter(cfg.taskId, () => session.abort())
    : () => undefined;
  let reply = '';
  let timedOut = false;
  try {
    const result = await session.sendAndWait({ prompt }, REVIEWER_TIMEOUT_MS);
    reply = result?.data?.content?.trim() ?? '';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // The SDK throws on timeout — heuristically detect it. We don't have a
    // typed error from the SDK for this; checking the message is enough.
    timedOut = /timeout|timed out|aborted/i.test(msg);
    logger.warn(
      { err: msg, timedOut, durationMs: Date.now() - startedAt },
      'reviewer-loop: sendAndWait failed — skipping feedback',
    );
    if (isSdkConnectionClosed(err)) {
      void resetCopilotClient();
    }
  } finally {
    unregisterAborter();
    try {
      await session.disconnect();
    } catch {
      // ignore — best-effort cleanup
    }
    if (workspaceRoot) {
      await sanitiseWorkspace(workspaceRoot);
    }
  }

  if (!reply) {
    return { feedback: null, ran: false, reason: timedOut ? 'timeout' : 'sdk-error' };
  }
  const truncatedRaw = reply.length > 2000 ? reply.substring(0, 2000) + '…' : reply;
  const parsed = parseReviewerReply(reply);
  if (!parsed.matched) {
    logger.info(
      { kind: ctx.kind, raw: truncatedRaw.split('\n')[0] },
      'reviewer-loop: reply did not match NO-FEEDBACK/FEEDBACK format — treating as no feedback',
    );
    return { feedback: null, ran: true, rawReply: truncatedRaw, reason: 'parse-failed' };
  }
  if (parsed.feedback === null) {
    logger.info(
      { kind: ctx.kind, durationMs: Date.now() - startedAt },
      'reviewer-loop: NO-FEEDBACK',
    );
    return { feedback: null, ran: true, rawReply: truncatedRaw, reason: 'no-feedback' };
  }
  logger.info(
    {
      kind: ctx.kind,
      durationMs: Date.now() - startedAt,
      feedbackBytes: parsed.feedback.length,
    },
    'reviewer-loop: feedback emitted',
  );
  return { feedback: parsed.feedback, ran: true, rawReply: truncatedRaw };
}

/** Convenience: build a ReviewerFeedback record from a review result + kind.
 *  Use this when persisting feedback to a Task's pendingReviewerFeedback queue. */
export function makeFeedbackRecord(
  kind: ReviewerFeedbackKind,
  text: string,
  sha?: string,
): ReviewerFeedback {
  return {
    id: randomUUID(),
    kind,
    text,
    ...(sha ? { sha } : {}),
    createdAt: new Date().toISOString(),
    attempts: 0,
  };
}
