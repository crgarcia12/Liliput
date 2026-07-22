import type {
  AutonomousCampaign,
  AutonomousCampaignCycle,
  CreateAutonomousCampaignInput,
} from './autonomous-campaign-state.js';

export const AUTONOMOUS_CAMPAIGN_MODEL_UNPRICED_CODE =
  'CAMPAIGN_MODEL_UNPRICED';

export interface AutonomousCampaignPricingOptions {
  occurredAt?: string;
  currency?: string;
}

export interface CreatePricedAutonomousCampaignInput {
  campaign: CreateAutonomousCampaignInput;
  options?: AutonomousCampaignPricingOptions;
}

export interface ReconcileAutonomousCampaignPricingInput
  extends AutonomousCampaignPricingOptions {
  campaignId: string;
  leaseOwner?: string;
  nowMs?: number;
}

export interface ReconcileAutonomousCampaignPricingResult {
  ready: boolean;
  unpricedModels: string[];
  campaign: AutonomousCampaign;
  cycle?: AutonomousCampaignCycle;
}

export interface AutonomousCampaignPricingErrorBody {
  error: string;
  code: typeof AUTONOMOUS_CAMPAIGN_MODEL_UNPRICED_CODE;
  unpricedModels: string[];
}

export interface UpsertModelPriceRequest {
  model: string;
  tier?: string;
  minInputTokens?: number;
  currency?: string;
  inputPerMtok: number;
  cachedInputPerMtok?: number | null;
  cacheWritePerMtok?: number | null;
  outputPerMtok: number;
  effectiveFrom: string;
  source?: string | null;
  notes?: string | null;
}
