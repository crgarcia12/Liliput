import { v4 as uuid } from 'uuid';
import {
  AUTONOMOUS_CAMPAIGN_ATTEMPT_NOT_FOUND_CODE,
  AUTONOMOUS_CAMPAIGN_CYCLE_NOT_FOUND_CODE,
  AUTONOMOUS_CAMPAIGN_CONFLICT_CODE,
  AUTONOMOUS_CAMPAIGN_DEFAULTS,
  AUTONOMOUS_CAMPAIGN_NOT_FOUND_CODE,
  type AutonomousCampaign,
  type AutonomousCampaignAttempt,
  type AutonomousCampaignCycle,
  type AutonomousCampaignCycleStatus,
  type AutonomousCampaignIdeaSource,
  type AutonomousCampaignJsonObject,
  type AutonomousCampaignLeaseClaimResult,
  type AutonomousCampaignModelConfig,
  type AutonomousCampaignTransitionResult,
  type AutonomousCycleRetryResult,
  type ClaimAutonomousCampaignLeaseInput,
  type CreateAutonomousCampaignAttemptInput,
  type CreateAutonomousCampaignCycleInput,
  type CreateAutonomousCampaignInput,
  type RecordAutonomousAttemptUsageInput,
  type ScheduleAutonomousCycleRetryInput,
  type TransitionAutonomousCampaignInput,
  type AutonomousCampaignStoreErrorCode,
} from '../../../shared/types/autonomous-campaign-state.js';
import type { AutonomousCampaignBoundedAttempt } from '../../../shared/types/autonomous-campaign-attempt-bounds.js';
import { nextRetryDelayMinutes } from '../engine/autonomous-campaign-primitives.js';
import { getDb } from './db.js';

interface CampaignRow {
  id: string;
  repository: string;
  base_branch: string;
  status: AutonomousCampaign['status'];
  release_policy: AutonomousCampaign['releasePolicy'];
  idea_sources_json: string;
  model_config_json: string;
  max_turns_per_attempt: number;
  max_minutes_per_attempt: number;
  max_cost_usd_per_attempt: number;
  retry_backoff_cap_minutes: number;
  success_cooldown_minutes: number;
  failed_attempt_alert_threshold: number;
  cumulative_cost_alert_usd: number;
  cumulative_cost_usd: number;
  next_sequence: number;
  current_cycle_id: string | null;
  lease_owner: string | null;
  lease_expires_at: number | null;
  pause_requested_at: string | null;
  stop_requested_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface CycleRow {
  id: string;
  campaign_id: string;
  sequence: number;
  title: string;
  status: AutonomousCampaignCycle['status'];
  proposal_json: string | null;
  proposal_fingerprint: string | null;
  base_sha: string | null;
  workstream_id: string | null;
  task_id: string | null;
  branch_name: string | null;
  image_ref: string | null;
  preview_namespace: string | null;
  preview_url: string | null;
  pull_request_url: string | null;
  pull_request_number: number | null;
  review_decision_json: string | null;
  release_gates_json: string | null;
  merge_sha: string | null;
  next_retry_at: string | null;
  retry_delay_minutes: number | null;
  started_at: string;
  completed_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface AttemptRow {
  id: string;
  cycle_id: string;
  attempt_number: number;
  status: AutonomousCampaignAttempt['status'];
  turns_used: number;
  elapsed_ms: number;
  estimated_cost_usd: number;
  max_turns: number;
  max_elapsed_ms: number;
  max_estimated_cost_usd: number;
  active_started_at: string | null;
  started_at: string;
  completed_at: string | null;
  failure_stage: string | null;
  failure_message: string | null;
  created_at: string;
  updated_at: string;
}

interface TransitionRow {
  campaign_id: string;
  expected_status: AutonomousCampaign['status'];
  next_status: AutonomousCampaign['status'];
  applied: number;
  result_json: string;
}

export class AutonomousCampaignConflictError extends Error {
  readonly code = AUTONOMOUS_CAMPAIGN_CONFLICT_CODE;

  constructor(message: string) {
    super(message);
    this.name = 'AutonomousCampaignConflictError';
  }
}

export class AutonomousCampaignStoreError extends Error {
  constructor(
    message: string,
    readonly code: AutonomousCampaignStoreErrorCode,
  ) {
    super(message);
    this.name = 'AutonomousCampaignStoreError';
  }
}

function now(): string {
  return new Date().toISOString();
}

function optional<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function hydrateCampaign(row: CampaignRow): AutonomousCampaign {
  return {
    id: row.id,
    repository: row.repository,
    baseBranch: row.base_branch,
    status: row.status,
    releasePolicy: row.release_policy,
    ideaSources: parseJson<AutonomousCampaignIdeaSource[]>(
      row.idea_sources_json,
    ),
    modelConfig: parseJson<AutonomousCampaignModelConfig>(
      row.model_config_json,
    ),
    maxTurnsPerAttempt: row.max_turns_per_attempt,
    maxMinutesPerAttempt: row.max_minutes_per_attempt,
    maxCostUsdPerAttempt: row.max_cost_usd_per_attempt,
    retryBackoffCapMinutes: row.retry_backoff_cap_minutes,
    successCooldownMinutes: row.success_cooldown_minutes,
    failedAttemptAlertThreshold: row.failed_attempt_alert_threshold,
    cumulativeCostAlertUsd: row.cumulative_cost_alert_usd,
    cumulativeCostUsd: row.cumulative_cost_usd,
    nextSequence: row.next_sequence,
    currentCycleId: optional(row.current_cycle_id),
    leaseOwner: optional(row.lease_owner),
    leaseExpiresAt: optional(row.lease_expires_at),
    pauseRequestedAt: optional(row.pause_requested_at),
    stopRequestedAt: optional(row.stop_requested_at),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hydrateCycle(row: CycleRow): AutonomousCampaignCycle {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    sequence: row.sequence,
    title: row.title,
    status: row.status,
    proposal: row.proposal_json
      ? parseJson<AutonomousCampaignJsonObject>(row.proposal_json)
      : undefined,
    proposalFingerprint: optional(row.proposal_fingerprint),
    baseSha: optional(row.base_sha),
    workstreamId: optional(row.workstream_id),
    taskId: optional(row.task_id),
    branchName: optional(row.branch_name),
    imageRef: optional(row.image_ref),
    previewNamespace: optional(row.preview_namespace),
    previewUrl: optional(row.preview_url),
    pullRequestUrl: optional(row.pull_request_url),
    pullRequestNumber: optional(row.pull_request_number),
    reviewDecision: row.review_decision_json
      ? parseJson<AutonomousCampaignJsonObject>(row.review_decision_json)
      : undefined,
    releaseGates: row.release_gates_json
      ? parseJson<AutonomousCampaignJsonObject>(row.release_gates_json)
      : undefined,
    mergeSha: optional(row.merge_sha),
    nextRetryAt: optional(row.next_retry_at),
    retryDelayMinutes: optional(row.retry_delay_minutes),
    startedAt: row.started_at,
    completedAt: optional(row.completed_at),
    lastError: optional(row.last_error),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hydrateAttempt(row: AttemptRow): AutonomousCampaignBoundedAttempt {
  return {
    id: row.id,
    cycleId: row.cycle_id,
    attemptNumber: row.attempt_number,
    status: row.status,
    turnsUsed: row.turns_used,
    elapsedMs: row.elapsed_ms,
    estimatedCostUsd: row.estimated_cost_usd,
    maxTurns: row.max_turns,
    maxElapsedMs: row.max_elapsed_ms,
    maxEstimatedCostUsd: row.max_estimated_cost_usd,
    activeStartedAt: optional(row.active_started_at),
    startedAt: row.started_at,
    completedAt: optional(row.completed_at),
    failureStage: optional(row.failure_stage),
    failureMessage: optional(row.failure_message),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code =
    'code' in error && typeof error.code === 'string' ? error.code : '';
  return (
    code.startsWith('SQLITE_CONSTRAINT') ||
    /(?:UNIQUE|CHECK|NOT NULL) constraint failed/i.test(error.message)
  );
}

function asConflict(error: unknown, message: string): never {
  if (isConstraintError(error)) {
    throw new AutonomousCampaignConflictError(message);
  }
  throw error;
}

function assertLeaseOwner(
  campaign: CampaignRow,
  leaseOwner: string | undefined,
  nowMs = Date.now(),
): void {
  const hasUnexpiredLease =
    campaign.lease_owner !== null &&
    campaign.lease_expires_at !== null &&
    campaign.lease_expires_at > nowMs;
  if (hasUnexpiredLease && campaign.lease_owner !== leaseOwner) {
    throw new AutonomousCampaignConflictError(
      `Campaign ${campaign.id} is leased by another coordinator`,
    );
  }
}

function assertActiveLeaseOwner(
  campaign: CampaignRow,
  leaseOwner: string,
  nowMs: number,
): void {
  if (
    campaign.lease_owner !== leaseOwner ||
    campaign.lease_expires_at === null ||
    campaign.lease_expires_at <= nowMs
  ) {
    throw new AutonomousCampaignConflictError(
      `Campaign ${campaign.id} is not actively leased by ${leaseOwner}`,
    );
  }
}

function requireCampaignRow(campaignId: string): CampaignRow {
  const row = getDb()
    .prepare('SELECT * FROM autonomous_campaigns WHERE id = ?')
    .get(campaignId) as CampaignRow | undefined;
  if (!row) {
    throw new AutonomousCampaignStoreError(
      `Autonomous campaign not found: ${campaignId}`,
      AUTONOMOUS_CAMPAIGN_NOT_FOUND_CODE,
    );
  }
  return row;
}

function requireCycleRow(cycleId: string): CycleRow {
  const row = getDb()
    .prepare('SELECT * FROM autonomous_cycles WHERE id = ?')
    .get(cycleId) as CycleRow | undefined;
  if (!row) {
    throw new AutonomousCampaignStoreError(
      `Autonomous campaign cycle not found: ${cycleId}`,
      AUTONOMOUS_CAMPAIGN_CYCLE_NOT_FOUND_CODE,
    );
  }
  return row;
}

function requireAttemptRow(attemptId: string): AttemptRow {
  const row = getDb()
    .prepare('SELECT * FROM autonomous_attempts WHERE id = ?')
    .get(attemptId) as AttemptRow | undefined;
  if (!row) {
    throw new AutonomousCampaignStoreError(
      `Autonomous campaign attempt not found: ${attemptId}`,
      AUTONOMOUS_CAMPAIGN_ATTEMPT_NOT_FOUND_CODE,
    );
  }
  return row;
}

export function createCampaign(
  input: CreateAutonomousCampaignInput,
  options: { occurredAt?: string } = {},
): AutonomousCampaign {
  const db = getDb();
  const ts = options.occurredAt ?? now();
  const campaign: AutonomousCampaign = {
    id: uuid(),
    repository: input.repository.trim(),
    baseBranch: input.baseBranch.trim(),
    status: 'draft',
    releasePolicy:
      input.releasePolicy ?? AUTONOMOUS_CAMPAIGN_DEFAULTS.releasePolicy,
    ideaSources: input.ideaSources
      ? [...input.ideaSources]
      : [...AUTONOMOUS_CAMPAIGN_DEFAULTS.ideaSources],
    modelConfig: input.modelConfig ?? {},
    maxTurnsPerAttempt:
      input.maxTurnsPerAttempt ??
      AUTONOMOUS_CAMPAIGN_DEFAULTS.maxTurnsPerAttempt,
    maxMinutesPerAttempt:
      input.maxMinutesPerAttempt ??
      AUTONOMOUS_CAMPAIGN_DEFAULTS.maxMinutesPerAttempt,
    maxCostUsdPerAttempt:
      input.maxCostUsdPerAttempt ??
      AUTONOMOUS_CAMPAIGN_DEFAULTS.maxCostUsdPerAttempt,
    retryBackoffCapMinutes:
      input.retryBackoffCapMinutes ??
      AUTONOMOUS_CAMPAIGN_DEFAULTS.retryBackoffCapMinutes,
    successCooldownMinutes:
      input.successCooldownMinutes ??
      AUTONOMOUS_CAMPAIGN_DEFAULTS.successCooldownMinutes,
    failedAttemptAlertThreshold:
      input.failedAttemptAlertThreshold ??
      AUTONOMOUS_CAMPAIGN_DEFAULTS.failedAttemptAlertThreshold,
    cumulativeCostAlertUsd:
      input.cumulativeCostAlertUsd ??
      AUTONOMOUS_CAMPAIGN_DEFAULTS.cumulativeCostAlertUsd,
    cumulativeCostUsd: 0,
    nextSequence: 1,
    createdBy: input.createdBy ?? 'system',
    createdAt: ts,
    updatedAt: ts,
  };

  try {
    db.prepare(
      `INSERT INTO autonomous_campaigns (
         id, repository, base_branch, status, release_policy,
         idea_sources_json, model_config_json, max_turns_per_attempt,
         max_minutes_per_attempt, max_cost_usd_per_attempt,
         retry_backoff_cap_minutes, success_cooldown_minutes,
         failed_attempt_alert_threshold, cumulative_cost_alert_usd,
         cumulative_cost_usd, next_sequence, created_by, created_at, updated_at
       ) VALUES (
         @id, @repository, @baseBranch, @status, @releasePolicy,
         @ideaSourcesJson, @modelConfigJson, @maxTurnsPerAttempt,
         @maxMinutesPerAttempt, @maxCostUsdPerAttempt,
         @retryBackoffCapMinutes, @successCooldownMinutes,
         @failedAttemptAlertThreshold, @cumulativeCostAlertUsd,
         @cumulativeCostUsd, @nextSequence, @createdBy, @createdAt, @updatedAt
       )`,
    ).run({
      ...campaign,
      ideaSourcesJson: JSON.stringify(campaign.ideaSources),
      modelConfigJson: JSON.stringify(campaign.modelConfig),
    });
  } catch (error) {
    asConflict(
      error,
      `An active campaign already targets ${campaign.repository}:${campaign.baseBranch}`,
    );
  }

  return campaign;
}

export function getCampaign(id: string): AutonomousCampaign | undefined {
  const row = getDb()
    .prepare('SELECT * FROM autonomous_campaigns WHERE id = ?')
    .get(id) as CampaignRow | undefined;
  return row ? hydrateCampaign(row) : undefined;
}

export function listCampaigns(): AutonomousCampaign[] {
  const rows = getDb()
    .prepare(
      `SELECT *
         FROM autonomous_campaigns
        ORDER BY created_at DESC, id DESC`,
    )
    .all() as CampaignRow[];
  return rows.map(hydrateCampaign);
}

export function listRunningCampaigns(): AutonomousCampaign[] {
  const rows = getDb()
    .prepare(
      `SELECT *
         FROM autonomous_campaigns
        WHERE status = 'running'
        ORDER BY created_at ASC, id ASC`,
    )
    .all() as CampaignRow[];
  return rows.map(hydrateCampaign);
}

export function createCycle(
  input: CreateAutonomousCampaignCycleInput,
): AutonomousCampaignCycle {
  const db = getDb();
  const ts = new Date(input.nowMs ?? Date.now()).toISOString();
  const cycle: AutonomousCampaignCycle = {
    id: uuid(),
    campaignId: input.campaignId,
    sequence: input.sequence,
    title: input.title,
    status: input.status ?? 'proposing',
    proposal: input.proposal,
    proposalFingerprint: input.proposalFingerprint,
    baseSha: input.baseSha,
    startedAt: ts,
    createdAt: ts,
    updatedAt: ts,
  };

  const create = db.transaction(() => {
    const campaign = requireCampaignRow(input.campaignId);
    assertLeaseOwner(campaign, input.leaseOwner, input.nowMs);
    db.prepare(
      `INSERT INTO autonomous_cycles (
         id, campaign_id, sequence, title, status, proposal_json,
         proposal_fingerprint, base_sha, started_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      cycle.id,
      cycle.campaignId,
      cycle.sequence,
      cycle.title,
      cycle.status,
      cycle.proposal ? JSON.stringify(cycle.proposal) : null,
      cycle.proposalFingerprint ?? null,
      cycle.baseSha ?? null,
      cycle.startedAt,
      cycle.createdAt,
      cycle.updatedAt,
    );
    db.prepare(
      `UPDATE autonomous_campaigns
          SET current_cycle_id = ?,
              next_sequence = CASE WHEN next_sequence <= ? THEN ? ELSE next_sequence END,
              updated_at = ?
        WHERE id = ?`,
    ).run(cycle.id, cycle.sequence, cycle.sequence + 1, ts, cycle.campaignId);
  });

  try {
    create.immediate();
  } catch (error) {
    asConflict(
      error,
      `Campaign ${input.campaignId} already has an active cycle`,
    );
  }
  return cycle;
}

export function getCycle(id: string): AutonomousCampaignCycle | undefined {
  const row = getDb()
    .prepare('SELECT * FROM autonomous_cycles WHERE id = ?')
    .get(id) as CycleRow | undefined;
  return row ? hydrateCycle(row) : undefined;
}

export function getCurrentCycle(
  campaignId: string,
): AutonomousCampaignCycle | undefined {
  const row = getDb()
    .prepare(
      `SELECT cycle.*
         FROM autonomous_campaigns campaign
         JOIN autonomous_cycles cycle ON cycle.id = campaign.current_cycle_id
        WHERE campaign.id = ?`,
    )
    .get(campaignId) as CycleRow | undefined;
  return row ? hydrateCycle(row) : undefined;
}

export function findActiveCycleByTaskId(
  taskId: string,
): AutonomousCampaignCycle | undefined {
  const row = getDb()
    .prepare(
      `SELECT cycle.*
         FROM autonomous_campaigns campaign
         JOIN autonomous_cycles cycle ON cycle.id = campaign.current_cycle_id
        WHERE cycle.task_id = ?
        LIMIT 1`,
    )
    .get(taskId) as CycleRow | undefined;
  return row ? hydrateCycle(row) : undefined;
}

export interface UpdateAutonomousCampaignDeliveryInput {
  campaignId: string;
  cycleId: string;
  leaseOwner: string;
  nowMs?: number;
  expectedStatus?: AutonomousCampaignCycleStatus;
  status?: AutonomousCampaignCycleStatus;
  workstreamId?: string;
  taskId?: string;
  branchName?: string;
  imageRef?: string;
  previewNamespace?: string;
  previewUrl?: string;
  pullRequestUrl?: string;
  pullRequestNumber?: number;
  reviewDecision?: AutonomousCampaignJsonObject;
  releaseGates?: AutonomousCampaignJsonObject;
  mergeSha?: string;
  nextRetryAt?: string;
  completedAt?: string;
  lastError?: string | null;
}

export function updateCycleDelivery(
  input: UpdateAutonomousCampaignDeliveryInput,
): AutonomousCampaignCycle {
  const db = getDb();
  const update = db.transaction(() => {
    const nowMs = input.nowMs ?? Date.now();
    const campaign = requireCampaignRow(input.campaignId);
    assertActiveLeaseOwner(campaign, input.leaseOwner, nowMs);
    if (campaign.status !== 'running') {
      throw new AutonomousCampaignConflictError(
        `Campaign ${input.campaignId} is not running`,
      );
    }
    if (campaign.current_cycle_id !== input.cycleId) {
      throw new AutonomousCampaignConflictError(
        `Cycle ${input.cycleId} is not current for campaign ${input.campaignId}`,
      );
    }
    const row = requireCycleRow(input.cycleId);
    if (row.campaign_id !== input.campaignId) {
      throw new AutonomousCampaignConflictError(
        `Cycle ${input.cycleId} does not belong to campaign ${input.campaignId}`,
      );
    }
    if (
      input.expectedStatus !== undefined &&
      row.status !== input.expectedStatus
    ) {
      throw new AutonomousCampaignConflictError(
        `Cycle ${input.cycleId} changed from ${input.expectedStatus} to ${row.status}`,
      );
    }
    const current = hydrateCycle(row);
    const ts = new Date(nowMs).toISOString();
    const lastError = Object.prototype.hasOwnProperty.call(input, 'lastError')
      ? input.lastError ?? null
      : current.lastError ?? null;
    db.prepare(
      `UPDATE autonomous_cycles
          SET status = ?,
              workstream_id = ?,
              task_id = ?,
              branch_name = ?,
              image_ref = ?,
              preview_namespace = ?,
              preview_url = ?,
              pull_request_url = ?,
              pull_request_number = ?,
              review_decision_json = ?,
              release_gates_json = ?,
              merge_sha = ?,
              next_retry_at = ?,
              completed_at = ?,
              last_error = ?,
              updated_at = ?
        WHERE id = ?`,
    ).run(
      input.status ?? current.status,
      input.workstreamId ?? current.workstreamId ?? null,
      input.taskId ?? current.taskId ?? null,
      input.branchName ?? current.branchName ?? null,
      input.imageRef ?? current.imageRef ?? null,
      input.previewNamespace ?? current.previewNamespace ?? null,
      input.previewUrl ?? current.previewUrl ?? null,
      input.pullRequestUrl ?? current.pullRequestUrl ?? null,
      input.pullRequestNumber ?? current.pullRequestNumber ?? null,
      input.reviewDecision
        ? JSON.stringify(input.reviewDecision)
        : current.reviewDecision
          ? JSON.stringify(current.reviewDecision)
          : null,
      input.releaseGates
        ? JSON.stringify(input.releaseGates)
        : current.releaseGates
          ? JSON.stringify(current.releaseGates)
          : null,
      input.mergeSha ?? current.mergeSha ?? null,
      input.nextRetryAt ?? current.nextRetryAt ?? null,
      input.completedAt ?? current.completedAt ?? null,
      lastError,
      ts,
      input.cycleId,
    );
    return hydrateCycle(requireCycleRow(input.cycleId));
  });
  return update.immediate();
}

export interface AdvanceAutonomousCampaignAfterCooldownInput {
  campaignId: string;
  cycleId: string;
  leaseOwner: string;
  nowMs: number;
  baseSha?: string;
}

export interface AdvanceAutonomousCampaignAfterCooldownResult {
  advanced: boolean;
  campaign: AutonomousCampaign;
  previousCycle: AutonomousCampaignCycle;
  nextCycle?: AutonomousCampaignCycle;
}

export function advanceCampaignAfterCooldown(
  input: AdvanceAutonomousCampaignAfterCooldownInput,
): AdvanceAutonomousCampaignAfterCooldownResult {
  const db = getDb();
  const advance = db.transaction(() => {
    const campaign = requireCampaignRow(input.campaignId);
    assertActiveLeaseOwner(campaign, input.leaseOwner, input.nowMs);
    const cycle = requireCycleRow(input.cycleId);
    if (cycle.campaign_id !== campaign.id) {
      throw new AutonomousCampaignConflictError(
        `Cycle ${cycle.id} does not belong to campaign ${campaign.id}`,
      );
    }
    if (
      campaign.current_cycle_id !== cycle.id ||
      cycle.status !== 'cooldown' ||
      !cycle.merge_sha
    ) {
      return {
        advanced: false,
        campaign: hydrateCampaign(campaign),
        previousCycle: hydrateCycle(cycle),
      };
    }
    const retryAt = cycle.next_retry_at
      ? Date.parse(cycle.next_retry_at)
      : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(retryAt) || retryAt > input.nowMs) {
      return {
        advanced: false,
        campaign: hydrateCampaign(campaign),
        previousCycle: hydrateCycle(cycle),
      };
    }

    const ts = new Date(input.nowMs).toISOString();
    const sequence = campaign.next_sequence;
    const nextCycle: AutonomousCampaignCycle = {
      id: uuid(),
      campaignId: campaign.id,
      sequence,
      title: `Autonomous feature proposal ${sequence}`,
      status: 'proposing',
      baseSha: input.baseSha ?? cycle.merge_sha,
      startedAt: ts,
      createdAt: ts,
      updatedAt: ts,
    };
    db.prepare(
      `UPDATE autonomous_cycles
          SET status = 'succeeded',
              completed_at = COALESCE(completed_at, ?),
              updated_at = ?
        WHERE id = ?
          AND status = 'cooldown'`,
    ).run(ts, ts, cycle.id);
    db.prepare(
      `INSERT INTO autonomous_cycles (
         id, campaign_id, sequence, title, status, base_sha,
         started_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      nextCycle.id,
      nextCycle.campaignId,
      nextCycle.sequence,
      nextCycle.title,
      nextCycle.status,
      nextCycle.baseSha,
      nextCycle.startedAt,
      nextCycle.createdAt,
      nextCycle.updatedAt,
    );
    db.prepare(
      `UPDATE autonomous_campaigns
          SET current_cycle_id = ?,
              next_sequence = ?,
              updated_at = ?
        WHERE id = ?
          AND current_cycle_id = ?`,
    ).run(
      nextCycle.id,
      sequence + 1,
      ts,
      campaign.id,
      cycle.id,
    );
    return {
      advanced: true,
      campaign: hydrateCampaign(requireCampaignRow(campaign.id)),
      previousCycle: hydrateCycle(requireCycleRow(cycle.id)),
      nextCycle,
    };
  });
  return advance.immediate();
}

export function createAttempt(
  input: CreateAutonomousCampaignAttemptInput,
): AutonomousCampaignBoundedAttempt {
  const db = getDb();
  const create = db.transaction(() => {
    const replay = db
      .prepare(
        `SELECT attempt.*
           FROM autonomous_attempt_idempotency key
           JOIN autonomous_attempts attempt ON attempt.id = key.attempt_id
          WHERE key.idempotency_key = ?`,
      )
      .get(input.idempotencyKey) as AttemptRow | undefined;
    if (replay) {
      if (
        replay.cycle_id !== input.cycleId ||
        replay.attempt_number !== input.attemptNumber
      ) {
        throw new AutonomousCampaignConflictError(
          `Idempotency key ${input.idempotencyKey} was already used`,
        );
      }
      return hydrateAttempt(replay);
    }

    const cycle = requireCycleRow(input.cycleId);
    const campaign = requireCampaignRow(cycle.campaign_id);
    assertLeaseOwner(campaign, input.leaseOwner, input.nowMs);
    const ts = new Date(input.nowMs ?? Date.now()).toISOString();
    const attempt: AutonomousCampaignBoundedAttempt = {
      id: uuid(),
      cycleId: input.cycleId,
      attemptNumber: input.attemptNumber,
      status: input.status ?? 'running',
      turnsUsed: 0,
      elapsedMs: 0,
      estimatedCostUsd: 0,
      maxTurns: campaign.max_turns_per_attempt,
      maxElapsedMs: campaign.max_minutes_per_attempt * 60_000,
      maxEstimatedCostUsd: campaign.max_cost_usd_per_attempt,
      ...(input.status === 'running' || input.status === undefined
        ? { activeStartedAt: ts }
        : {}),
      startedAt: ts,
      createdAt: ts,
      updatedAt: ts,
    };
    db.prepare(
      `INSERT INTO autonomous_attempts (
         id, cycle_id, attempt_number, status, turns_used, elapsed_ms,
         estimated_cost_usd, max_turns, max_elapsed_ms,
         max_estimated_cost_usd, active_started_at, started_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      attempt.id,
      attempt.cycleId,
      attempt.attemptNumber,
      attempt.status,
      attempt.turnsUsed,
      attempt.elapsedMs,
      attempt.estimatedCostUsd,
      attempt.maxTurns,
      attempt.maxElapsedMs,
      attempt.maxEstimatedCostUsd,
      attempt.activeStartedAt ?? null,
      attempt.startedAt,
      attempt.createdAt,
      attempt.updatedAt,
    );
    db.prepare(
      `INSERT INTO autonomous_attempt_idempotency (
         idempotency_key, attempt_id, created_at
       ) VALUES (?, ?, ?)`,
    ).run(input.idempotencyKey, attempt.id, ts);
    return attempt;
  });

  try {
    return create.immediate();
  } catch (error) {
    asConflict(
      error,
      `Cycle ${input.cycleId} already has attempt ${input.attemptNumber}`,
    );
  }
}

export function getAttempt(
  id: string,
): AutonomousCampaignBoundedAttempt | undefined {
  const row = getDb()
    .prepare('SELECT * FROM autonomous_attempts WHERE id = ?')
    .get(id) as AttemptRow | undefined;
  return row ? hydrateAttempt(row) : undefined;
}

export function getLatestAttempt(
  cycleId: string,
): AutonomousCampaignBoundedAttempt | undefined {
  const row = getDb()
    .prepare(
      `SELECT *
         FROM autonomous_attempts
        WHERE cycle_id = ?
        ORDER BY attempt_number DESC
        LIMIT 1`,
    )
    .get(cycleId) as AttemptRow | undefined;
  return row ? hydrateAttempt(row) : undefined;
}

export interface AutonomousCampaignPendingUsage {
  attemptId: string;
  usageEventId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  occurredAt: string;
}

export function recordPendingAttemptUsage(
  input: AutonomousCampaignPendingUsage,
): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO autonomous_attempt_pending_usage (
         attempt_id,
         usage_event_id,
         model,
         input_tokens,
         output_tokens,
         cache_read_tokens,
         cache_write_tokens,
         occurred_at,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.attemptId,
      input.usageEventId,
      input.model,
      input.inputTokens,
      input.outputTokens,
      input.cacheReadTokens,
      input.cacheWriteTokens,
      input.occurredAt,
      new Date().toISOString(),
    );
}

export function listPendingAttemptUsage(
  attemptId: string,
): AutonomousCampaignPendingUsage[] {
  const rows = getDb()
    .prepare(
      `SELECT attempt_id,
              usage_event_id,
              model,
              input_tokens,
              output_tokens,
              cache_read_tokens,
              cache_write_tokens,
              occurred_at
         FROM autonomous_attempt_pending_usage
        WHERE attempt_id = ?
        ORDER BY created_at, usage_event_id`,
    )
    .all(attemptId) as {
    attempt_id: string;
    usage_event_id: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    occurred_at: string;
  }[];
  return rows.map((row) => ({
    attemptId: row.attempt_id,
    usageEventId: row.usage_event_id,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    occurredAt: row.occurred_at,
  }));
}

export function deletePendingAttemptUsage(
  attemptId: string,
  usageEventId: string,
): void {
  getDb()
    .prepare(
      `DELETE FROM autonomous_attempt_pending_usage
        WHERE attempt_id = ?
          AND usage_event_id = ?`,
    )
    .run(attemptId, usageEventId);
}

export function listAttempts(
  cycleId: string,
): AutonomousCampaignBoundedAttempt[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM autonomous_attempts
        WHERE cycle_id = ?
        ORDER BY attempt_number ASC`,
    )
    .all(cycleId) as AttemptRow[];
  return rows.map(hydrateAttempt);
}

export function transitionCampaign(
  input: TransitionAutonomousCampaignInput,
): AutonomousCampaignTransitionResult {
  const db = getDb();
  const transition = db.transaction(() => {
    const replay = db
      .prepare(
        `SELECT campaign_id, expected_status, next_status, applied, result_json
           FROM autonomous_campaign_transitions
          WHERE idempotency_key = ?`,
      )
      .get(input.idempotencyKey) as TransitionRow | undefined;
    if (replay) {
      if (
        replay.campaign_id !== input.campaignId ||
        replay.expected_status !== input.expectedStatus ||
        replay.next_status !== input.nextStatus
      ) {
        throw new AutonomousCampaignConflictError(
          `Idempotency key ${input.idempotencyKey} was already used`,
        );
      }
      return {
        applied: replay.applied === 1,
        campaign: parseJson<AutonomousCampaign>(replay.result_json),
      };
    }

    const currentRow = requireCampaignRow(input.campaignId);
    assertLeaseOwner(currentRow, input.leaseOwner, input.nowMs);
    const current = hydrateCampaign(currentRow);
    let result: AutonomousCampaignTransitionResult;
    if (current.status !== input.expectedStatus) {
      result = { applied: false, campaign: current };
    } else {
      const ts = new Date(input.nowMs ?? Date.now()).toISOString();
      const clearLease = input.nextStatus === 'stopped';
      db.prepare(
        `UPDATE autonomous_campaigns
            SET status = ?,
                lease_owner = CASE WHEN ? THEN NULL ELSE lease_owner END,
                lease_expires_at = CASE WHEN ? THEN NULL ELSE lease_expires_at END,
                updated_at = ?
          WHERE id = ? AND status = ?`,
      ).run(
        input.nextStatus,
        clearLease ? 1 : 0,
        clearLease ? 1 : 0,
        ts,
        input.campaignId,
        input.expectedStatus,
      );
      result = {
        applied: true,
        campaign: hydrateCampaign(requireCampaignRow(input.campaignId)),
      };
    }

    db.prepare(
      `INSERT INTO autonomous_campaign_transitions (
         idempotency_key, campaign_id, expected_status, next_status,
         applied, result_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.idempotencyKey,
      input.campaignId,
      input.expectedStatus,
      input.nextStatus,
      result.applied ? 1 : 0,
      JSON.stringify(result.campaign),
      now(),
    );
    return result;
  });

  return transition.immediate();
}

export function claimCampaignLease(
  input: ClaimAutonomousCampaignLeaseInput,
): AutonomousCampaignLeaseClaimResult {
  if (!input.owner.trim()) {
    throw new Error('Campaign lease owner is required');
  }
  if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
    throw new RangeError('Campaign lease ttlMs must be positive');
  }

  const db = getDb();
  const claim = db.transaction(() => {
    requireCampaignRow(input.campaignId);
    const result = db.prepare(
      `UPDATE autonomous_campaigns
          SET lease_owner = ?,
              lease_expires_at = ?,
              updated_at = ?
        WHERE id = ?
          AND status <> 'stopped'
          AND (
            lease_owner IS NULL
            OR lease_expires_at IS NULL
            OR lease_expires_at <= ?
            OR lease_owner = ?
          )`,
    ).run(
      input.owner,
      input.nowMs + input.ttlMs,
      new Date(input.nowMs).toISOString(),
      input.campaignId,
      input.nowMs,
      input.owner,
    );
    return {
      claimed: result.changes === 1,
      campaign: hydrateCampaign(requireCampaignRow(input.campaignId)),
    };
  });

  return claim.immediate();
}

export function scheduleCycleRetry(
  input: ScheduleAutonomousCycleRetryInput,
): AutonomousCycleRetryResult {
  const db = getDb();
  const schedule = db.transaction(() => {
    const cycle = requireCycleRow(input.cycleId);
    const campaign = requireCampaignRow(cycle.campaign_id);
    assertLeaseOwner(campaign, input.leaseOwner, input.nowMs);
    const delayMinutes = nextRetryDelayMinutes(
      input.previousDelayMinutes,
      input.capMinutes,
    );
    const scheduledAtMs = input.nowMs ?? Date.now();
    const ts = new Date(scheduledAtMs).toISOString();
    const nextRetryAt = new Date(
      scheduledAtMs + delayMinutes * 60_000,
    ).toISOString();
    db.prepare(
      `UPDATE autonomous_cycles
          SET status = 'retry_wait',
              retry_delay_minutes = ?,
              next_retry_at = ?,
              updated_at = ?
        WHERE id = ?`,
    ).run(delayMinutes, nextRetryAt, ts, input.cycleId);
    return {
      delayMinutes,
      cycle: hydrateCycle(requireCycleRow(input.cycleId)),
    };
  });

  try {
    return schedule.immediate();
  } catch (error) {
    if (
      error instanceof AutonomousCampaignConflictError ||
      error instanceof AutonomousCampaignStoreError
    ) {
      throw error;
    }
    asConflict(error, `Campaign cycle ${input.cycleId} cannot be retried`);
  }
}

export function recordAttemptUsage(
  input: RecordAutonomousAttemptUsageInput,
): AutonomousCampaignBoundedAttempt {
  if (!Number.isFinite(input.turns) || input.turns < 0) {
    throw new RangeError('Usage turns must be a non-negative number');
  }
  if (
    !Number.isFinite(input.estimatedCostUsd) ||
    input.estimatedCostUsd < 0
  ) {
    throw new RangeError(
      'Usage estimatedCostUsd must be a non-negative number',
    );
  }

  const db = getDb();
  const record = db.transaction(() => {
    requireAttemptRow(input.attemptId);
    const ts = now();
    const inserted = db
      .prepare(
        `INSERT OR IGNORE INTO autonomous_attempt_usage_events (
           attempt_id, usage_event_id, turns, estimated_cost_usd, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.attemptId,
        input.usageEventId,
        input.turns,
        input.estimatedCostUsd,
        ts,
      );
    if (inserted.changes === 1) {
      db.prepare(
        `UPDATE autonomous_attempts
            SET turns_used = turns_used + ?,
                estimated_cost_usd = estimated_cost_usd + ?,
                updated_at = ?
          WHERE id = ?`,
      ).run(input.turns, input.estimatedCostUsd, ts, input.attemptId);
      db.prepare(
        `UPDATE autonomous_campaigns
            SET cumulative_cost_usd = cumulative_cost_usd + ?,
                updated_at = ?
          WHERE id = (
            SELECT cycle.campaign_id
              FROM autonomous_attempts attempt
              JOIN autonomous_cycles cycle ON cycle.id = attempt.cycle_id
             WHERE attempt.id = ?
          )`,
      ).run(input.estimatedCostUsd, ts, input.attemptId);
    }
    return hydrateAttempt(requireAttemptRow(input.attemptId));
  });

  return record.immediate();
}

export function resetAutonomousCampaignStore(): void {
  const db = getDb();
  const reset = db.transaction(() => {
    db.exec(`
      DELETE FROM autonomous_attempt_usage_events;
      DELETE FROM autonomous_attempt_idempotency;
      DELETE FROM autonomous_campaign_transitions;
      DELETE FROM autonomous_attempts;
      DELETE FROM autonomous_cycles;
      DELETE FROM autonomous_campaigns;
    `);
  });
  reset.immediate();
}
