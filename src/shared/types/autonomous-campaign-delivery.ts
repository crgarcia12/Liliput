import type { AutonomousCampaignCycleStatus } from './autonomous-campaign-state.js';

export type AutonomousCampaignDeliveryOutcome =
  | 'active'
  | 'ready-to-release'
  | 'failed'
  | 'awaiting-merge-confirmation'
  | 'cooldown';

export interface AutonomousCampaignDeliveryResourceIds {
  workstreamId?: string;
  taskId?: string;
  branchName?: string;
  imageRef?: string;
  previewNamespace?: string;
  previewUrl?: string;
  pullRequestUrl?: string;
  pullRequestNumber?: number;
}

export interface AutonomousCampaignDeliveryCheckpoint
  extends AutonomousCampaignDeliveryResourceIds {
  campaignId: string;
  cycleId: string;
  cycleStatus: AutonomousCampaignCycleStatus;
  lastError?: string;
}

export interface AutonomousCampaignDeliveryHandoffResult {
  campaignId: string;
  cycleId: string;
  workstreamId: string;
  taskId: string;
  replayed: boolean;
  pipelineStarted: boolean;
}

export interface AutonomousCampaignDeliveryReconciliation {
  outcome: AutonomousCampaignDeliveryOutcome;
  checkpoint: AutonomousCampaignDeliveryCheckpoint;
}

export type AutonomousCampaignCoordinatorTickOutcome =
  | 'idle'
  | 'handed-off'
  | AutonomousCampaignDeliveryOutcome;

export interface AutonomousCampaignCoordinatorTickResult {
  outcome: AutonomousCampaignCoordinatorTickOutcome;
  campaignId?: string;
  cycleId?: string;
  taskId?: string;
}

export const AUTONOMOUS_CAMPAIGN_PROPOSAL_REQUIRED =
  'campaign-proposal-required' as const;
export const AUTONOMOUS_CAMPAIGN_CYCLE_MISMATCH =
  'campaign-cycle-mismatch' as const;
export const AUTONOMOUS_CAMPAIGN_NOT_RUNNING =
  'campaign-not-running' as const;
export const AUTONOMOUS_CAMPAIGN_DELIVERY_CONFLICT =
  'campaign-delivery-conflict' as const;
export const AUTONOMOUS_CAMPAIGN_TASK_NOT_FOUND =
  'campaign-task-not-found' as const;

export type AutonomousCampaignDeliveryErrorCode =
  | typeof AUTONOMOUS_CAMPAIGN_PROPOSAL_REQUIRED
  | typeof AUTONOMOUS_CAMPAIGN_CYCLE_MISMATCH
  | typeof AUTONOMOUS_CAMPAIGN_NOT_RUNNING
  | typeof AUTONOMOUS_CAMPAIGN_DELIVERY_CONFLICT
  | typeof AUTONOMOUS_CAMPAIGN_TASK_NOT_FOUND;
