import type {
  AutonomousCampaignIdeaSource,
  AutonomousCampaignJsonObject,
} from './autonomous-campaign-state.js';

export type AutonomousCampaignEvidenceTrust = 'trusted' | 'untrusted';

export type AutonomousCampaignEvidenceSourceStatus =
  | 'success'
  | 'empty'
  | 'error';

export interface AutonomousCampaignEvidenceItem {
  id: string;
  source: AutonomousCampaignIdeaSource;
  label: string;
  content: string;
  trust: AutonomousCampaignEvidenceTrust;
  origin: AutonomousCampaignJsonObject;
}

export interface AutonomousCampaignEvidenceSourceResult {
  source: AutonomousCampaignIdeaSource;
  status: AutonomousCampaignEvidenceSourceStatus;
  items: AutonomousCampaignEvidenceItem[];
  error?: string;
}

export interface AutonomousCampaignEvidenceSnapshot {
  id: string;
  campaignId: string;
  cycleId: string;
  repository: string;
  baseBranch: string;
  baseSha: string;
  sources: AutonomousCampaignEvidenceSourceResult[];
  capturedAt: string;
}
