/**
 * Loop reconciler — polling fallback for missed webhooks.
 *
 * Webhooks can be missed for many reasons:
 *   - Liliput pod was down when the event fired.
 *   - The repo's webhook is in `polling_fallback` (token lacks admin:repo_hook).
 *   - GitHub itself dropped the delivery (rare but documented).
 *
 * The reconciler walks every target repo on a timer and ensures:
 *
 *   1. Every open issue with label `pm:ready` is mapped to a Feature and has
 *      been picked up by Dev. If not, fire the dev-pickup path. If the issue
 *      has a hidden `liliput:feature-id=<id>` marker we heal the mapping.
 *
 *   2. Every open PR with label `rm:review` (or `dev:in-progress` PRs ready
 *      for review) is reviewed by the RM. We `runRmReview` on each, which is
 *      idempotent (already-merged PRs return action='skip').
 *
 * Idempotency: every action goes through the same `claimJob` UNIQUE
 * `state_key` as the webhook path. Concurrent reconciler + webhook firing
 * for the same issue/PR collapse to one effect.
 *
 * Defaults: poll interval 5 minutes. Tunable via `LILIPUT_RECONCILER_INTERVAL_MS`.
 * Enable via `LILIPUT_RECONCILER_ENABLED=1`. Disabled by default so unit
 * tests don't accidentally start the timer.
 */

import type { Server as SocketServer } from 'socket.io';
import { v4 as uuid } from 'uuid';
import { listIssuesByLabel, listPulls, type FetchImpl } from './github-rest.js';
import { runRmReview } from './rm-review.js';
import { extractCampaignCycleMarker } from './github-pr.js';
import { extractFeatureIdMarker } from './pm-issue-flow.js';
import * as featureStore from '../stores/feature-store.js';
import { listTargetRepos } from '../stores/target-repo-store.js';
import { getDb } from '../stores/db.js';
import { logger } from '../logger.js';
import * as taskStore from '../stores/task-store.js';
import { startBuild } from './agent-engine.js';

export const DEFAULT_INTERVAL_MS = 5 * 60_000; // 5 minutes

export interface ReconcilerDeps {
  fetchImpl?: FetchImpl;
  runRmReview?: (repo: string, prNumber: number) => Promise<unknown>;
  spawnDevTask?: (args: SpawnDevTaskArgs) => Promise<{ taskId: string }> | { taskId: string };
}

export interface SpawnDevTaskArgs {
  repository: string;
  workstreamId: string;
  featureId: string;
  featureName: string;
  issueNumber: number;
  issueUrl: string;
  prompt: string;
}

export interface ReconcileResult {
  repo: string;
  issuesScanned: number;
  issuesEnqueued: number;
  issuesHealed: number;
  prsScanned: number;
  prsReviewed: number;
  errors: number;
}

/**
 * Reconcile a single target repo. Safe to call concurrently with the webhook
 * dispatcher — every state mutation goes through the same UNIQUE-keyed job
 * table.
 */
export async function reconcileTargetRepo(
  repo: string,
  io: SocketServer | null,
  deps: ReconcilerDeps = {},
): Promise<ReconcileResult> {
  const fetchImpl = deps.fetchImpl;
  const rm = deps.runRmReview ?? ((r, n) => runRmReview(r, n));
  const spawn = deps.spawnDevTask ?? defaultSpawnDevTask(io);
  const result: ReconcileResult = {
    repo,
    issuesScanned: 0,
    issuesEnqueued: 0,
    issuesHealed: 0,
    prsScanned: 0,
    prsReviewed: 0,
    errors: 0,
  };

  // ─── Issues with pm:ready ─────────────────────────────────────────
  try {
    const issues = await listIssuesByLabel({
      repo,
      labels: ['pm:ready'],
      state: 'open',
      ...(fetchImpl && { fetchImpl }),
    });
    for (const issue of issues) {
      result.issuesScanned++;
      // GitHub conflates PRs and issues on this endpoint — skip PRs.
      if (issue.pull_request) continue;

      // Already mapped?
      let feature = featureStore.findByGithubIssue(repo, issue.number);

      // Try to heal via hidden body marker.
      if (!feature && issue.body) {
        const featureId = extractFeatureIdMarker(issue.body);
        if (featureId) {
          const candidate = featureStore.getFeature(featureId);
          if (candidate) {
            featureStore.updateFeature(featureId, {
              githubIssueNumber: issue.number,
              githubIssueUrl: issue.html_url,
            });
            feature = featureStore.getFeature(featureId)!;
            result.issuesHealed++;
            logger.info(
              { repo, issueNumber: issue.number, featureId },
              'reconciler: healed lost Feature ↔ issue mapping via body marker',
            );
          }
        }
      }

      if (!feature) continue;

      // Has dev pickup already been claimed for this issue?
      const stateKey = `dev-pickup:${repo}#${issue.number}`;
      const claimed = claimJob({
        repository: repo,
        kind: 'dev-pickup',
        stateKey,
        issueNumber: issue.number,
        prNumber: null,
      });
      if (!claimed) continue; // already in flight or done

      try {
        const { taskId } = await spawn({
          repository: repo,
          workstreamId: feature.workstreamId,
          featureId: feature.id,
          featureName: feature.name,
          issueNumber: issue.number,
          issueUrl: issue.html_url,
          prompt:
            `**Issue title:** ${issue.title}\n\n${issue.body ?? feature.description ?? ''}`,
        });
        markJobStatus(claimed, 'completed', null);
        result.issuesEnqueued++;
        logger.info(
          { repo, issueNumber: issue.number, taskId, featureId: feature.id },
          'reconciler: enqueued dev pickup (webhook miss recovered)',
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        markJobStatus(claimed, 'failed', null, msg);
        result.errors++;
        logger.error(
          { repo, issueNumber: issue.number, err: msg },
          'reconciler: dev pickup spawn failed',
        );
      }
    }
  } catch (err) {
    result.errors++;
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ repo, err: msg }, 'reconciler: listIssuesByLabel failed');
  }

  // ─── PRs with rm:review ───────────────────────────────────────────
  try {
    const prs = await listPulls({
      repo,
      state: 'open',
      ...(fetchImpl && { fetchImpl }),
    });
    for (const pr of prs) {
      result.prsScanned++;
      if (pr.draft) continue;
      if (!pr.labels.some((l) => l.name === 'rm:review')) continue;
      if (
        extractCampaignCycleMarker(pr.body) ||
        taskStore.findCampaignTaskByPullRequest(repo, pr.number)
      ) {
        logger.info(
          { repo, prNumber: pr.number },
          'reconciler: campaign-managed PR — skipping RM',
        );
        continue;
      }

      // Use the SHA-scoped state_key so re-pushes (different SHA) get a fresh
      // review even via the reconciler.
      const headSha = pr.head.sha.slice(0, 12);
      const stateKey = `rm-review:${repo}#${pr.number}@${headSha}`;
      const claimed = claimJob({
        repository: repo,
        kind: 'rm-review',
        stateKey,
        issueNumber: null,
        prNumber: pr.number,
      });
      if (!claimed) continue;

      try {
        await rm(repo, pr.number);
        markJobStatus(claimed, 'completed', null);
        result.prsReviewed++;
        logger.info(
          { repo, prNumber: pr.number },
          'reconciler: ran RM review (webhook miss recovered)',
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        markJobStatus(claimed, 'failed', null, msg);
        result.errors++;
        logger.error({ repo, prNumber: pr.number, err: msg }, 'reconciler: RM review failed');
      }
    }
  } catch (err) {
    result.errors++;
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ repo, err: msg }, 'reconciler: listPulls failed');
  }

  return result;
}

/** Iterate every target repo and reconcile it. Errors are logged + counted;
 *  one bad repo never blocks the next. */
export async function reconcileAllRepos(
  io: SocketServer | null,
  deps: ReconcilerDeps = {},
): Promise<ReconcileResult[]> {
  const repos = listTargetRepos();
  const out: ReconcileResult[] = [];
  for (const r of repos) {
    if (r.bootstrapState !== 'ready') continue;
    try {
      const res = await reconcileTargetRepo(r.repository, io, deps);
      out.push(res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ repo: r.repository, err: msg }, 'reconciler: pass failed');
    }
  }
  return out;
}

let _timer: NodeJS.Timeout | undefined;

export interface StartReconcilerOptions {
  intervalMs?: number;
  deps?: ReconcilerDeps;
}

/** Start the background timer. Idempotent — calling twice does nothing the
 *  second time. Returns a stop function for tests / shutdown. */
export function startReconciler(
  io: SocketServer,
  opts: StartReconcilerOptions = {},
): () => void {
  if (_timer) return stopReconciler;
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  logger.info({ intervalMs: interval }, '🔁 reconciler: starting');
  const tick = (): void => {
    void reconcileAllRepos(io, opts.deps ?? {}).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: msg }, 'reconciler tick failed');
    });
  };
  // Run once after a short delay so the server is fully up.
  _timer = setTimeout(function loop() {
    tick();
    _timer = setTimeout(loop, interval);
  }, 30_000);
  // setTimeout default keeps the event loop alive — don't block shutdown.
  _timer.unref();
  return stopReconciler;
}

export function stopReconciler(): void {
  if (_timer) {
    clearTimeout(_timer);
    _timer = undefined;
    logger.info('🔁 reconciler: stopped');
  }
}

// ─── private helpers ──────────────────────────────────────────────────

function defaultSpawnDevTask(io: SocketServer | null) {
  return (args: SpawnDevTaskArgs): { taskId: string } => {
    if (!io) {
      throw new Error('reconciler: spawnDevTask requires a SocketServer (none provided)');
    }
    const description = [`Closes #${args.issueNumber}`, '', args.prompt].join('\n');
    const task = taskStore.createTask(
      `dev: ${args.featureName} (#${args.issueNumber})`,
      description,
      args.repository,
      { workstreamId: args.workstreamId, commitMode: 'pr' },
    );
    taskStore.addChatMessage(
      task.id,
      'system',
      `Picked up GitHub issue ${args.issueUrl} (feature ${args.featureId}) via reconciler.`,
    );
    startBuild(io, task.id);
    return { taskId: task.id };
  };
}

interface ClaimArgs {
  repository: string;
  kind: 'dev-pickup' | 'rm-review';
  stateKey: string;
  issueNumber: number | null;
  prNumber: number | null;
}

function claimJob(args: ClaimArgs): string | null {
  const id = uuid();
  const now = new Date().toISOString();
  try {
    getDb()
      .prepare(
        `INSERT INTO github_jobs
           (id, repository, kind, state_key, issue_number, pr_number, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'claimed', 0, ?, ?)`,
      )
      .run(id, args.repository, args.kind, args.stateKey, args.issueNumber, args.prNumber, now, now);
    return id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE/i.test(msg)) return null;
    throw err;
  }
}

function markJobStatus(
  jobId: string,
  status: 'completed' | 'failed' | 'pending',
  resultRef: string | null,
  errorMessage?: string,
): void {
  void resultRef;
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE github_jobs SET status = ?, last_error = ?, updated_at = ? WHERE id = ?`,
    )
    .run(status, errorMessage ? errorMessage.slice(0, 1000) : null, now, jobId);
}
