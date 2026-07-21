export type AutonomousCampaignStatus =
  | 'draft'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'stopping'
  | 'stopped';

export type AutonomousCampaignCycleStatus =
  | 'proposing'
  | 'waiting_for_external'
  | 'delivering'
  | 'ready_to_release'
  | 'releasing'
  | 'retry_wait'
  | 'paused'
  | 'cooldown'
  | 'succeeded'
  | 'stopped';

export type AutonomousCampaignAttemptStatus =
  | 'running'
  | 'retry_wait'
  | 'succeeded'
  | 'failed'
  | 'paused'
  | 'stopped';

export type AutonomousCampaignIdeaSource =
  | 'specs'
  | 'code'
  | 'issues'
  | 'telemetry'
  | 'ideation';

export type AutonomousCampaignReleasePolicy = 'auto-merge-after-gates';

export type AutonomousCampaignReasoningEffort =
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh';

export type AutonomousCampaignJsonValue =
  | string
  | number
  | boolean
  | null
  | AutonomousCampaignJsonValue[]
  | { [key: string]: AutonomousCampaignJsonValue };

export interface AutonomousCampaignJsonObject {
  [key: string]: AutonomousCampaignJsonValue;
}

export interface AutonomousCampaignModelSelection {
  model: string;
  reasoningEffort?: AutonomousCampaignReasoningEffort;
}

export interface AutonomousCampaignModelConfig {
  metaAgent?: AutonomousCampaignModelSelection;
  coding?: AutonomousCampaignModelSelection;
  reviewer?: AutonomousCampaignModelSelection;
}

export interface AutonomousCampaign {
  id: string;
  repository: string;
  baseBranch: string;
  status: AutonomousCampaignStatus;
  releasePolicy: AutonomousCampaignReleasePolicy;
  ideaSources: AutonomousCampaignIdeaSource[];
  modelConfig: AutonomousCampaignModelConfig;
  maxTurnsPerAttempt: number;
  maxMinutesPerAttempt: number;
  maxCostUsdPerAttempt: number;
  retryBackoffCapMinutes: number;
  successCooldownMinutes: number;
  failedAttemptAlertThreshold: number;
  cumulativeCostAlertUsd: number;
  cumulativeCostUsd: number;
  nextSequence: number;
  currentCycleId?: string;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  pauseRequestedAt?: string;
  stopRequestedAt?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AutonomousCampaignCycle {
  id: string;
  campaignId: string;
  sequence: number;
  title: string;
  status: AutonomousCampaignCycleStatus;
  proposal?: AutonomousCampaignJsonObject;
  proposalFingerprint?: string;
  baseSha?: string;
  workstreamId?: string;
  taskId?: string;
  branchName?: string;
  pullRequestUrl?: string;
  reviewDecision?: AutonomousCampaignJsonObject;
  releaseGates?: AutonomousCampaignJsonObject;
  mergeSha?: string;
  nextRetryAt?: string;
  retryDelayMinutes?: number;
  startedAt: string;
  completedAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AutonomousCampaignAttempt {
  id: string;
  cycleId: string;
  attemptNumber: number;
  status: AutonomousCampaignAttemptStatus;
  turnsUsed: number;
  elapsedMs: number;
  estimatedCostUsd: number;
  startedAt: string;
  completedAt?: string;
  failureStage?: string;
  failureMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAutonomousCampaignInput {
  repository: string;
  baseBranch: string;
  releasePolicy?: AutonomousCampaignReleasePolicy;
  ideaSources?: AutonomousCampaignIdeaSource[];
  modelConfig?: AutonomousCampaignModelConfig;
  maxTurnsPerAttempt?: number;
  maxMinutesPerAttempt?: number;
  maxCostUsdPerAttempt?: number;
  retryBackoffCapMinutes?: number;
  successCooldownMinutes?: number;
  failedAttemptAlertThreshold?: number;
  cumulativeCostAlertUsd?: number;
  createdBy?: string;
}

export interface CreateAutonomousCampaignCycleInput {
  campaignId: string;
  sequence: number;
  title: string;
  status?: AutonomousCampaignCycleStatus;
  proposal?: AutonomousCampaignJsonObject;
  proposalFingerprint?: string;
  baseSha?: string;
  leaseOwner?: string;
  nowMs?: number;
}

export interface CreateAutonomousCampaignAttemptInput {
  cycleId: string;
  attemptNumber: number;
  status?: AutonomousCampaignAttemptStatus;
  idempotencyKey: string;
  leaseOwner?: string;
  nowMs?: number;
}

export interface TransitionAutonomousCampaignInput {
  campaignId: string;
  expectedStatus: AutonomousCampaignStatus;
  nextStatus: AutonomousCampaignStatus;
  idempotencyKey: string;
  leaseOwner?: string;
  nowMs?: number;
}

export interface AutonomousCampaignTransitionResult {
  applied: boolean;
  campaign: AutonomousCampaign;
}

export interface ClaimAutonomousCampaignLeaseInput {
  campaignId: string;
  owner: string;
  nowMs: number;
  ttlMs: number;
}

export interface AutonomousCampaignLeaseClaimResult {
  claimed: boolean;
  campaign: AutonomousCampaign;
}

export interface ScheduleAutonomousCycleRetryInput {
  cycleId: string;
  previousDelayMinutes: number;
  capMinutes: number;
  leaseOwner?: string;
  nowMs?: number;
}

export interface AutonomousCycleRetryResult {
  delayMinutes: number;
  cycle: AutonomousCampaignCycle;
}

export interface RecordAutonomousAttemptUsageInput {
  attemptId: string;
  usageEventId: string;
  turns: number;
  estimatedCostUsd: number;
}

export interface AutonomousCampaignAttemptLimits {
  maxTurns: number;
  maxElapsedMs: number;
  maxEstimatedCostUsd: number;
}

export interface AutonomousCampaignAttemptUsage {
  turnsUsed: number;
  elapsedMs: number;
  estimatedCostUsd: number;
}

export type AutonomousCampaignBudgetReason = 'turns' | 'time' | 'cost';

export type AutonomousCampaignActionDecision =
  | { allowed: true }
  | { allowed: false; reason: AutonomousCampaignBudgetReason };

export const AUTONOMOUS_CAMPAIGN_CONFLICT_CODE = 'CAMPAIGN_CONFLICT';
export const AUTONOMOUS_CAMPAIGN_NOT_FOUND_CODE = 'CAMPAIGN_NOT_FOUND';
export const AUTONOMOUS_CAMPAIGN_CYCLE_NOT_FOUND_CODE =
  'CAMPAIGN_CYCLE_NOT_FOUND';
export const AUTONOMOUS_CAMPAIGN_ATTEMPT_NOT_FOUND_CODE =
  'CAMPAIGN_ATTEMPT_NOT_FOUND';

export type AutonomousCampaignStoreErrorCode =
  | typeof AUTONOMOUS_CAMPAIGN_CONFLICT_CODE
  | typeof AUTONOMOUS_CAMPAIGN_NOT_FOUND_CODE
  | typeof AUTONOMOUS_CAMPAIGN_CYCLE_NOT_FOUND_CODE
  | typeof AUTONOMOUS_CAMPAIGN_ATTEMPT_NOT_FOUND_CODE;

export const AUTONOMOUS_CAMPAIGN_DEFAULTS = {
  releasePolicy: 'auto-merge-after-gates',
  ideaSources: ['specs', 'code', 'issues', 'telemetry', 'ideation'],
  maxTurnsPerAttempt: 500,
  maxMinutesPerAttempt: 240,
  maxCostUsdPerAttempt: 250,
  retryBackoffCapMinutes: 60,
  successCooldownMinutes: 5,
  failedAttemptAlertThreshold: 3,
  cumulativeCostAlertUsd: 50,
} as const satisfies {
  releasePolicy: AutonomousCampaignReleasePolicy;
  ideaSources: readonly AutonomousCampaignIdeaSource[];
  maxTurnsPerAttempt: number;
  maxMinutesPerAttempt: number;
  maxCostUsdPerAttempt: number;
  retryBackoffCapMinutes: number;
  successCooldownMinutes: number;
  failedAttemptAlertThreshold: number;
  cumulativeCostAlertUsd: number;
};
