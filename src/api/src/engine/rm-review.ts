/**
 * Release Manager (RM) — deterministic PR review + merge/bounce decision.
 *
 * The RM never "decides" subjectively. It runs a fixed checklist against
 * the live state of the PR and produces one of three actions:
 *
 *   merge            — all checks green, AC checked, PR clean → merge + close issue
 *   request-changes  — checks failing OR AC unchecked → label `rm:changes-requested`
 *                       + structured comment with a marker counting attempts.
 *   escalate         — attempts >= MAX_ATTEMPTS (3) → label `blocked:human`.
 *
 * Idempotency: every state mutation is safe to repeat. Re-running the RM on
 * an already-merged PR is a no-op. Re-applying a label is a no-op.
 *
 * Why we explicitly close the issue: GitHub auto-closes `Closes #N` issues
 * only when the PR merges into the repo's default branch. Liliput often
 * targets integration branches, so we PATCH the issue to closed ourselves.
 */

import {
  getPullRequest,
  listCheckRunsForRef,
  mergePullRequest,
  closeIssue,
  addLabels,
  removeLabel,
  addComment,
  listIssueComments,
  GitHubApiError,
  type PullRequestData,
  type CheckRun,
  type FetchImpl,
} from './github-rest.js';
import { extractCampaignCycleMarker } from './github-pr.js';
import * as featureStore from '../stores/feature-store.js';
import * as taskStore from '../stores/task-store.js';
import { logger } from '../logger.js';

/** Marker used to count attempts via comment listing — no extra DB column. */
const ATTEMPT_MARKER_RE = /<!--\s*liliput:rm:attempt=(\d+)\s*-->/g;
export const MAX_ATTEMPTS = 3;

export type RmAction = 'merge' | 'request-changes' | 'escalate' | 'skip';

export interface RmDecision {
  action: RmAction;
  /** Human-readable lines summarising why. Surfaced in the PR comment. */
  reasons: string[];
  /** Per-check status — used to render the structured comment. */
  checks: ChecklistItem[];
  /** Attempt number for the action being taken (1-based). */
  attempt: number;
  /** PR head SHA at the time of review. */
  headSha?: string;
}

export interface ChecklistItem {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface RmDeps {
  fetchImpl?: FetchImpl;
}

/** Run a full review pass. Returns the action taken plus a structured
 *  decision object for tests / logs. */
export async function runRmReview(
  repo: string,
  prNumber: number,
  deps: RmDeps = {},
): Promise<RmDecision> {
  const f = deps.fetchImpl;

  // 1. Load PR.
  let pr: PullRequestData;
  try {
    pr = await getPullRequest({ repo, number: prNumber, ...(f && { fetchImpl: f }) });
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 404) {
      logger.info({ repo, prNumber }, 'rm: PR not found — skipping');
      return { action: 'skip', reasons: ['PR not found'], checks: [], attempt: 0 };
    }
    throw err;
  }
  if (
    extractCampaignCycleMarker(pr.body) ||
    taskStore.findCampaignTaskByPullRequest(repo, prNumber)
  ) {
    return {
      action: 'skip',
      reasons: ['campaign-managed PR'],
      checks: [],
      attempt: 0,
      headSha: pr.head.sha,
    };
  }

  // 2. Fast skips — closed/merged/draft.
  if (pr.merged) {
    return { action: 'skip', reasons: ['already merged'], checks: [], attempt: 0, headSha: pr.head.sha };
  }
  if (pr.state === 'closed') {
    return { action: 'skip', reasons: ['PR closed'], checks: [], attempt: 0, headSha: pr.head.sha };
  }
  if (pr.draft) {
    return { action: 'skip', reasons: ['draft PR'], checks: [], attempt: 0, headSha: pr.head.sha };
  }

  // 3. Map to Feature → linked issue.
  const feature = featureStore.findByGithubPr(repo, prNumber);
  const issueNumber = feature?.githubIssueNumber ?? extractClosesIssueNumber(pr.body ?? '');

  // 4. Load checks.
  const checks = await listCheckRunsForRef({
    repo,
    ref: pr.head.sha,
    ...(f && { fetchImpl: f }),
  });

  // 5. Count past attempts via the linked issue (preferred) or PR comments.
  const commentSource = issueNumber ?? prNumber;
  const comments = await listIssueComments({
    repo,
    issueNumber: commentSource,
    ...(f && { fetchImpl: f }),
  });
  const pastAttempts = countAttempts(comments.map((c) => c.body));
  const thisAttempt = pastAttempts + 1;

  // 6. Run the checklist.
  const checklist = buildChecklist({ pr, checks, issueNumber, body: pr.body ?? '' });
  const allPassed = checklist.every((c) => c.passed);

  // 7. Decide.
  let action: RmAction;
  if (allPassed) {
    action = 'merge';
  } else if (pastAttempts >= MAX_ATTEMPTS) {
    action = 'escalate';
  } else {
    action = 'request-changes';
  }

  const decision: RmDecision = {
    action,
    reasons: checklist.filter((c) => !c.passed).map((c) => `${c.name}${c.detail ? `: ${c.detail}` : ''}`),
    checks: checklist,
    attempt: thisAttempt,
    headSha: pr.head.sha,
  };

  // 8. Execute the action.
  try {
    await applyDecision({
      repo,
      pr,
      issueNumber,
      decision,
      fetchImpl: f,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ repo, prNumber, action, err: msg }, 'rm: applyDecision failed');
    throw err;
  }

  return decision;
}

interface ChecklistInput {
  pr: PullRequestData;
  checks: CheckRun[];
  issueNumber: number | null;
  body: string;
}

/** Pure function — no side effects. Returns the ordered checklist with
 *  pass/fail + details. The first failure short-circuits to
 *  `request-changes`; the comment lists every item so the developer
 *  sees the full picture. */
export function buildChecklist(input: ChecklistInput): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const { pr, checks, issueNumber, body } = input;

  // CHECK 1: PR is mergeable.
  items.push({
    name: 'PR is mergeable',
    passed: pr.mergeable === true && pr.mergeable_state !== 'dirty',
    detail:
      pr.mergeable === null
        ? `mergeable status still computing (state="${pr.mergeable_state}") — will retry on next event`
        : pr.mergeable === false
          ? `merge conflict (state="${pr.mergeable_state}")`
          : pr.mergeable_state === 'dirty'
            ? 'branch has conflicts'
            : undefined,
  });

  // CHECK 2: All required CI checks green.
  const failing = checks.filter(
    (c) =>
      c.status === 'completed' &&
      c.conclusion !== 'success' &&
      c.conclusion !== 'neutral' &&
      c.conclusion !== 'skipped',
  );
  const pending = checks.filter((c) => c.status !== 'completed');
  items.push({
    name: 'CI checks passing',
    passed: failing.length === 0 && pending.length === 0,
    detail:
      failing.length > 0
        ? `failing: ${failing.map((c) => `${c.name}(${c.conclusion})`).join(', ')}`
        : pending.length > 0
          ? `still running: ${pending.map((c) => c.name).join(', ')}`
          : undefined,
  });

  // CHECK 3: PR closes the linked issue.
  const closesNum = extractClosesIssueNumber(body);
  items.push({
    name: 'PR closes the linked issue',
    passed: issueNumber !== null && closesNum === issueNumber,
    detail:
      issueNumber === null
        ? 'no linked Feature / issue mapping found'
        : closesNum === null
          ? `PR body is missing "Closes #${issueNumber}"`
          : closesNum !== issueNumber
            ? `PR closes #${closesNum} but linked issue is #${issueNumber}`
            : undefined,
  });

  // CHECK 4: Acceptance criteria checkboxes all ticked.
  const acTotal = countCheckboxes(body, /- \[[ xX]\] /g);
  const acChecked = countCheckboxes(body, /- \[[xX]\] /g);
  items.push({
    name: 'Acceptance criteria checked',
    passed: acTotal === 0 ? true : acChecked === acTotal,
    detail:
      acTotal === 0
        ? 'no AC checkboxes found — passing by default'
        : acChecked < acTotal
          ? `${acChecked}/${acTotal} AC boxes checked`
          : undefined,
  });

  // CHECK 5: No human-block label is set.
  const labels = pr.labels.map((l) => l.name);
  items.push({
    name: 'No `blocked:human` label',
    passed: !labels.includes('blocked:human'),
    detail: labels.includes('blocked:human') ? 'PR is currently escalated to a human' : undefined,
  });

  return items;
}

interface ApplyDecisionArgs {
  repo: string;
  pr: PullRequestData;
  issueNumber: number | null;
  decision: RmDecision;
  fetchImpl?: FetchImpl;
}

async function applyDecision(args: ApplyDecisionArgs): Promise<void> {
  const { repo, pr, issueNumber, decision, fetchImpl } = args;
  const prNumber = pr.number;
  const fOpt = fetchImpl ? { fetchImpl } : {};

  switch (decision.action) {
    case 'skip':
      return;

    case 'merge': {
      // Merge first, then close the issue, then label `done`. If merge
      // fails (e.g., 405 not-mergeable), we don't touch the issue.
      await mergePullRequest({
        repo,
        number: prNumber,
        sha: pr.head.sha,
        mergeMethod: 'squash',
        commitTitle: `${pr.title} (#${prNumber})`,
        ...fOpt,
      });
      // Best-effort: close the linked issue + comment + label done.
      if (issueNumber !== null) {
        await safeCloseIssue(repo, issueNumber, fetchImpl);
        await safeAddLabels(repo, issueNumber, ['done'], fetchImpl);
        await safeRemoveLabel(repo, issueNumber, 'rm:review', fetchImpl);
      }
      await safeAddLabels(repo, prNumber, ['done'], fetchImpl);
      await safeRemoveLabel(repo, prNumber, 'rm:review', fetchImpl);
      await safeComment(
        repo,
        prNumber,
        renderMergeComment(decision),
        fetchImpl,
      );
      logger.info({ repo, prNumber, issueNumber }, 'rm: merged and closed');
      return;
    }

    case 'request-changes': {
      // Apply label first so the dev agent (subscribed to `rm:changes-requested`)
      // wakes up only AFTER the structured comment is in place.
      await safeComment(repo, prNumber, renderChangesRequestedComment(decision), fetchImpl);
      await safeAddLabels(repo, prNumber, ['rm:changes-requested'], fetchImpl);
      await safeRemoveLabel(repo, prNumber, 'rm:review', fetchImpl);
      logger.info(
        { repo, prNumber, attempt: decision.attempt },
        'rm: changes requested',
      );
      return;
    }

    case 'escalate': {
      await safeComment(repo, prNumber, renderEscalationComment(decision), fetchImpl);
      await safeAddLabels(repo, prNumber, ['blocked:human'], fetchImpl);
      await safeRemoveLabel(repo, prNumber, 'rm:review', fetchImpl);
      if (issueNumber !== null) {
        await safeAddLabels(repo, issueNumber, ['blocked:human'], fetchImpl);
      }
      logger.warn({ repo, prNumber }, 'rm: escalated to human');
      return;
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

/** Parse "Closes #123", "closes #123", "fixes #45", "resolves #6" from a PR body. */
export function extractClosesIssueNumber(body: string): number | null {
  const re = /\b(?:closes|fixes|resolves)\s+#(\d+)\b/i;
  const m = re.exec(body);
  return m ? Number(m[1]) : null;
}

function countCheckboxes(body: string, re: RegExp): number {
  const matches = body.match(re);
  return matches ? matches.length : 0;
}

/** Count past attempts by scanning every previous bot comment for the
 *  `<!-- liliput:rm:attempt=N -->` marker. The max N seen is the attempts. */
export function countAttempts(commentBodies: string[]): number {
  let max = 0;
  for (const body of commentBodies) {
    ATTEMPT_MARKER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ATTEMPT_MARKER_RE.exec(body)) !== null) {
      const n = Number(m[1]);
      if (n > max) max = n;
    }
  }
  return max;
}

function renderChangesRequestedComment(d: RmDecision): string {
  const lines = [
    `<!-- liliput:rm:attempt=${d.attempt} -->`,
    `### Release Manager review — changes requested (attempt ${d.attempt}/${MAX_ATTEMPTS})`,
    '',
    'The deterministic checklist found the following blockers:',
    '',
  ];
  for (const c of d.checks) {
    lines.push(`- ${c.passed ? '✅' : '❌'} ${c.name}${c.detail ? ` — _${c.detail}_` : ''}`);
  }
  lines.push('');
  lines.push(
    `Push fixes to this branch. The RM re-reviews automatically on every push. ` +
      `After ${MAX_ATTEMPTS} failed attempts, the PR is escalated with the \`blocked:human\` label.`,
  );
  return lines.join('\n');
}

function renderEscalationComment(d: RmDecision): string {
  return [
    `<!-- liliput:rm:attempt=${d.attempt} -->`,
    `### Release Manager — escalated to human (attempt ${d.attempt}/${MAX_ATTEMPTS} reached)`,
    '',
    'The deterministic checklist failed on every attempt. A human reviewer must take it from here.',
    '',
    'Remaining blockers:',
    ...d.checks.filter((c) => !c.passed).map((c) => `- ❌ ${c.name}${c.detail ? ` — _${c.detail}_` : ''}`),
  ].join('\n');
}

function renderMergeComment(d: RmDecision): string {
  return [
    '### Release Manager — merged ✅',
    '',
    'All checklist items passed:',
    ...d.checks.map((c) => `- ✅ ${c.name}`),
  ].join('\n');
}

// Wrappers that swallow 404 / "already applied" failures — RM should never
// crash the dispatcher because of a stale label or a deleted comment.
async function safeAddLabels(
  repo: string,
  num: number,
  labels: string[],
  fetchImpl?: FetchImpl,
): Promise<void> {
  try {
    await addLabels({ repo, issueNumber: num, labels, ...(fetchImpl && { fetchImpl }) });
  } catch (err) {
    logger.warn({ repo, num, labels, err: errMsg(err) }, 'rm: addLabels failed (ignored)');
  }
}

async function safeRemoveLabel(
  repo: string,
  num: number,
  label: string,
  fetchImpl?: FetchImpl,
): Promise<void> {
  try {
    await removeLabel({ repo, issueNumber: num, label, ...(fetchImpl && { fetchImpl }) });
  } catch (err) {
    logger.warn({ repo, num, label, err: errMsg(err) }, 'rm: removeLabel failed (ignored)');
  }
}

async function safeComment(
  repo: string,
  num: number,
  body: string,
  fetchImpl?: FetchImpl,
): Promise<void> {
  try {
    await addComment({ repo, issueNumber: num, body, ...(fetchImpl && { fetchImpl }) });
  } catch (err) {
    logger.warn({ repo, num, err: errMsg(err) }, 'rm: addComment failed (ignored)');
  }
}

async function safeCloseIssue(
  repo: string,
  num: number,
  fetchImpl?: FetchImpl,
): Promise<void> {
  try {
    await closeIssue({ repo, number: num, ...(fetchImpl && { fetchImpl }) });
  } catch (err) {
    logger.warn({ repo, num, err: errMsg(err) }, 'rm: closeIssue failed (ignored)');
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
