import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AutonomousCampaign,
  AutonomousCampaignCycle,
  CreateAutonomousCampaignInput,
} from '../../../../shared/types/autonomous-campaign-state.js';
import * as campaignStore from '../../src/stores/autonomous-campaign-store.js';
import * as costStore from '../../src/stores/cost-store.js';
import { closeDb, getDb } from '../../src/stores/db.js';
import * as pricingStore from '../../src/stores/pricing-store.js';
import {
  createTask,
  getTask,
  resetStore,
} from '../../src/stores/task-store.js';
import * as turnStore from '../../src/stores/turn-store.js';

interface CampaignPricingModule {
  createPricedCampaign(
    input: CreateAutonomousCampaignInput,
    options?: { occurredAt?: string; currency?: string },
  ): AutonomousCampaign;
  reconcileCampaignModelPricing(input: {
    campaignId: string;
    occurredAt?: string;
    currency?: string;
    leaseOwner?: string;
    nowMs?: number;
  }): {
    ready: boolean;
    unpricedModels: string[];
    campaign: AutonomousCampaign;
    cycle?: AutonomousCampaignCycle;
  };
}

const campaignPricingModulePath =
  '../../src/engine/autonomous-campaign-pricing.js';
const now = '2026-07-22T00:00:00Z';
let dbPath = '';
let pricing: CampaignPricingModule;

async function loadCampaignPricing(): Promise<CampaignPricingModule> {
  const loaded: unknown = await import(campaignPricingModulePath);
  return loaded as CampaignPricingModule;
}

function insertPrice(model: string): void {
  pricingStore.upsertPrice({
    model,
    inputPerMtok: 1,
    outputPerMtok: 5,
    effectiveFrom: '2026-01-01',
    source: 'verified-test-price',
  });
}

beforeEach(async () => {
  closeDb();
  dbPath = path.join(
    os.tmpdir(),
    `liliput-campaign-pricing-${process.pid}-${randomUUID()}.db`,
  );
  process.env['DB_PATH'] = dbPath;
  resetStore();
  campaignStore.resetAutonomousCampaignStore();
  getDb().exec('DELETE FROM model_pricing; DELETE FROM turn_usage_call;');
  pricing = await loadCampaignPricing();
});

afterEach(() => {
  closeDb();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  process.env['DB_PATH'] = ':memory:';
});

describe('autonomous campaign model pricing', () => {
  it('should reject campaign creation when a selected model has no effective price', () => {
    let thrown: unknown;

    try {
      pricing.createPricedCampaign(
        {
          repository: 'crgarcia12/liliput',
          baseBranch: 'main',
          modelConfig: {
            metaAgent: { model: 'unpriced-campaign-model' },
          },
        },
        { occurredAt: now },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: 'CAMPAIGN_MODEL_UNPRICED',
      unpricedModels: ['unpriced-campaign-model'],
    });
    const count = getDb()
      .prepare('SELECT COUNT(*) AS count FROM autonomous_campaigns')
      .get() as { count: number };
    expect(count.count).toBe(0);
  });

  it('should make a model eligible after verified pricing is recorded', () => {
    insertPrice('newly-priced-campaign-model');

    const campaign = pricing.createPricedCampaign(
      {
        repository: 'crgarcia12/liliput',
        baseBranch: 'main',
        modelConfig: {
          coding: { model: 'newly-priced-campaign-model' },
        },
      },
      { occurredAt: now },
    );

    expect(campaign.modelConfig.coding?.model).toBe(
      'newly-priced-campaign-model',
    );
  });

  it('should wait before a model turn and resume the same cycle when pricing returns', () => {
    const model = 'recoverable-campaign-model';
    insertPrice(model);
    const created = pricing.createPricedCampaign(
      {
        repository: 'crgarcia12/liliput',
        baseBranch: 'main',
        modelConfig: { metaAgent: { model } },
      },
      { occurredAt: now },
    );
    campaignStore.transitionCampaign({
      campaignId: created.id,
      expectedStatus: 'draft',
      nextStatus: 'running',
      idempotencyKey: `${created.id}-start`,
    });
    const cycle = campaignStore.createCycle({
      campaignId: created.id,
      sequence: 1,
      title: 'Add campaign health history',
      status: 'proposing',
    });
    for (const price of pricingStore.listPrices({ model })) {
      pricingStore.deletePrice(price.id);
    }

    const waiting = pricing.reconcileCampaignModelPricing({
      campaignId: created.id,
      occurredAt: now,
    });

    expect(waiting.ready).toBe(false);
    expect(waiting.unpricedModels).toEqual([model]);
    expect(waiting.cycle).toMatchObject({
      id: cycle.id,
      status: 'waiting_for_external',
    });
    expect(campaignStore.listAttempts(cycle.id)).toHaveLength(0);
    expect(waiting.campaign.cumulativeCostUsd).toBe(0);

    insertPrice(model);
    const resumed = pricing.reconcileCampaignModelPricing({
      campaignId: created.id,
      occurredAt: now,
    });

    expect(resumed.ready).toBe(true);
    expect(resumed.unpricedModels).toEqual([]);
    expect(resumed.cycle).toMatchObject({
      id: cycle.id,
      status: 'proposing',
    });
  });

  it('should preserve manual task behavior for an unpriced model', () => {
    const model = 'manual-unpriced-model';
    const task = createTask(
      'Manual investigation',
      'Inspect the repository without autonomous campaign coordination.',
      'crgarcia12/liliput',
      { model },
    );
    const turn = turnStore.getCurrentTurn(task.id);
    expect(turn).toBeDefined();
    turnStore.recordUsage(turn!.id, {
      model,
      inputTokens: 1_000,
      outputTokens: 500,
    });

    expect(getTask(task.id)?.model).toBe(model);
    expect(costStore.costForTask(task.id)).toMatchObject({
      estimatedCost: 0,
      pricedCalls: 0,
      unpricedCalls: 1,
    });
  });
});
