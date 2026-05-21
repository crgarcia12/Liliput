/**
 * target_repos store — bootstrap + webhook lifecycle for every GitHub repo
 * Liliput drives.
 *
 * One row per "owner/repo". The row tracks two state machines:
 *
 *   bootstrap_state: pending | pending_setup_pr | ready | failed
 *     - pending           — never attempted yet
 *     - pending_setup_pr  — a setup PR was opened, waiting for human merge
 *     - ready             — labels + webhook in place, agent loop active
 *     - failed            — last bootstrap attempt errored; details in last_error
 *
 *   webhook_status:  unconfigured | active | polling_fallback | failed
 *     - unconfigured      — never created a webhook
 *     - active            — webhook is live on GitHub (we have webhook_id)
 *     - polling_fallback  — webhook creation failed (likely token scope);
 *                           reconciler should pick up the slack
 *     - failed            — webhook was active but recent deliveries failed
 *
 * The two states are independent: a repo with ready bootstrap may still have
 * polling_fallback webhook (token missing admin:repo_hook), and vice-versa.
 */

import { getDb } from './db.js';
import { logger } from '../logger.js';

export type BootstrapState = 'pending' | 'pending_setup_pr' | 'ready' | 'failed';
export type WebhookStatus = 'unconfigured' | 'active' | 'polling_fallback' | 'failed';

export interface TargetRepo {
  repository: string;          // "owner/repo"
  bootstrapState: BootstrapState;
  webhookStatus: WebhookStatus;
  webhookId: number | null;    // GitHub-assigned hook id, when webhookStatus='active'
  lastError: string | null;    // last failure detail (truncated)
  createdAt: string;
  updatedAt: string;
}

interface Row {
  repository: string;
  bootstrap_state: string;
  webhook_status: string;
  webhook_id: number | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function now(): string {
  return new Date().toISOString();
}

function hydrate(row: Row): TargetRepo {
  return {
    repository: row.repository,
    bootstrapState: row.bootstrap_state as BootstrapState,
    webhookStatus: row.webhook_status as WebhookStatus,
    webhookId: row.webhook_id,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getTargetRepo(repository: string): TargetRepo | undefined {
  const row = getDb()
    .prepare('SELECT * FROM target_repos WHERE repository = ?')
    .get(repository) as Row | undefined;
  return row ? hydrate(row) : undefined;
}

/** Idempotent create-if-missing. Returns the (possibly pre-existing) row. */
export function ensureTargetRepo(repository: string): TargetRepo {
  const existing = getTargetRepo(repository);
  if (existing) return existing;
  const ts = now();
  getDb()
    .prepare(
      `INSERT INTO target_repos
         (repository, bootstrap_state, webhook_status, webhook_id, last_error, created_at, updated_at)
       VALUES (?, 'pending', 'unconfigured', NULL, NULL, ?, ?)`,
    )
    .run(repository, ts, ts);
  return getTargetRepo(repository)!;
}

export interface UpdateTargetRepoInput {
  bootstrapState?: BootstrapState;
  webhookStatus?: WebhookStatus;
  webhookId?: number | null;
  lastError?: string | null;
}

export function updateTargetRepo(
  repository: string,
  patch: UpdateTargetRepoInput,
): TargetRepo | undefined {
  const existing = getTargetRepo(repository);
  if (!existing) return undefined;
  const ts = now();
  const merged: TargetRepo = {
    ...existing,
    ...(patch.bootstrapState !== undefined ? { bootstrapState: patch.bootstrapState } : {}),
    ...(patch.webhookStatus !== undefined ? { webhookStatus: patch.webhookStatus } : {}),
    ...(patch.webhookId !== undefined ? { webhookId: patch.webhookId } : {}),
    ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
    updatedAt: ts,
  };
  getDb()
    .prepare(
      `UPDATE target_repos
          SET bootstrap_state = ?, webhook_status = ?, webhook_id = ?, last_error = ?, updated_at = ?
        WHERE repository = ?`,
    )
    .run(
      merged.bootstrapState,
      merged.webhookStatus,
      merged.webhookId,
      merged.lastError ? merged.lastError.slice(0, 1000) : null,
      ts,
      repository,
    );
  logger.info(
    {
      repo: repository,
      bootstrap: merged.bootstrapState,
      webhook: merged.webhookStatus,
      hadError: !!merged.lastError,
    },
    'target-repo-store: state updated',
  );
  return merged;
}

export function listTargetRepos(): TargetRepo[] {
  const rows = getDb().prepare('SELECT * FROM target_repos ORDER BY repository ASC').all() as Row[];
  return rows.map(hydrate);
}
