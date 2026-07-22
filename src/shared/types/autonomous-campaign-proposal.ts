import type { AutonomousCampaignEvidenceSnapshot } from './autonomous-campaign-evidence.js';
import type { AutonomousCampaignModelConfig } from './autonomous-campaign-state.js';

export type CampaignProposalSize = 'small' | 'medium' | 'large';

export type CampaignProposalRejectionReason =
  | 'duplicate'
  | 'repository-deletion'
  | 'secret-disclosure'
  | 'security-weakening'
  | 'test-weakening'
  | 'irreversible-change'
  | 'untestable'
  | 'oversized'
  | 'unsupported';

export interface CampaignFeatureCandidate {
  id: string;
  title: string;
  problem: string;
  evidence: string[];
  targetUsers: string[];
  userValue: string;
  scope: string[];
  nonGoals: string[];
  acceptanceCriteria: string[];
  affectedComponents: string[];
  likelyTests: string[];
  risks: string[];
  rollback: string;
  size: CampaignProposalSize;
  deletesRepository?: boolean;
  disclosesSecrets?: boolean;
  weakensSecurity?: boolean;
  weakensTests?: boolean;
  reversible?: boolean;
  verifiable?: boolean;
}

export interface CampaignFeatureCandidateSet {
  candidates: CampaignFeatureCandidate[];
}

export type CampaignProposalFingerprintInput = Pick<
  CampaignFeatureCandidate,
  'title' | 'problem' | 'scope'
>;

export interface AcceptedCampaignProposal {
  candidateId: string;
  title: string;
  problem: string;
  evidence: string[];
  targetUsers: string[];
  userValue: string;
  scope: string[];
  nonGoals: string[];
  acceptanceCriteria: string[];
  affectedComponents: string[];
  likelyTests: string[];
  risks: string[];
  rollback: string;
  size: Exclude<CampaignProposalSize, 'large'>;
  fingerprint: string;
  evidenceSnapshotId: string;
  baseSha: string;
}

export interface CampaignProposalRejection {
  candidateId: string;
  reason: CampaignProposalRejectionReason;
}

export interface CampaignProposalHistoryEntry {
  cycleId: string;
  outcome: 'accepted' | 'rejected';
  candidateId: string;
  title: string;
  fingerprint: string;
  candidate: CampaignFeatureCandidate;
  reason?: CampaignProposalRejectionReason;
  recordedAt: string;
}

export interface CampaignProposalResult {
  status: 'accepted' | 'rejected' | 'replayed';
  proposal?: AcceptedCampaignProposal;
  rejections: CampaignProposalRejection[];
  history: CampaignProposalHistoryEntry[];
}

export interface CampaignCandidateGeneratorContext {
  evidenceSnapshot: AutonomousCampaignEvidenceSnapshot;
  baseSha: string;
  modelConfig: AutonomousCampaignModelConfig;
}

export interface CampaignProposalCriticContext {
  candidates: CampaignFeatureCandidate[];
  evidenceSnapshot: AutonomousCampaignEvidenceSnapshot;
  fingerprints: Record<string, string>;
}

export interface CampaignProposalCriticDecision {
  selectedCandidateId?: string;
  rejections?: CampaignProposalRejection[];
}

export interface GenerateAndCritiqueCampaignProposalInput {
  campaignId: string;
  cycleId: string;
  modelConfig: AutonomousCampaignModelConfig;
  knownFingerprints?: string[];
  generateCandidates: (
    context: CampaignCandidateGeneratorContext,
  ) => Promise<CampaignFeatureCandidateSet>;
  critique: (
    context: CampaignProposalCriticContext,
  ) => Promise<CampaignProposalCriticDecision>;
  now?: () => string;
}

export const CAMPAIGN_PROPOSAL_EVIDENCE_REQUIRED =
  'evidence-required' as const;
export const CAMPAIGN_PROPOSAL_INVALID_STRUCTURED_OUTPUT =
  'invalid-structured-output' as const;
export const CAMPAIGN_PROPOSAL_CAMPAIGN_NOT_RUNNING =
  'campaign-not-running' as const;
export const CAMPAIGN_PROPOSAL_CYCLE_NOT_PROPOSING =
  'cycle-not-proposing' as const;
export const CAMPAIGN_PROPOSAL_CAMPAIGN_CYCLE_MISMATCH =
  'campaign-cycle-mismatch' as const;
export const CAMPAIGN_PROPOSAL_CONFLICT = 'proposal-conflict' as const;

export type CampaignProposalErrorCode =
  | typeof CAMPAIGN_PROPOSAL_EVIDENCE_REQUIRED
  | typeof CAMPAIGN_PROPOSAL_INVALID_STRUCTURED_OUTPUT
  | typeof CAMPAIGN_PROPOSAL_CAMPAIGN_NOT_RUNNING
  | typeof CAMPAIGN_PROPOSAL_CYCLE_NOT_PROPOSING
  | typeof CAMPAIGN_PROPOSAL_CAMPAIGN_CYCLE_MISMATCH
  | typeof CAMPAIGN_PROPOSAL_CONFLICT;
