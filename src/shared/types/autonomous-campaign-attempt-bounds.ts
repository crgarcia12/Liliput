import type {
  AutonomousCampaign,
  AutonomousCampaignAttempt,
  AutonomousCampaignBudgetReason,
  AutonomousCampaignCycle,
} from './autonomous-campaign-state.js';

export type AutonomousCampaignAttemptStage =
  | 'agent-turn'
  | 'build'
  | 'image-build'
  | 'deployment'
  | 'validate'
  | 'review';

export interface AutonomousCampaignAttemptLimitSnapshot {
  maxTurns: number;
  maxElapsedMs: number;
  maxEstimatedCostUsd: number;
}

export interface AutonomousCampaignBoundedAttempt
  extends AutonomousCampaignAttempt,
    AutonomousCampaignAttemptLimitSnapshot {
  activeStartedAt?: string;
}

export type AutonomousCampaignAttemptBlockReason =
  | AutonomousCampaignBudgetReason
  | 'paused'
  | 'stopped'
  | 'waiting_for_external'
  | 'retry_wait';

export interface AutonomousCampaignAttemptActionResult {
  allowed: boolean;
  reason?: AutonomousCampaignAttemptBlockReason;
  attempt: AutonomousCampaignBoundedAttempt;
  cycle: AutonomousCampaignCycle;
}

export interface AutonomousCampaignAttemptUsageDelta {
  usageEventId: string;
  turns: number;
  estimatedCostUsd: number;
}

export interface AutonomousCampaignAttemptFailure {
  stage: AutonomousCampaignAttemptStage;
  message: string;
}

export interface AutonomousCampaignAttemptTransitionResult {
  campaign: AutonomousCampaign;
  cycle: AutonomousCampaignCycle;
  attempt: AutonomousCampaignBoundedAttempt;
}

export interface AutonomousCampaignRetryStartResult {
  started: boolean;
  cycle: AutonomousCampaignCycle;
  attempt?: AutonomousCampaignBoundedAttempt;
}

export const AUTONOMOUS_CAMPAIGN_ATTEMPT_NOT_FOUND =
  'campaign-attempt-not-found' as const;
export const AUTONOMOUS_CAMPAIGN_ATTEMPT_LIMIT =
  'campaign-attempt-limit' as const;
export const AUTONOMOUS_CAMPAIGN_ATTEMPT_CONFLICT =
  'campaign-attempt-conflict' as const;
export const INVALID_AUTONOMOUS_CAMPAIGN_ATTEMPT_TRANSITION =
  'invalid-campaign-attempt-transition' as const;

export type AutonomousCampaignAttemptErrorCode =
  | typeof AUTONOMOUS_CAMPAIGN_ATTEMPT_NOT_FOUND
  | typeof AUTONOMOUS_CAMPAIGN_ATTEMPT_LIMIT
  | typeof AUTONOMOUS_CAMPAIGN_ATTEMPT_CONFLICT
  | typeof INVALID_AUTONOMOUS_CAMPAIGN_ATTEMPT_TRANSITION;
