import type {
  AutonomousCampaign,
  AutonomousCampaignAttempt,
  AutonomousCampaignCycle,
  CreateAutonomousCampaignInput,
} from './autonomous-campaign-state.js';

export type AutonomousCampaignAction = 'start' | 'pause' | 'resume' | 'stop';

export type AutonomousCampaignEventAction =
  | 'created'
  | 'started'
  | 'paused'
  | 'resumed'
  | 'stopped'
  | 'cycle-transitioned'
  | 'budget-updated'
  | 'attempt-updated'
  | 'waiting-reason-updated';

export type AutonomousCampaignApiErrorCode =
  | 'ADMIN_REQUIRED'
  | 'CAMPAIGN_VALIDATION_FAILED'
  | 'CAMPAIGN_BRANCH_INACCESSIBLE'
  | 'CAMPAIGN_MODEL_UNPRICED'
  | 'ACTIVE_CAMPAIGN_EXISTS'
  | 'CAMPAIGN_NOT_FOUND'
  | 'INVALID_CAMPAIGN_ACTION'
  | 'CAMPAIGN_CONTROL_FAILED';

export interface CreateAutonomousCampaignRequest
  extends CreateAutonomousCampaignInput {}

export interface CreateAutonomousCampaignResponse {
  campaign: AutonomousCampaign;
}

export interface AutonomousCampaignListResponse {
  campaigns: AutonomousCampaign[];
}

export interface AutonomousCampaignWithUsage extends AutonomousCampaign {
  cumulativeTurns: number;
}

export interface AutonomousCampaignDetailResponse {
  campaign: AutonomousCampaignWithUsage;
  cycle: AutonomousCampaignCycle | null;
  attempts: AutonomousCampaignAttempt[];
  allowedActions: AutonomousCampaignAction[];
}

export interface AutonomousCampaignApiError {
  error: string;
  code: AutonomousCampaignApiErrorCode;
  field?: string;
  unpricedModels?: string[];
}

export interface AutonomousCampaignEvent {
  action: AutonomousCampaignEventAction;
  campaign: AutonomousCampaign;
  cycle?: AutonomousCampaignCycle | null;
  attempt?: AutonomousCampaignAttempt;
  waitingReason?: string;
  occurredAt: string;
}

export type VerifyCampaignRepositoryBranchResult =
  | { ok: true }
  | { ok: false; status: number; reason: string };
