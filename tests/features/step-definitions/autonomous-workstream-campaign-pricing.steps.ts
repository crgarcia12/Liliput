import { After, Given, Then, When } from '@cucumber/cucumber';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AutonomousCampaign,
  AutonomousCampaignCycle,
  CreateAutonomousCampaignInput,
} from '../../../src/shared/types/autonomous-campaign-state';
import * as campaignStore from '../../../src/api/src/stores/autonomous-campaign-store';
import * as costStore from '../../../src/api/src/stores/cost-store';
import { closeDb, getDb } from '../../../src/api/src/stores/db';
import * as pricingStore from '../../../src/api/src/stores/pricing-store';
import {
  createTask,
  getTask,
  resetStore,
} from '../../../src/api/src/stores/task-store';
import * as turnStore from '../../../src/api/src/stores/turn-store';
import type { CustomWorld } from '../support/world';

interface CampaignPricingModule {
  createPricedCampaign(
    input: CreateAutonomousCampaignInput,
    options?: { occurredAt?: string; currency?: string },
  ): AutonomousCampaign;
  reconcileCampaignModelPricing(input: {
    campaignId: string;
    occurredAt?: string;
    currency?: string;
  }): {
    ready: boolean;
    unpricedModels: string[];
    campaign: AutonomousCampaign;
    cycle?: AutonomousCampaignCycle;
  };
}

interface PricingScenarioState {
  dbPath: string;
  pricing: CampaignPricingModule;
  model?: string;
  validationError?: unknown;
  campaignId?: string;
  cycleId?: string;
  reconciliation?: ReturnType<
    CampaignPricingModule['reconcileCampaignModelPricing']
  >;
  taskId?: string;
}

const states = new WeakMap<CustomWorld, PricingScenarioState>();
const campaignPricingModulePath =
  '../../../src/api/src/engine/autonomous-campaign-pricing';
const occurredAt = '2026-07-22T00:00:00Z';

async function stateFor(world: CustomWorld): Promise<PricingScenarioState> {
  const existing = states.get(world);
  if (existing) return existing;

  closeDb();
  const dbPath = path.join(
    os.tmpdir(),
    `liliput-campaign-pricing-bdd-${process.pid}-${randomUUID()}.db`,
  );
  process.env['DB_PATH'] = dbPath;
  resetStore();
  campaignStore.resetAutonomousCampaignStore();
  getDb().exec('DELETE FROM model_pricing; DELETE FROM turn_usage_call;');
  const loaded: unknown = await import(campaignPricingModulePath);
  const state: PricingScenarioState = {
    dbPath,
    pricing: loaded as CampaignPricingModule,
  };
  states.set(world, state);
  return state;
}

function deleteModelPricing(model: string): void {
  for (const price of pricingStore.listPrices({ model })) {
    pricingStore.deletePrice(price.id);
  }
}

function recordModelPricing(model: string): void {
  pricingStore.upsertPrice({
    model,
    inputPerMtok: 1,
    outputPerMtok: 5,
    effectiveFrom: '2026-01-01',
    source: 'verified-bdd-price',
  });
}

After({ tags: '@ext-pre-002' }, async function (this: CustomWorld) {
  const state = states.get(this);
  closeDb();
  if (state?.dbPath) {
    fs.rmSync(state.dbPath, { force: true });
    fs.rmSync(`${state.dbPath}-shm`, { force: true });
    fs.rmSync(`${state.dbPath}-wal`, { force: true });
  }
  process.env['DB_PATH'] = ':memory:';
  states.delete(this);
});

Given(
  'model {string} has no effective USD pricing',
  async function (this: CustomWorld, model: string) {
    const state = await stateFor(this);
    deleteModelPricing(model);
    state.model = model;
    assert.equal(
      pricingStore.getEffectivePrice(model, occurredAt, 0),
      undefined,
    );
  },
);

When(
  'an administrator validates an autonomous campaign using model {string}',
  async function (this: CustomWorld, model: string) {
    const state = await stateFor(this);
    try {
      const campaign = state.pricing.createPricedCampaign(
        {
          repository: 'crgarcia12/liliput',
          baseBranch: 'main',
          modelConfig: { metaAgent: { model } },
          createdBy: 'admin@example.com',
        },
        { occurredAt },
      );
      state.campaignId = campaign.id;
    } catch (error) {
      state.validationError = error;
    }
  },
);

Then(
  'campaign validation should reject model {string} as unpriced',
  async function (this: CustomWorld, model: string) {
    const state = await stateFor(this);
    assert.ok(state.validationError instanceof Error);
    assert.equal(
      (state.validationError as Error & { code?: string }).code,
      'CAMPAIGN_MODEL_UNPRICED',
    );
    assert.deepEqual(
      (
        state.validationError as Error & { unpricedModels?: string[] }
      ).unpricedModels,
      [model],
    );
  },
);

Then(
  'no autonomous campaign should be created',
  async function (this: CustomWorld) {
    await stateFor(this);
    const row = getDb()
      .prepare('SELECT COUNT(*) AS count FROM autonomous_campaigns')
      .get() as { count: number };
    assert.equal(row.count, 0);
  },
);

Given(
  'an autonomous campaign cycle uses model {string}',
  async function (this: CustomWorld, model: string) {
    const state = await stateFor(this);
    recordModelPricing(model);
    const campaign = state.pricing.createPricedCampaign(
      {
        repository: 'crgarcia12/liliput',
        baseBranch: 'main',
        modelConfig: { metaAgent: { model } },
      },
      { occurredAt },
    );
    campaignStore.transitionCampaign({
      campaignId: campaign.id,
      expectedStatus: 'draft',
      nextStatus: 'running',
      idempotencyKey: `${campaign.id}-start`,
    });
    const cycle = campaignStore.createCycle({
      campaignId: campaign.id,
      sequence: 1,
      title: 'Add campaign health history',
      status: 'proposing',
    });
    state.model = model;
    state.campaignId = campaign.id;
    state.cycleId = cycle.id;
  },
);

When(
  'the coordinator checks pricing before the next model turn',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    assert.ok(state.campaignId);
    state.reconciliation = state.pricing.reconcileCampaignModelPricing({
      campaignId: state.campaignId,
      occurredAt,
    });
  },
);

Then(
  'the cycle should wait for external model pricing',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    assert.equal(state.reconciliation?.ready, false);
    assert.deepEqual(state.reconciliation?.unpricedModels, [state.model]);
    assert.equal(state.reconciliation?.cycle?.id, state.cycleId);
    assert.equal(
      state.reconciliation?.cycle?.status,
      'waiting_for_external',
    );
  },
);

Then(
  'the pricing wait should consume no model turns or estimated cost',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    assert.ok(state.cycleId);
    assert.equal(campaignStore.listAttempts(state.cycleId).length, 0);
    assert.equal(state.reconciliation?.campaign.cumulativeCostUsd, 0);
  },
);

When(
  'an operator records effective USD pricing for model {string}',
  async function (this: CustomWorld, model: string) {
    await stateFor(this);
    recordModelPricing(model);
    assert.ok(pricingStore.getEffectivePrice(model, occurredAt, 0));
  },
);

Then(
  'the same cycle should resume running',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    assert.equal(state.reconciliation?.ready, true);
    assert.deepEqual(state.reconciliation?.unpricedModels, []);
    assert.equal(state.reconciliation?.cycle?.id, state.cycleId);
    assert.equal(state.reconciliation?.cycle?.status, 'proposing');
  },
);

When(
  'a manually created task selects model {string}',
  async function (this: CustomWorld, model: string) {
    const state = await stateFor(this);
    const task = createTask(
      'Manual investigation',
      'Inspect the repository without autonomous campaign coordination.',
      'crgarcia12/liliput',
      { model },
    );
    const turn = turnStore.getCurrentTurn(task.id);
    assert.ok(turn);
    turnStore.recordUsage(turn.id, {
      model,
      inputTokens: 1_000,
      outputTokens: 500,
    });
    state.model = model;
    state.taskId = task.id;
  },
);

Then(
  'the manual task should retain model {string}',
  async function (this: CustomWorld, model: string) {
    const state = await stateFor(this);
    assert.ok(state.taskId);
    assert.equal(getTask(state.taskId)?.model, model);
  },
);

Then(
  'its usage should be reported as unpriced rather than zero-cost',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    assert.ok(state.taskId);
    const cost = costStore.costForTask(state.taskId);
    assert.equal(cost.unpricedCalls, 1);
    assert.equal(cost.pricedCalls, 0);
    assert.equal(cost.estimatedCost, 0);
  },
);
