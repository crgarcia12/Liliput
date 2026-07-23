import { randomUUID } from 'node:crypto';
import type {
  AutonomousCampaign,
  AutonomousCampaignCycleStatus,
} from '../../../shared/types/autonomous-campaign-state.js';
import type {
  AutonomousCampaignAction,
  AutonomousCampaignDetailResponse,
} from '../../../shared/types/autonomous-campaign-controls.js';
import {
  claimCampaignLease,
  createCycle,
  getCampaign,
  getCycle,
  getLatestAttempt,
  listAttempts,
  transitionCampaign,
} from '../stores/autonomous-campaign-store.js';
import { getDb } from '../stores/db.js';
import {
  AutonomousCampaignAttemptManagerError,
  createAutonomousCampaignAttemptManager,
  type AutonomousCampaignTaskInterruptReason,
} from './autonomous-campaign-attempt-manager.js';
import { getCampaignEvidenceSnapshot } from './autonomous-campaign-evidence.js';
import { getPodId } from './pod-identity.js';

const PAUSED_FROM_PREFIX = 'campaign-control:paused-from:';
const DEFAULT_CONTROL_LEASE_TTL_MS = 60_000;

export interface AutonomousCampaignControlOptions {
  owner?: string;
  leaseTtlMs?: number;
  interruptTask?: (
    taskId: string,
    reason: AutonomousCampaignTaskInterruptReason,
  ) => void;
  resumeTask?: (taskId: string) => void;
}

export class AutonomousCampaignControlError extends Error {
  constructor(
    message: string,
    readonly code: 'CAMPAIGN_NOT_FOUND' | 'INVALID_CAMPAIGN_ACTION',
  ) {
    super(message);
    this.name = 'AutonomousCampaignControlError';
  }
}

function requireCampaign(campaignId: string): AutonomousCampaign {
  const campaign = getCampaign(campaignId);
  if (!campaign) {
    throw new AutonomousCampaignControlError(
      `Autonomous campaign not found: ${campaignId}`,
      'CAMPAIGN_NOT_FOUND',
    );
  }
  return campaign;
}

function assertStatus(
  campaign: AutonomousCampaign,
  action: AutonomousCampaignAction,
  expected: AutonomousCampaign['status'],
): void {
  if (campaign.status !== expected) {
    throw new AutonomousCampaignControlError(
      `Cannot ${action} campaign ${campaign.id} while it is ${campaign.status}`,
      'INVALID_CAMPAIGN_ACTION',
    );
  }
}

function allowedActions(
  status: AutonomousCampaign['status'],
): AutonomousCampaignAction[] {
  switch (status) {
    case 'draft':
      return ['start', 'stop'];
    case 'running':
    case 'pausing':
      return ['pause', 'stop'];
    case 'paused':
      return ['resume', 'stop'];
    case 'stopping':
      return ['stop'];
    case 'stopped':
      return [];
  }
}

function previousCycleStatus(lastError: string | undefined): AutonomousCampaignCycleStatus {
  if (!lastError?.startsWith(PAUSED_FROM_PREFIX)) return 'proposing';
  return lastError.slice(PAUSED_FROM_PREFIX.length) as AutonomousCampaignCycleStatus;
}

function runAttemptControl(
  campaignId: string,
  nowMs: number,
  options: AutonomousCampaignControlOptions,
  action: 'pause' | 'resume' | 'stop',
): AutonomousCampaignDetailResponse | undefined {
  const campaign = requireCampaign(campaignId);
  if (!campaign.currentCycleId) return undefined;
  const cycle = getCycle(campaign.currentCycleId);
  if (!cycle || !getLatestAttempt(cycle.id)) return undefined;
  const owner = options.owner ?? getPodId();
  const lease = claimCampaignLease({
    campaignId,
    owner,
    nowMs,
    ttlMs: options.leaseTtlMs ?? DEFAULT_CONTROL_LEASE_TTL_MS,
  });
  if (!lease.claimed) {
    throw new AutonomousCampaignControlError(
      `Campaign ${campaignId} is controlled by another coordinator`,
      'INVALID_CAMPAIGN_ACTION',
    );
  }
  const manager = createAutonomousCampaignAttemptManager({
    owner,
    now: () => nowMs,
    interruptTask: options.interruptTask ?? (() => undefined),
  });
  try {
    const result = manager[action](campaignId, cycle.id);
    if (
      action === 'resume' &&
      result.cycle.status === 'delivering' &&
      result.cycle.taskId
    ) {
      options.resumeTask?.(result.cycle.taskId);
    }
  } catch (error) {
    if (error instanceof AutonomousCampaignAttemptManagerError) {
      throw new AutonomousCampaignControlError(
        error.message,
        'INVALID_CAMPAIGN_ACTION',
      );
    }
    throw error;
  }
  return getCampaignDetail(campaignId);
}

export function getCampaignDetail(
  campaignId: string,
): AutonomousCampaignDetailResponse {
  const campaign = requireCampaign(campaignId);
  const cycle = campaign.currentCycleId
    ? (getCycle(campaign.currentCycleId) ?? null)
    : null;
  const attempts = cycle ? listAttempts(cycle.id) : [];
  const usage = getDb()
    .prepare(
      `SELECT COALESCE(SUM(attempt.turns_used), 0) AS turns
         FROM autonomous_attempts attempt
         JOIN autonomous_cycles cycle ON cycle.id = attempt.cycle_id
        WHERE cycle.campaign_id = ?`,
    )
    .get(campaignId) as { turns: number };
  return {
    campaign: {
      ...campaign,
      cumulativeTurns: usage.turns,
    },
    cycle,
    attempts,
    evidenceSnapshot: cycle
      ? (getCampaignEvidenceSnapshot(cycle.id) ?? null)
      : null,
    allowedActions: allowedActions(campaign.status),
  };
}

export function startCampaign(
  campaignId: string,
  nowMs = Date.now(),
): AutonomousCampaignDetailResponse {
  const operation = getDb().transaction(() => {
    const campaign = requireCampaign(campaignId);
    assertStatus(campaign, 'start', 'draft');
    const transition = transitionCampaign({
      campaignId,
      expectedStatus: 'draft',
      nextStatus: 'running',
      idempotencyKey: `control:start:${campaignId}:${randomUUID()}`,
      nowMs,
    });
    if (!transition.applied) {
      throw new AutonomousCampaignControlError(
        `Campaign ${campaignId} could not be started`,
        'INVALID_CAMPAIGN_ACTION',
      );
    }
    createCycle({
      campaignId,
      sequence: campaign.nextSequence,
      title: `Autonomous feature proposal ${campaign.nextSequence}`,
      status: 'proposing',
      nowMs,
    });
    return getCampaignDetail(campaignId);
  });
  return operation.immediate();
}

export function pauseCampaign(
  campaignId: string,
  nowMs = Date.now(),
  options: AutonomousCampaignControlOptions = {},
): AutonomousCampaignDetailResponse {
  const attemptResult = runAttemptControl(
    campaignId,
    nowMs,
    options,
    'pause',
  );
  if (attemptResult) return attemptResult;
  const operation = getDb().transaction(() => {
    const campaign = requireCampaign(campaignId);
    assertStatus(campaign, 'pause', 'running');
    if (!campaign.currentCycleId) {
      throw new AutonomousCampaignControlError(
        `Campaign ${campaignId} has no current cycle to pause`,
        'INVALID_CAMPAIGN_ACTION',
      );
    }
    const cycle = getCycle(campaign.currentCycleId);
    if (!cycle || cycle.status === 'stopped' || cycle.status === 'succeeded') {
      throw new AutonomousCampaignControlError(
        `Campaign ${campaignId} has no active cycle to pause`,
        'INVALID_CAMPAIGN_ACTION',
      );
    }
    transitionCampaign({
      campaignId,
      expectedStatus: 'running',
      nextStatus: 'paused',
      idempotencyKey: `control:pause:${campaignId}:${randomUUID()}`,
      leaseOwner: campaign.leaseOwner,
      nowMs,
    });
    const timestamp = new Date(nowMs).toISOString();
    getDb()
      .prepare(
        `UPDATE autonomous_cycles
            SET status = 'paused',
                last_error = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(`${PAUSED_FROM_PREFIX}${cycle.status}`, timestamp, cycle.id);
    getDb()
      .prepare(
        `UPDATE autonomous_campaigns
            SET pause_requested_at = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(timestamp, timestamp, campaignId);
    return getCampaignDetail(campaignId);
  });
  return operation.immediate();
}

export function resumeCampaign(
  campaignId: string,
  nowMs = Date.now(),
  options: AutonomousCampaignControlOptions = {},
): AutonomousCampaignDetailResponse {
  const attemptResult = runAttemptControl(
    campaignId,
    nowMs,
    options,
    'resume',
  );
  if (attemptResult) return attemptResult;
  const operation = getDb().transaction(() => {
    const campaign = requireCampaign(campaignId);
    assertStatus(campaign, 'resume', 'paused');
    if (!campaign.currentCycleId) {
      throw new AutonomousCampaignControlError(
        `Campaign ${campaignId} has no current cycle to resume`,
        'INVALID_CAMPAIGN_ACTION',
      );
    }
    const cycle = getCycle(campaign.currentCycleId);
    if (!cycle || cycle.status !== 'paused') {
      throw new AutonomousCampaignControlError(
        `Campaign ${campaignId} has no paused cycle to resume`,
        'INVALID_CAMPAIGN_ACTION',
      );
    }
    transitionCampaign({
      campaignId,
      expectedStatus: 'paused',
      nextStatus: 'running',
      idempotencyKey: `control:resume:${campaignId}:${randomUUID()}`,
      leaseOwner: campaign.leaseOwner,
      nowMs,
    });
    const timestamp = new Date(nowMs).toISOString();
    getDb()
      .prepare(
        `UPDATE autonomous_cycles
            SET status = ?,
                last_error = NULL,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(previousCycleStatus(cycle.lastError), timestamp, cycle.id);
    getDb()
      .prepare(
        `UPDATE autonomous_campaigns
            SET pause_requested_at = NULL,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(timestamp, campaignId);
    return getCampaignDetail(campaignId);
  });
  return operation.immediate();
}

export function stopCampaign(
  campaignId: string,
  nowMs = Date.now(),
  options: AutonomousCampaignControlOptions = {},
): AutonomousCampaignDetailResponse {
  const attemptResult = runAttemptControl(
    campaignId,
    nowMs,
    options,
    'stop',
  );
  if (attemptResult) return attemptResult;
  const operation = getDb().transaction(() => {
    const campaign = requireCampaign(campaignId);
    if (campaign.status === 'stopped') {
      throw new AutonomousCampaignControlError(
        `Campaign ${campaignId} is already stopped`,
        'INVALID_CAMPAIGN_ACTION',
      );
    }
    transitionCampaign({
      campaignId,
      expectedStatus: campaign.status,
      nextStatus: 'stopped',
      idempotencyKey: `control:stop:${campaignId}:${randomUUID()}`,
      leaseOwner: campaign.leaseOwner,
      nowMs,
    });
    const timestamp = new Date(nowMs).toISOString();
    getDb()
      .prepare(
        `UPDATE autonomous_campaigns
            SET stop_requested_at = ?,
                pause_requested_at = NULL,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(timestamp, timestamp, campaignId);
    if (campaign.currentCycleId) {
      getDb()
        .prepare(
          `UPDATE autonomous_cycles
              SET status = 'stopped',
                  completed_at = COALESCE(completed_at, ?),
                  updated_at = ?
            WHERE id = ?
              AND status NOT IN ('stopped', 'succeeded')`,
        )
        .run(timestamp, timestamp, campaign.currentCycleId);
    }
    return getCampaignDetail(campaignId);
  });
  return operation.immediate();
}
