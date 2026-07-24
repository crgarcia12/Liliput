/**
 * Webhook dispatcher — routes GitHub events into engine actions.
 *
 * Owned events:
 *   - issues.labeled(pm:ready)        -> Dev pickup
 *   - issues.unlabeled(dev:in-progress) (future PR) — Dev was bumped off
 *   - pull_request.opened/labeled(rm:review)/synchronize/ready_for_review
 *                                      -> RM review queue (PR-6 stub here)
 *
 * Idempotency: every action that mutates state goes through the
 * `github_jobs` table (UNIQUE state_key), so duplicate webhook deliveries +
 * reconciler triggers can race safely.
 *
 * This module is intentionally thin glue: it parses the payload, finds the
 * Feature, claims a job, and delegates the heavy lifting to a `spawnDevTask`
 * function injected via `DispatcherDeps` — that's the seam unit tests use
 * to avoid pulling in the real Copilot SDK / k8s engine.
 */

import type { Server as SocketServer } from 'socket.io';
import { v4 as uuid } from 'uuid';
import * as featureStore from '../stores/feature-store.js';
import * as workstreamStore from '../stores/workstream-store.js';
import * as taskStore from '../stores/task-store.js';
import { getDb } from '../stores/db.js';
import { extractFeatureIdMarker } from './pm-issue-flow.js';
import { startBuild } from './agent-engine.js';
import { runRmReview as realRunRmReview } from './rm-review.js';
import { extractCampaignCycleMarker } from './github-pr.js';
import { logger } from '../logger.js';
import type { WebhookDispatcher } from '../routes/github-webhook.js';

/** Minimal shape of the bits of the issues / PR payload we look at. */
interface IssueLikePayload {
  action?: string;
  issue?: {
    number?: number;
    title?: string;
    html_url?: string;
    body?: string | null;
    labels?: Array<{ name?: string }>;
    pull_request?: unknown;
  };
  pull_request?: {
    number?: number;
    html_url?: string;
    title?: string;
    body?: string | null;
    draft?: boolean;
    labels?: Array<{ name?: string }>;
  };
  label?: { name?: string };
  repository?: { full_name?: string };
}

export interface DispatcherDeps {
  /** Spawn a Liliput task that drives the Dev pickup for a given Feature.
   *  Defaults to the real `createTask + startBuild` pair. Tests inject a
   *  spy so they don't actually try to run the agent loop. */
  spawnDevTask?: (args: SpawnDevTaskArgs) => Promise<{ taskId: string }> | { taskId: string };
  /** Run the Release Manager review for a PR. Defaults to the real
   *  `runRmReview`. Tests inject a spy so they don't hit GitHub. */
  runRmReview?: (repo: string, prNumber: number) => Promise<unknown>;
}

export interface SpawnDevTaskArgs {
  repository: string;
  workstreamId: string;
  featureId: string;
  featureName: string;
  issueNumber: number;
  issueUrl: string;
  /** PR template for the Dev agent's first user message. */
  prompt: string;
}

/**
 * Default `spawnDevTask` — creates a Liliput task tied to the Feature and
 * kicks off the agent loop via `startBuild`. This is the real production
 * path; tests inject a stub.
 *
 * Title format: `dev: <feature.name> (#<issue>)` so the Liliput UI shows
 * the linkage. Description starts with a "Closes #N" line — when the
 * Liliput agent eventually opens its PR, that string lands in the PR body
 * and GitHub closes the issue on merge (subject to default-branch caveat).
 */
function defaultSpawnDevTask(io: SocketServer) {
  return (args: SpawnDevTaskArgs): { taskId: string } => {
    const description = [
      `Closes #${args.issueNumber}`,
      '',
      args.prompt,
    ].join('\n');
    const task = taskStore.createTask(
      `dev: ${args.featureName} (#${args.issueNumber})`,
      description,
      args.repository,
      {
        workstreamId: args.workstreamId,
        commitMode: 'pr',
      },
    );
    // featureId is part of the Task shape but not a createTask param yet —
    // we mirror via a system chat message so the agent sees the linkage.
    taskStore.addChatMessage(
      task.id,
      'system',
      `Picked up GitHub issue ${args.issueUrl} (feature ${args.featureId}). Apply dev:in-progress when work starts; open a PR that closes the issue when ready for RM review.`,
    );
    // Kick the agent loop.
    startBuild(io, task.id);
    return { taskId: task.id };
  };
}

/**
 * Build the webhook dispatcher closed over the SocketServer (needed by
 * `startBuild`). The returned dispatcher is the function we hand to
 * `createGitHubWebhookRouter`.
 */
export function createWebhookDispatcher(
  io: SocketServer,
  deps: DispatcherDeps = {},
): WebhookDispatcher {
  const spawn = deps.spawnDevTask ?? defaultSpawnDevTask(io);
  const rmReview =
    deps.runRmReview ?? ((repo: string, n: number) => realRunRmReview(repo, n));

  return async function dispatch({ deliveryId, event, action, repository, payload }) {
    const repo = repository;
    if (!repo) {
      logger.info({ deliveryId, event, action }, 'dispatcher: no repository — ignoring');
      return;
    }

    const p = payload as IssueLikePayload;

    // ─── issues.* events ─────────────────────────────────────────
    if (event === 'issues') {
      // We only act on `labeled` with `pm:ready` (or `unlabeled` events in
      // future PRs). Ignore everything else — opened/closed/edited noise.
      if (action !== 'labeled' || p.label?.name !== 'pm:ready') {
        return;
      }
      // GitHub uses `issues.labeled` for BOTH issues and PRs (because PRs
      // are a subtype of issues). When the payload has issue.pull_request,
      // this is a PR labeling event — skip; RM cares about PRs.
      if (p.issue?.pull_request) return;

      const issueNumber = p.issue?.number;
      if (!issueNumber) return;

      // Map issue -> Feature. Try the indexed column first; fall back to
      // the body marker (recovery path if PM emit crashed mid-flow).
      let feature = featureStore.findByGithubIssue(repo, issueNumber);
      if (!feature) {
        const markedId = extractFeatureIdMarker(p.issue?.body ?? null);
        if (markedId) {
          feature = featureStore.getFeature(markedId);
          if (feature && !feature.githubIssueNumber) {
            // Heal the mapping so future lookups are O(index).
            featureStore.updateFeature(feature.id, {
              githubIssueNumber: issueNumber,
              ...(p.issue?.html_url ? { githubIssueUrl: p.issue.html_url } : {}),
            });
          }
        }
      }
      if (!feature) {
        logger.info(
          { deliveryId, repo, issueNumber },
          'dispatcher: pm:ready issue not mapped to a Feature — ignoring (likely external issue)',
        );
        return;
      }

      const ws = workstreamStore.getWorkstream(feature.workstreamId);
      if (!ws) {
        logger.warn({ featureId: feature.id }, 'dispatcher: workstream missing — cannot spawn dev');
        return;
      }

      // Claim a job. UNIQUE(state_key) makes this our idempotency boundary.
      const claimed = claimJob({
        repository: repo,
        kind: 'dev-pickup',
        stateKey: `dev-pickup:${repo}#${issueNumber}`,
        issueNumber,
        prNumber: null,
      });
      if (!claimed) {
        logger.info(
          { deliveryId, repo, issueNumber },
          'dispatcher: dev-pickup already claimed — skipping',
        );
        return;
      }

      try {
        const { taskId } = await spawn({
          repository: repo,
          workstreamId: ws.id,
          featureId: feature.id,
          featureName: feature.name,
          issueNumber,
          issueUrl: p.issue?.html_url ?? `https://github.com/${repo}/issues/${issueNumber}`,
          prompt:
            (p.issue?.title ? `**Issue title:** ${p.issue.title}\n\n` : '') +
            (p.issue?.body ?? feature.description ?? ''),
        });
        markJobStatus(claimed, 'completed', taskId);
        logger.info(
          { deliveryId, repo, issueNumber, taskId, featureId: feature.id },
          'dispatcher: dev pickup task spawned',
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        markJobStatus(claimed, 'failed', null, msg);
        logger.error({ deliveryId, repo, issueNumber, err: msg }, 'dispatcher: dev pickup failed');
      }
      return;
    }

    // ─── pull_request.* events (RM stub) ─────────────────────────
    if (event === 'pull_request') {
      const pr = p.pull_request;
      if (!pr?.number) return;
      // Only enqueue RM review when:
      //   - PR became ready_for_review, OR
      //   - PR was labeled rm:review on a non-draft PR, OR
      //   - PR was synchronized while non-draft
      const labelName = p.label?.name;
      const interesting =
        (action === 'labeled' && labelName === 'rm:review' && pr.draft !== true) ||
        action === 'ready_for_review' ||
        (action === 'synchronize' && pr.draft !== true) ||
        action === 'reopened';
      if (!interesting) return;
      if (
        extractCampaignCycleMarker(pr.body) ||
        taskStore.findCampaignTaskByPullRequest(repo, pr.number)
      ) {
        logger.info(
          { deliveryId, repo, prNumber: pr.number, action },
          'dispatcher: campaign-managed PR — skipping RM',
        );
        return;
      }

      // Map PR -> Feature.
      const feature = featureStore.findByGithubPr(repo, pr.number);
      if (!feature) {
        logger.info(
          { deliveryId, repo, prNumber: pr.number, action },
          'dispatcher: PR not mapped to a Feature — ignoring',
        );
        return;
      }

      // Claim an RM job. Include the head SHA so re-pushes (synchronize)
      // get a fresh UNIQUE state_key and re-run the review.
      const headSha =
        typeof (pr as { head?: { sha?: string } }).head?.sha === 'string'
          ? (pr as { head?: { sha?: string } }).head!.sha!.slice(0, 12)
          : 'unknown';
      const claimed = claimJob({
        repository: repo,
        kind: 'rm-review',
        stateKey: `rm-review:${repo}#${pr.number}@${headSha}`,
        issueNumber: feature.githubIssueNumber ?? null,
        prNumber: pr.number,
      });
      if (!claimed) return;

      try {
        await rmReview(repo, pr.number);
        markJobStatus(claimed, 'completed', null);
        logger.info(
          { deliveryId, repo, prNumber: pr.number, jobId: claimed },
          'dispatcher: RM review completed',
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        markJobStatus(claimed, 'failed', null, msg);
        logger.error(
          { deliveryId, repo, prNumber: pr.number, err: msg },
          'dispatcher: RM review failed',
        );
      }
      return;
    }

    // Other events (check_suite, check_run) get noticed by the reconciler
    // — no direct routing here for now.
    logger.debug({ deliveryId, event, action, repo }, 'dispatcher: no handler');
  };
}

interface ClaimArgs {
  repository: string;
  kind: 'dev-pickup' | 'rm-review';
  stateKey: string;
  issueNumber: number | null;
  prNumber: number | null;
}

/**
 * Claim a job by inserting into `github_jobs` with the UNIQUE state_key.
 * Returns the new job id on success; null when another worker already
 * claimed it (UNIQUE violation).
 */
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
    // SQLITE_CONSTRAINT — another worker claimed it. Idempotent return.
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE/i.test(msg)) return null;
    throw err;
  }
}

function markJobStatus(
  jobId: string,
  status: 'pending' | 'completed' | 'failed',
  resultRef: string | null,
  errorMessage?: string,
): void {
  void resultRef; // schema doesn't carry a result_ref column yet — kept in signature for callers; the task id is logged instead.
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE github_jobs
          SET status = ?, last_error = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(
      status,
      errorMessage ? errorMessage.slice(0, 1000) : null,
      now,
      jobId,
    );
}
