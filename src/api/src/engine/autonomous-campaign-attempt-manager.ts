import type {
  AutonomousCampaign,
  AutonomousCampaignCycle,
} from '../../../shared/types/autonomous-campaign-state.js';
import {
  AUTONOMOUS_CAMPAIGN_ATTEMPT_CONFLICT,
  AUTONOMOUS_CAMPAIGN_ATTEMPT_NOT_FOUND,
  INVALID_AUTONOMOUS_CAMPAIGN_ATTEMPT_TRANSITION,
  type AutonomousCampaignAttemptActionResult,
  type AutonomousCampaignAttemptErrorCode,
  type AutonomousCampaignAttemptFailure,
  type AutonomousCampaignAttemptStage,
  type AutonomousCampaignAttemptTransitionResult,
  type AutonomousCampaignAttemptUsageDelta,
  type AutonomousCampaignBoundedAttempt,
  type AutonomousCampaignRetryStartResult,
} from '../../../shared/types/autonomous-campaign-attempt-bounds.js';
import {
  canScheduleCampaignAction,
  nextRetryDelayMinutes,
} from './autonomous-campaign-primitives.js';
import * as campaignStore from '../stores/autonomous-campaign-store.js';
import { getDb } from '../stores/db.js';

const PAUSED_FROM_PREFIX = 'campaign-control:paused-from:';

export type AutonomousCampaignTaskInterruptReason = 'pause' | 'stop';

export interface AutonomousCampaignAttemptManagerOptions {
  owner: string;
  now: () => number;
  interruptTask: (
    taskId: string,
    reason: AutonomousCampaignTaskInterruptReason,
  ) => void;
}

export interface AutonomousCampaignAttemptManager {
  evaluateBeforeAction(
    campaignId: string,
    cycleId: string,
    stage: AutonomousCampaignAttemptStage,
  ): AutonomousCampaignAttemptActionResult;
  recordUsage(
    campaignId: string,
    cycleId: string,
    input: AutonomousCampaignAttemptUsageDelta,
  ): AutonomousCampaignBoundedAttempt;
  waitForExternal(
    campaignId: string,
    cycleId: string,
    input: AutonomousCampaignAttemptFailure,
  ): AutonomousCampaignAttemptTransitionResult;
  resumeExternalWait(
    campaignId: string,
    cycleId: string,
  ): AutonomousCampaignAttemptTransitionResult;
  failAttempt(
    campaignId: string,
    cycleId: string,
    input: AutonomousCampaignAttemptFailure,
  ): AutonomousCampaignAttemptTransitionResult;
  pause(
    campaignId: string,
    cycleId: string,
  ): AutonomousCampaignAttemptTransitionResult;
  resume(
    campaignId: string,
    cycleId: string,
  ): AutonomousCampaignAttemptTransitionResult;
  stop(
    campaignId: string,
    cycleId: string,
  ): AutonomousCampaignAttemptTransitionResult;
  startDueRetry(
    campaignId: string,
    cycleId: string,
  ): AutonomousCampaignRetryStartResult;
}

interface AttemptContext {
  campaign: AutonomousCampaign;
  cycle: AutonomousCampaignCycle;
  attempt: AutonomousCampaignBoundedAttempt;
}

export class AutonomousCampaignAttemptManagerError extends Error {
  constructor(
    message: string,
    readonly code: AutonomousCampaignAttemptErrorCode,
  ) {
    super(message);
    this.name = 'AutonomousCampaignAttemptManagerError';
  }
}

function requireMessage(message: string, field: string): string {
  const value = message.trim();
  if (!value) {
    throw new RangeError(`${field} is required`);
  }
  return value;
}

function resolveContext(campaignId: string, cycleId: string): AttemptContext {
  const campaign = campaignStore.getCampaign(campaignId);
  const cycle = campaignStore.getCycle(cycleId);
  if (
    !campaign ||
    !cycle ||
    cycle.campaignId !== campaignId ||
    campaign.currentCycleId !== cycleId
  ) {
    throw new AutonomousCampaignAttemptManagerError(
      `Campaign ${campaignId} and cycle ${cycleId} are not the current attempt context`,
      AUTONOMOUS_CAMPAIGN_ATTEMPT_CONFLICT,
    );
  }
  const attempt = campaignStore.getLatestAttempt(cycleId);
  if (!attempt) {
    throw new AutonomousCampaignAttemptManagerError(
      `Campaign cycle ${cycleId} has no delivery attempt`,
      AUTONOMOUS_CAMPAIGN_ATTEMPT_NOT_FOUND,
    );
  }
  return { campaign, cycle, attempt };
}

function assertOwnedLease(
  campaign: AutonomousCampaign,
  owner: string,
  nowMs: number,
): void {
  if (
    campaign.leaseOwner !== owner ||
    campaign.leaseExpiresAt === undefined ||
    campaign.leaseExpiresAt <= nowMs
  ) {
    throw new AutonomousCampaignAttemptManagerError(
      `Campaign ${campaign.id} is not actively leased by ${owner}`,
      AUTONOMOUS_CAMPAIGN_ATTEMPT_CONFLICT,
    );
  }
}

function invalidTransition(message: string): never {
  throw new AutonomousCampaignAttemptManagerError(
    message,
    INVALID_AUTONOMOUS_CAMPAIGN_ATTEMPT_TRANSITION,
  );
}

function timestamp(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function activeElapsedMs(
  attempt: AutonomousCampaignBoundedAttempt,
  nowMs: number,
): number {
  if (!attempt.activeStartedAt) return 0;
  const startedAtMs = Date.parse(attempt.activeStartedAt);
  return Number.isFinite(startedAtMs) ? Math.max(0, nowMs - startedAtMs) : 0;
}

function refreshActiveElapsed(
  attempt: AutonomousCampaignBoundedAttempt,
  nowMs: number,
): AutonomousCampaignBoundedAttempt {
  if (attempt.status !== 'running' || !attempt.activeStartedAt) return attempt;
  const ts = timestamp(nowMs);
  getDb()
    .prepare(
      `UPDATE autonomous_attempts
          SET elapsed_ms = elapsed_ms + ?,
              active_started_at = ?,
              updated_at = ?
        WHERE id = ?
          AND status = 'running'`,
    )
    .run(activeElapsedMs(attempt, nowMs), ts, ts, attempt.id);
  return campaignStore.getAttempt(attempt.id) ?? attempt;
}

function closeActiveElapsed(
  attempt: AutonomousCampaignBoundedAttempt,
  nowMs: number,
): AutonomousCampaignBoundedAttempt {
  if (attempt.status !== 'running' || !attempt.activeStartedAt) return attempt;
  const ts = timestamp(nowMs);
  getDb()
    .prepare(
      `UPDATE autonomous_attempts
          SET elapsed_ms = elapsed_ms + ?,
              active_started_at = NULL,
              updated_at = ?
        WHERE id = ?
          AND status = 'running'`,
    )
    .run(activeElapsedMs(attempt, nowMs), ts, attempt.id);
  return campaignStore.getAttempt(attempt.id) ?? attempt;
}

function transitionResult(
  campaignId: string,
  cycleId: string,
  attemptId: string,
): AutonomousCampaignAttemptTransitionResult {
  const campaign = campaignStore.getCampaign(campaignId);
  const cycle = campaignStore.getCycle(cycleId);
  const attempt = campaignStore.getAttempt(attemptId);
  if (!campaign || !cycle || !attempt) {
    throw new AutonomousCampaignAttemptManagerError(
      `Campaign attempt context disappeared for cycle ${cycleId}`,
      AUTONOMOUS_CAMPAIGN_ATTEMPT_CONFLICT,
    );
  }
  return { campaign, cycle, attempt };
}

function failResolvedAttempt(
  context: AttemptContext,
  input: AutonomousCampaignAttemptFailure,
  nowMs: number,
): AutonomousCampaignAttemptTransitionResult {
  if (
    context.campaign.status !== 'running' ||
    context.attempt.status !== 'running' ||
    (context.cycle.status !== 'delivering' &&
      context.cycle.status !== 'waiting_for_external')
  ) {
    invalidTransition(
      `Attempt ${context.attempt.id} cannot fail while campaign is ${context.campaign.status}, cycle is ${context.cycle.status}, and attempt is ${context.attempt.status}`,
    );
  }
  const message = requireMessage(input.message, 'Attempt failure message');
  const attempt = closeActiveElapsed(context.attempt, nowMs);
  const ts = timestamp(nowMs);
  const delayMinutes = nextRetryDelayMinutes(
    context.cycle.retryDelayMinutes ?? 0,
    context.campaign.retryBackoffCapMinutes,
  );
  const nextRetryAt = timestamp(nowMs + delayMinutes * 60_000);
  getDb()
    .prepare(
      `UPDATE autonomous_attempts
          SET status = 'failed',
              active_started_at = NULL,
              completed_at = ?,
              failure_stage = ?,
              failure_message = ?,
              updated_at = ?
        WHERE id = ?
          AND status = 'running'`,
    )
    .run(ts, input.stage, message, ts, attempt.id);
  getDb()
    .prepare(
      `UPDATE autonomous_cycles
          SET status = 'retry_wait',
              next_retry_at = ?,
              retry_delay_minutes = ?,
              last_error = ?,
              updated_at = ?
        WHERE id = ?`,
    )
    .run(nextRetryAt, delayMinutes, message, ts, context.cycle.id);
  return transitionResult(
    context.campaign.id,
    context.cycle.id,
    context.attempt.id,
  );
}

function pausedFromStatus(cycle: AutonomousCampaignCycle): string {
  const priorError = cycle.lastError
    ? Buffer.from(cycle.lastError, 'utf8').toString('base64url')
    : '';
  return `${PAUSED_FROM_PREFIX}${cycle.status}:${priorError}`;
}

function previousCycleStatus(cycle: AutonomousCampaignCycle): AutonomousCampaignCycle['status'] {
  if (!cycle.lastError?.startsWith(PAUSED_FROM_PREFIX)) return 'delivering';
  const encoded = cycle.lastError.slice(PAUSED_FROM_PREFIX.length);
  const separator = encoded.indexOf(':');
  return (separator === -1 ? encoded : encoded.slice(0, separator)) as AutonomousCampaignCycle['status'];
}

function previousCycleError(cycle: AutonomousCampaignCycle): string | undefined {
  if (!cycle.lastError?.startsWith(PAUSED_FROM_PREFIX)) return undefined;
  const encoded = cycle.lastError.slice(PAUSED_FROM_PREFIX.length);
  const separator = encoded.indexOf(':');
  if (separator === -1 || separator === encoded.length - 1) return undefined;
  try {
    return Buffer.from(encoded.slice(separator + 1), 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
}

export function createAutonomousCampaignAttemptManager(
  options: AutonomousCampaignAttemptManagerOptions,
): AutonomousCampaignAttemptManager {
  const owner = requireMessage(options.owner, 'Campaign attempt owner');

  const evaluateBeforeAction = (
    campaignId: string,
    cycleId: string,
    stage: AutonomousCampaignAttemptStage,
  ): AutonomousCampaignAttemptActionResult => {
    const operation = getDb().transaction(() => {
      const nowMs = options.now();
      let context = resolveContext(campaignId, cycleId);
      if (
        context.campaign.status === 'stopped' ||
        context.cycle.status === 'stopped' ||
        context.attempt.status === 'stopped'
      ) {
        return {
          allowed: false,
          reason: 'stopped' as const,
          attempt: context.attempt,
          cycle: context.cycle,
        };
      }
      if (
        context.campaign.status === 'paused' ||
        context.campaign.status === 'pausing' ||
        context.cycle.status === 'paused' ||
        context.attempt.status === 'paused'
      ) {
        return {
          allowed: false,
          reason: 'paused' as const,
          attempt: context.attempt,
          cycle: context.cycle,
        };
      }
      if (context.cycle.status === 'waiting_for_external') {
        return {
          allowed: false,
          reason: 'waiting_for_external' as const,
          attempt: context.attempt,
          cycle: context.cycle,
        };
      }
      if (
        context.cycle.status === 'retry_wait' ||
        context.attempt.status === 'retry_wait' ||
        context.attempt.status === 'failed'
      ) {
        return {
          allowed: false,
          reason: 'retry_wait' as const,
          attempt: context.attempt,
          cycle: context.cycle,
        };
      }
      assertOwnedLease(context.campaign, owner, nowMs);
      if (
        context.campaign.status !== 'running' ||
        context.cycle.status !== 'delivering' ||
        context.attempt.status !== 'running'
      ) {
        invalidTransition(
          `Attempt ${context.attempt.id} is not runnable from ${context.campaign.status}/${context.cycle.status}/${context.attempt.status}`,
        );
      }
      context = {
        ...context,
        attempt: refreshActiveElapsed(context.attempt, nowMs),
      };
      const decision = canScheduleCampaignAction(context.attempt, context.attempt);
      if (decision.allowed) {
        return {
          allowed: true,
          attempt: context.attempt,
          cycle: context.cycle,
        };
      }
      const failed = failResolvedAttempt(
        context,
        {
          stage,
          message: `attempt-limit:${decision.reason}`,
        },
        nowMs,
      );
      return {
        allowed: false,
        reason: decision.reason,
        attempt: failed.attempt,
        cycle: failed.cycle,
      };
    });
    return operation.immediate();
  };

  const recordUsage = (
    campaignId: string,
    cycleId: string,
    input: AutonomousCampaignAttemptUsageDelta,
  ): AutonomousCampaignBoundedAttempt => {
    if (!Number.isInteger(input.turns) || input.turns < 0) {
      throw new RangeError('Usage turns must be a non-negative integer');
    }
    if (
      !Number.isFinite(input.estimatedCostUsd) ||
      input.estimatedCostUsd < 0
    ) {
      throw new RangeError(
        'Usage estimatedCostUsd must be a non-negative number',
      );
    }
    const usageEventId = requireMessage(input.usageEventId, 'Usage event id');
    const operation = getDb().transaction(() => {
      const nowMs = options.now();
      const context = resolveContext(campaignId, cycleId);
      assertOwnedLease(context.campaign, owner, nowMs);
      if (
        context.campaign.status !== 'running' ||
        context.attempt.status !== 'running' ||
        !(
          (context.cycle.status === 'delivering' &&
            context.attempt.activeStartedAt) ||
          (context.cycle.status === 'waiting_for_external' &&
            !context.attempt.activeStartedAt)
        )
      ) {
        invalidTransition(
          `Attempt ${context.attempt.id} cannot record usage from ${context.campaign.status}/${context.cycle.status}/${context.attempt.status}`,
        );
      }
      const ts = timestamp(nowMs);
      const inserted = getDb()
        .prepare(
          `INSERT OR IGNORE INTO autonomous_attempt_usage_events (
             attempt_id, usage_event_id, turns, estimated_cost_usd, created_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          context.attempt.id,
          usageEventId,
          input.turns,
          input.estimatedCostUsd,
          ts,
        );
      if (inserted.changes === 1) {
        getDb()
          .prepare(
            `UPDATE autonomous_attempts
                SET turns_used = turns_used + ?,
                    estimated_cost_usd = estimated_cost_usd + ?,
                    updated_at = ?
              WHERE id = ?`,
          )
          .run(
            input.turns,
            input.estimatedCostUsd,
            ts,
            context.attempt.id,
          );
        getDb()
          .prepare(
            `UPDATE autonomous_campaigns
                SET cumulative_cost_usd = cumulative_cost_usd + ?,
                    updated_at = ?
              WHERE id = ?`,
          )
          .run(input.estimatedCostUsd, ts, campaignId);
      }
      return campaignStore.getAttempt(context.attempt.id) ?? context.attempt;
    });
    return operation.immediate();
  };

  const waitForExternal = (
    campaignId: string,
    cycleId: string,
    input: AutonomousCampaignAttemptFailure,
  ): AutonomousCampaignAttemptTransitionResult => {
    const operation = getDb().transaction(() => {
      const nowMs = options.now();
      const context = resolveContext(campaignId, cycleId);
      assertOwnedLease(context.campaign, owner, nowMs);
      if (
        context.campaign.status !== 'running' ||
        context.cycle.status !== 'delivering' ||
        context.attempt.status !== 'running'
      ) {
        invalidTransition(
          `Attempt ${context.attempt.id} cannot wait for external work from ${context.campaign.status}/${context.cycle.status}/${context.attempt.status}`,
        );
      }
      const message = requireMessage(input.message, 'External wait message');
      closeActiveElapsed(context.attempt, nowMs);
      const ts = timestamp(nowMs);
      getDb()
        .prepare(
          `UPDATE autonomous_cycles
              SET status = 'waiting_for_external',
                  last_error = ?,
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(message, ts, cycleId);
      return transitionResult(campaignId, cycleId, context.attempt.id);
    });
    return operation.immediate();
  };

  const resumeExternalWait = (
    campaignId: string,
    cycleId: string,
  ): AutonomousCampaignAttemptTransitionResult => {
    const operation = getDb().transaction(() => {
      const nowMs = options.now();
      const context = resolveContext(campaignId, cycleId);
      assertOwnedLease(context.campaign, owner, nowMs);
      if (
        context.campaign.status !== 'running' ||
        context.cycle.status !== 'waiting_for_external' ||
        context.attempt.status !== 'running' ||
        context.attempt.activeStartedAt
      ) {
        invalidTransition(
          `Attempt ${context.attempt.id} cannot resume external work from ${context.campaign.status}/${context.cycle.status}/${context.attempt.status}`,
        );
      }
      const ts = timestamp(nowMs);
      getDb()
        .prepare(
          `UPDATE autonomous_attempts
              SET active_started_at = ?,
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(ts, ts, context.attempt.id);
      getDb()
        .prepare(
          `UPDATE autonomous_cycles
              SET status = 'delivering',
                  last_error = NULL,
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(ts, cycleId);
      return transitionResult(campaignId, cycleId, context.attempt.id);
    });
    return operation.immediate();
  };

  const failAttempt = (
    campaignId: string,
    cycleId: string,
    input: AutonomousCampaignAttemptFailure,
  ): AutonomousCampaignAttemptTransitionResult => {
    const operation = getDb().transaction(() => {
      const nowMs = options.now();
      const context = resolveContext(campaignId, cycleId);
      assertOwnedLease(context.campaign, owner, nowMs);
      return failResolvedAttempt(context, input, nowMs);
    });
    return operation.immediate();
  };

  const pause = (
    campaignId: string,
    cycleId: string,
  ): AutonomousCampaignAttemptTransitionResult => {
    let taskId: string | undefined;
    const operation = getDb().transaction(() => {
      const nowMs = options.now();
      const context = resolveContext(campaignId, cycleId);
      assertOwnedLease(context.campaign, owner, nowMs);
      if (context.campaign.status !== 'running') {
        invalidTransition(
          `Campaign ${campaignId} cannot pause from ${context.campaign.status}`,
        );
      }
      if (
        context.cycle.status === 'stopped' ||
        context.cycle.status === 'succeeded' ||
        context.cycle.status === 'paused'
      ) {
        invalidTransition(
          `Cycle ${cycleId} cannot pause from ${context.cycle.status}`,
        );
      }
      const attempt = closeActiveElapsed(context.attempt, nowMs);
      const ts = timestamp(nowMs);
      if (attempt.status === 'running') {
        getDb()
          .prepare(
            `UPDATE autonomous_attempts
                SET status = 'paused',
                    active_started_at = NULL,
                    updated_at = ?
              WHERE id = ?`,
          )
          .run(ts, attempt.id);
      }
      getDb()
        .prepare(
          `UPDATE autonomous_cycles
              SET status = 'paused',
                  last_error = ?,
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(pausedFromStatus(context.cycle), ts, cycleId);
      getDb()
        .prepare(
          `UPDATE autonomous_campaigns
              SET status = 'paused',
                  pause_requested_at = ?,
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(ts, ts, campaignId);
      taskId = context.cycle.taskId;
      return transitionResult(campaignId, cycleId, context.attempt.id);
    });
    const result = operation.immediate();
    if (taskId) options.interruptTask(taskId, 'pause');
    return result;
  };

  const resume = (
    campaignId: string,
    cycleId: string,
  ): AutonomousCampaignAttemptTransitionResult => {
    const operation = getDb().transaction(() => {
      const nowMs = options.now();
      const context = resolveContext(campaignId, cycleId);
      assertOwnedLease(context.campaign, owner, nowMs);
      if (
        context.campaign.status !== 'paused' ||
        context.cycle.status !== 'paused'
      ) {
        invalidTransition(
          `Campaign ${campaignId} and cycle ${cycleId} are not paused`,
        );
      }
      const nextCycleStatus = previousCycleStatus(context.cycle);
      const nextCycleError = previousCycleError(context.cycle);
      const ts = timestamp(nowMs);
      if (context.attempt.status === 'paused') {
        getDb()
          .prepare(
            `UPDATE autonomous_attempts
                SET status = 'running',
                   active_started_at = CASE
                     WHEN ? = 'waiting_for_external' THEN NULL
                     ELSE ?
                   END,
                   updated_at = ?
              WHERE id = ?`,
          )
          .run(nextCycleStatus, ts, ts, context.attempt.id);
      }
      getDb()
        .prepare(
          `UPDATE autonomous_cycles
              SET status = ?,
                  last_error = ?,
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(nextCycleStatus, nextCycleError ?? null, ts, cycleId);
      getDb()
        .prepare(
          `UPDATE autonomous_campaigns
              SET status = 'running',
                  pause_requested_at = NULL,
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(ts, campaignId);
      return transitionResult(campaignId, cycleId, context.attempt.id);
    });
    return operation.immediate();
  };

  const stop = (
    campaignId: string,
    cycleId: string,
  ): AutonomousCampaignAttemptTransitionResult => {
    let taskId: string | undefined;
    const operation = getDb().transaction(() => {
      const nowMs = options.now();
      const context = resolveContext(campaignId, cycleId);
      if (context.campaign.status === 'stopped') {
        return transitionResult(campaignId, cycleId, context.attempt.id);
      }
      assertOwnedLease(context.campaign, owner, nowMs);
      const attempt = closeActiveElapsed(context.attempt, nowMs);
      const ts = timestamp(nowMs);
      getDb()
        .prepare(
          `UPDATE autonomous_attempts
              SET status = 'stopped',
                  active_started_at = NULL,
                  completed_at = COALESCE(completed_at, ?),
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(ts, ts, attempt.id);
      getDb()
        .prepare(
          `UPDATE autonomous_cycles
              SET status = 'stopped',
                  next_retry_at = NULL,
                  completed_at = COALESCE(completed_at, ?),
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(ts, ts, cycleId);
      getDb()
        .prepare(
          `UPDATE autonomous_campaigns
              SET status = 'stopped',
                  stop_requested_at = ?,
                  pause_requested_at = NULL,
                  lease_owner = NULL,
                  lease_expires_at = NULL,
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(ts, ts, campaignId);
      taskId = context.cycle.taskId;
      return transitionResult(campaignId, cycleId, context.attempt.id);
    });
    const result = operation.immediate();
    if (taskId) options.interruptTask(taskId, 'stop');
    return result;
  };

  const startDueRetry = (
    campaignId: string,
    cycleId: string,
  ): AutonomousCampaignRetryStartResult => {
    const operation = getDb().transaction(() => {
      const nowMs = options.now();
      const context = resolveContext(campaignId, cycleId);
      if (
        context.campaign.status !== 'running' ||
        context.cycle.status !== 'retry_wait'
      ) {
        return {
          started: false,
          cycle: context.cycle,
          attempt: context.attempt,
        };
      }
      assertOwnedLease(context.campaign, owner, nowMs);
      const retryAtMs = context.cycle.nextRetryAt
        ? Date.parse(context.cycle.nextRetryAt)
        : Number.NaN;
      if (!Number.isFinite(retryAtMs) || retryAtMs > nowMs) {
        return {
          started: false,
          cycle: context.cycle,
          attempt: context.attempt,
        };
      }
      const nextAttemptNumber = context.attempt.attemptNumber + 1;
      const attempt = campaignStore.createAttempt({
        cycleId,
        attemptNumber: nextAttemptNumber,
        status: 'running',
        idempotencyKey: `${cycleId}-attempt-${nextAttemptNumber}`,
        leaseOwner: owner,
        nowMs,
      });
      const ts = timestamp(nowMs);
      getDb()
        .prepare(
          `UPDATE autonomous_cycles
              SET status = 'delivering',
                  next_retry_at = NULL,
                  updated_at = ?
            WHERE id = ?
              AND status = 'retry_wait'`,
        )
        .run(ts, cycleId);
      const cycle = campaignStore.getCycle(cycleId);
      if (!cycle) {
        throw new AutonomousCampaignAttemptManagerError(
          `Campaign cycle ${cycleId} disappeared during retry`,
          AUTONOMOUS_CAMPAIGN_ATTEMPT_CONFLICT,
        );
      }
      return { started: true, cycle, attempt };
    });
    return operation.immediate();
  };

  return {
    evaluateBeforeAction,
    recordUsage,
    waitForExternal,
    resumeExternalWait,
    failAttempt,
    pause,
    resume,
    stop,
    startDueRetry,
  };
}
