/**
 * Target-repo bootstrap — ensures a repo is ready for the PM/Dev/RM loop.
 *
 * Idempotent and cheap to call. The PM emit flow invokes this before
 * creating the first issue for a workstream so the labels + webhook are in
 * place. Subsequent calls short-circuit on `target_repos.bootstrap_state =
 * 'ready'`.
 *
 * What we do here (engine-side, no shell-out):
 *   1. Ensure the seven state-machine labels exist on the target repo.
 *   2. Ensure a webhook pointing at this Liliput instance exists.
 *   3. Persist the resulting state in `target_repos`.
 *
 * What we deliberately *don't* do here (yet):
 *   - Push the overlay files (issue/PR templates, FLOW.md, etc.). Humans can
 *     run `scripts/bootstrap-liliput-flow.sh` for that. Templates are a UX
 *     improvement; the agent loop functions without them. Wiring engine-side
 *     overlay push is tracked as PR-4b.
 *
 * Failure handling: each sub-step records its own status. The label step is
 * required (loop cannot run without `pm:ready`); a label failure flips
 * `bootstrap_state = 'failed'`. The webhook step is best-effort; a failure
 * downgrades us to `webhook_status = 'polling_fallback'` but leaves
 * `bootstrap_state = 'ready'` so issue creation continues. The reconciler
 * (PR-7) drives polling and retry.
 */

import {
  ensureLabel,
  listWebhooks,
  createWebhook,
  type FetchImpl,
} from './github-rest.js';
import * as targetRepoStore from '../stores/target-repo-store.js';
import { logger } from '../logger.js';

/**
 * The full state-machine label set. Single source of truth for the engine —
 * mirrors what `templates/liliput-flow/.github/liliput/labels.yml` declares
 * for the human-side `scripts/bootstrap-liliput-flow.sh`. If you change one
 * keep the other in sync (PR-4b will collapse the two into one source).
 */
export const STATE_MACHINE_LABELS: ReadonlyArray<{
  name: string;
  color: string;
  description: string;
}> = [
  { name: 'pm:ready',             color: '0e8a16', description: 'Liliput PM has handed off to a Dev agent.' },
  { name: 'dev:in-progress',      color: '1d76db', description: 'A Liliput Dev agent is implementing this.' },
  { name: 'rm:review',            color: 'fbca04', description: 'PR open; Release Manager is reviewing.' },
  { name: 'rm:changes-requested', color: 'd93f0b', description: 'RM bounced the PR; Dev must address feedback.' },
  { name: 'done',                 color: '6f42c1', description: 'Issue closed and PR merged by RM.' },
  { name: 'dev:rebase-needed',    color: 'e99695', description: 'PR branch is stale; Dev must rebase.' },
  { name: 'blocked:human',        color: '000000', description: 'Loop escalated to a human after max retries.' },
];

export interface BootstrapResult {
  repository: string;
  bootstrapState: targetRepoStore.BootstrapState;
  webhookStatus: targetRepoStore.WebhookStatus;
  webhookId: number | null;
  labelsCreated: number;
  labelsExisting: number;
  webhookAction: 'created' | 'existing' | 'skipped' | 'failed';
  warnings: string[];
}

export interface BootstrapOptions {
  /** Liliput's public URL where GitHub will POST webhooks. Defaults to
   *  `LILIPUT_PUBLIC_URL` env var. When unset, webhook creation is skipped
   *  and we record `polling_fallback`. */
  publicBaseUrl?: string;
  /** HMAC secret. Must match `GITHUB_WEBHOOK_SECRET` on the receive side.
   *  Defaults to that env var. Missing secret -> webhook is skipped. */
  webhookSecret?: string;
  /** Force re-bootstrap even if state='ready'. Used by reconciler / debug. */
  force?: boolean;
  fetchImpl?: FetchImpl;
}

/**
 * Ensure the target repo has labels + webhook in place. Idempotent: cheap
 * to call from a hot path (PM emit) — when state is already 'ready' it does
 * nothing.
 *
 * @returns the resolved state. Never throws on transient GitHub errors —
 *          failures are captured in `target_repos.last_error` and surfaced
 *          via the returned `warnings` array.
 */
export async function ensureTargetRepoBootstrapped(
  repository: string,
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const row = targetRepoStore.ensureTargetRepo(repository);
  const publicBaseUrl = options.publicBaseUrl ?? process.env['LILIPUT_PUBLIC_URL'];
  const webhookSecret = options.webhookSecret ?? process.env['GITHUB_WEBHOOK_SECRET'];

  const warnings: string[] = [];

  // Fast path — already ready and not forced.
  if (row.bootstrapState === 'ready' && !options.force) {
    return {
      repository,
      bootstrapState: row.bootstrapState,
      webhookStatus: row.webhookStatus,
      webhookId: row.webhookId,
      labelsCreated: 0,
      labelsExisting: STATE_MACHINE_LABELS.length,
      webhookAction: 'skipped',
      warnings,
    };
  }

  // Step 1 — labels. This is required. If even one fails we mark failed.
  let labelsCreated = 0;
  let labelsExisting = 0;
  for (const label of STATE_MACHINE_LABELS) {
    try {
      const r = await ensureLabel({
        repo: repository,
        name: label.name,
        color: label.color,
        description: label.description,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
      if (r.result === 'created') labelsCreated++;
      else labelsExisting++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ repo: repository, label: label.name, err: msg }, 'bootstrap: ensureLabel failed');
      targetRepoStore.updateTargetRepo(repository, {
        bootstrapState: 'failed',
        lastError: `ensureLabel(${label.name}): ${msg}`,
      });
      return {
        repository,
        bootstrapState: 'failed',
        webhookStatus: row.webhookStatus,
        webhookId: row.webhookId,
        labelsCreated,
        labelsExisting,
        webhookAction: 'skipped',
        warnings: [`Label "${label.name}" could not be created: ${msg}`],
      };
    }
  }

  // Step 2 — webhook. Best-effort.
  let webhookStatus: targetRepoStore.WebhookStatus = row.webhookStatus;
  let webhookId: number | null = row.webhookId;
  let webhookAction: 'created' | 'existing' | 'skipped' | 'failed' = 'skipped';

  if (!publicBaseUrl) {
    warnings.push('LILIPUT_PUBLIC_URL not set — webhook not created; relying on polling reconciler.');
    webhookStatus = 'polling_fallback';
  } else if (!webhookSecret) {
    warnings.push('GITHUB_WEBHOOK_SECRET not set — webhook not created; relying on polling reconciler.');
    webhookStatus = 'polling_fallback';
  } else {
    const webhookUrl = `${publicBaseUrl.replace(/\/$/, '')}/api/github/webhook`;
    try {
      const existing = await listWebhooks({
        repo: repository,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
      const match = existing.find((h) => h.config.url === webhookUrl);
      if (match) {
        webhookId = match.id;
        webhookStatus = match.active ? 'active' : 'failed';
        webhookAction = 'existing';
      } else {
        const created = await createWebhook({
          repo: repository,
          url: webhookUrl,
          secret: webhookSecret,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        });
        webhookId = created.id;
        webhookStatus = 'active';
        webhookAction = 'created';
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Common cause: token lacks `admin:repo_hook`. Don't fail bootstrap —
      // the loop still works on polling; reconciler heals later.
      logger.warn(
        { repo: repository, err: msg, webhookUrl },
        'bootstrap: webhook setup failed — falling back to polling',
      );
      warnings.push(`Webhook creation failed (${msg}). Falling back to polling reconciler.`);
      webhookStatus = 'polling_fallback';
      webhookAction = 'failed';
    }
  }

  targetRepoStore.updateTargetRepo(repository, {
    bootstrapState: 'ready',
    webhookStatus,
    webhookId,
    // Clear any prior error since we got here cleanly.
    lastError: null,
  });

  return {
    repository,
    bootstrapState: 'ready',
    webhookStatus,
    webhookId,
    labelsCreated,
    labelsExisting,
    webhookAction,
    warnings,
  };
}
