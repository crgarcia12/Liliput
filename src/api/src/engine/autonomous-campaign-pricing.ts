import {
  AUTONOMOUS_CAMPAIGN_MODEL_UNPRICED_CODE,
  type AutonomousCampaignPricingOptions,
  type ReconcileAutonomousCampaignPricingInput,
  type ReconcileAutonomousCampaignPricingResult,
} from '../../../shared/types/autonomous-campaign-pricing.js';
import type {
  AutonomousCampaign,
  AutonomousCampaignCycleStatus,
  AutonomousCampaignModelConfig,
  CreateAutonomousCampaignInput,
} from '../../../shared/types/autonomous-campaign-state.js';
import { AUTONOMOUS_CAMPAIGN_NOT_FOUND_CODE } from '../../../shared/types/autonomous-campaign-state.js';
import {
  AutonomousCampaignConflictError,
  AutonomousCampaignStoreError,
  createCampaign,
  getCampaign,
  getCurrentCycle,
} from '../stores/autonomous-campaign-store.js';
import { getDb } from '../stores/db.js';
import { getEffectivePrice } from '../stores/pricing-store.js';

const PRICING_WAIT_PREFIX = 'waiting_for_external:model_pricing:';
const RESTORABLE_CYCLE_STATUSES = new Set<AutonomousCampaignCycleStatus>([
  'proposing',
  'delivering',
  'retry_wait',
]);

interface CampaignLeaseRow {
  id: string;
  current_cycle_id: string | null;
  lease_owner: string | null;
  lease_expires_at: number | null;
}

interface CyclePricingRow {
  id: string;
  status: AutonomousCampaignCycleStatus;
  last_error: string | null;
}

export class AutonomousCampaignPricingError extends Error {
  readonly code = AUTONOMOUS_CAMPAIGN_MODEL_UNPRICED_CODE;

  constructor(readonly unpricedModels: string[]) {
    super(
      `Autonomous campaign models require effective pricing: ${unpricedModels.join(', ')}`,
    );
    this.name = 'AutonomousCampaignPricingError';
  }
}

function configuredModels(modelConfig: AutonomousCampaignModelConfig): string[] {
  return Array.from(
    new Set(
      [modelConfig.metaAgent, modelConfig.coding, modelConfig.reviewer]
        .map((selection) => selection?.model.trim())
        .filter((model): model is string => Boolean(model)),
    ),
  ).sort();
}

function unpricedModels(
  modelConfig: AutonomousCampaignModelConfig,
  occurredAt: string,
  currency: string,
): string[] {
  return configuredModels(modelConfig).filter(
    (model) => !getEffectivePrice(model, occurredAt, 0, currency),
  );
}

function assertLeaseOwner(
  campaign: CampaignLeaseRow,
  leaseOwner: string | undefined,
  nowMs: number,
): void {
  if (
    campaign.lease_owner &&
    campaign.lease_expires_at !== null &&
    campaign.lease_expires_at > nowMs &&
    campaign.lease_owner !== leaseOwner
  ) {
    throw new AutonomousCampaignConflictError(
      `Campaign ${campaign.id} is leased by ${campaign.lease_owner}`,
    );
  }
}

function pricingWaitMarker(
  previousStatus: AutonomousCampaignCycleStatus,
  missingModels: string[],
): string {
  return `${PRICING_WAIT_PREFIX}${previousStatus}:${missingModels
    .map(encodeURIComponent)
    .join(',')}`;
}

function pricingWaitPreviousStatus(
  lastError: string | null,
): AutonomousCampaignCycleStatus | undefined {
  if (!lastError?.startsWith(PRICING_WAIT_PREFIX)) return undefined;
  const separator = lastError.indexOf(':', PRICING_WAIT_PREFIX.length);
  const status =
    separator === -1
      ? lastError.slice(PRICING_WAIT_PREFIX.length)
      : lastError.slice(PRICING_WAIT_PREFIX.length, separator);
  return RESTORABLE_CYCLE_STATUSES.has(status as AutonomousCampaignCycleStatus)
    ? (status as AutonomousCampaignCycleStatus)
    : undefined;
}

export function createPricedCampaign(
  input: CreateAutonomousCampaignInput,
  options: AutonomousCampaignPricingOptions = {},
): AutonomousCampaign {
  const occurredAt = options.occurredAt ?? new Date().toISOString();
  const currency = options.currency ?? 'USD';
  const db = getDb();
  const create = db.transaction(() => {
    const missingModels = unpricedModels(
      input.modelConfig ?? {},
      occurredAt,
      currency,
    );
    if (missingModels.length > 0) {
      throw new AutonomousCampaignPricingError(missingModels);
    }
    return createCampaign(input);
  });
  return create.immediate();
}

export function reconcileCampaignModelPricing(
  input: ReconcileAutonomousCampaignPricingInput,
): ReconcileAutonomousCampaignPricingResult {
  const initialCampaign = getCampaign(input.campaignId);
  if (!initialCampaign) {
    throw new AutonomousCampaignStoreError(
      `Campaign ${input.campaignId} does not exist`,
      AUTONOMOUS_CAMPAIGN_NOT_FOUND_CODE,
    );
  }

  const nowMs = input.nowMs ?? Date.now();
  const occurredAt = input.occurredAt ?? new Date(nowMs).toISOString();
  const currency = input.currency ?? 'USD';
  const missingModels = unpricedModels(
    initialCampaign.modelConfig,
    occurredAt,
    currency,
  );
  const db = getDb();

  if (initialCampaign.currentCycleId) {
    const reconcile = db.transaction(() => {
      const campaign = db
        .prepare(
          `SELECT id, current_cycle_id, lease_owner, lease_expires_at
             FROM autonomous_campaigns
            WHERE id = ?`,
        )
        .get(input.campaignId) as CampaignLeaseRow | undefined;
      if (!campaign) {
        throw new AutonomousCampaignStoreError(
          `Campaign ${input.campaignId} does not exist`,
          AUTONOMOUS_CAMPAIGN_NOT_FOUND_CODE,
        );
      }
      assertLeaseOwner(campaign, input.leaseOwner, nowMs);
      if (!campaign.current_cycle_id) return;

      const cycle = db
        .prepare(
          `SELECT id, status, last_error
             FROM autonomous_cycles
            WHERE id = ?`,
        )
        .get(campaign.current_cycle_id) as CyclePricingRow | undefined;
      if (!cycle) return;

      const updatedAt = new Date(nowMs).toISOString();
      const previousPricingStatus = pricingWaitPreviousStatus(cycle.last_error);

      if (missingModels.length > 0) {
        if (
          cycle.status !== 'waiting_for_external' &&
          RESTORABLE_CYCLE_STATUSES.has(cycle.status)
        ) {
          db.prepare(
            `UPDATE autonomous_cycles
                SET status = 'waiting_for_external',
                    last_error = ?,
                    updated_at = ?
              WHERE id = ?`,
          ).run(
            pricingWaitMarker(cycle.status, missingModels),
            updatedAt,
            cycle.id,
          );
        } else if (
          cycle.status === 'waiting_for_external' &&
          previousPricingStatus
        ) {
          db.prepare(
            `UPDATE autonomous_cycles
                SET last_error = ?,
                    updated_at = ?
              WHERE id = ?`,
          ).run(
            pricingWaitMarker(previousPricingStatus, missingModels),
            updatedAt,
            cycle.id,
          );
        }
      } else if (
        cycle.status === 'waiting_for_external' &&
        previousPricingStatus
      ) {
        db.prepare(
          `UPDATE autonomous_cycles
              SET status = ?,
                  last_error = NULL,
                  updated_at = ?
            WHERE id = ?`,
        ).run(previousPricingStatus, updatedAt, cycle.id);
      }
    });
    reconcile.immediate();
  }

  const campaign = getCampaign(input.campaignId);
  if (!campaign) {
    throw new AutonomousCampaignStoreError(
      `Campaign ${input.campaignId} does not exist`,
      AUTONOMOUS_CAMPAIGN_NOT_FOUND_CODE,
    );
  }
  const cycle = getCurrentCycle(input.campaignId);
  return {
    ready:
      missingModels.length === 0 &&
      cycle?.status !== 'waiting_for_external',
    unpricedModels: missingModels,
    campaign,
    ...(cycle ? { cycle } : {}),
  };
}
