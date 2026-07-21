import { After, Given, Then, When } from '@cucumber/cucumber';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb } from '../../../src/api/src/stores/db';
import {
  createTask,
  getTask,
  resetStore,
} from '../../../src/api/src/stores/task-store';
import {
  createWorkstream,
  getWorkstream,
} from '../../../src/api/src/stores/workstream-store';
import type { CustomWorld } from '../support/world';

type CampaignStatus = 'draft' | 'running' | 'paused' | 'stopped';
type CycleStatus = 'proposing' | 'retry_wait';
type AttemptStatus = 'running' | 'retry_wait';

interface CampaignRecord {
  id: string;
  repository: string;
  baseBranch: string;
  status: CampaignStatus;
  currentCycleId?: string;
  leaseOwner?: string;
  leaseExpiresAt?: number;
}

interface CycleRecord {
  id: string;
  campaignId: string;
  sequence: number;
  title: string;
  status: CycleStatus;
}

interface AttemptRecord {
  id: string;
  cycleId: string;
  attemptNumber: number;
  status: AttemptStatus;
  turnsUsed: number;
  estimatedCostUsd: number;
}

interface CampaignStoreModule {
  resetAutonomousCampaignStore(): void;
  createCampaign(input: {
    repository: string;
    baseBranch: string;
  }): CampaignRecord;
  getCampaign(id: string): CampaignRecord | undefined;
  createCycle(input: {
    campaignId: string;
    sequence: number;
    title: string;
    status?: CycleStatus;
  }): CycleRecord;
  getCycle(id: string): CycleRecord | undefined;
  getCurrentCycle(campaignId: string): CycleRecord | undefined;
  createAttempt(input: {
    cycleId: string;
    attemptNumber: number;
    status?: AttemptStatus;
    idempotencyKey: string;
  }): AttemptRecord;
  getAttempt(id: string): AttemptRecord | undefined;
  listAttempts(cycleId: string): AttemptRecord[];
  transitionCampaign(input: {
    campaignId: string;
    expectedStatus: CampaignStatus;
    nextStatus: CampaignStatus;
    idempotencyKey: string;
  }): { applied: boolean; campaign: CampaignRecord };
  claimCampaignLease(input: {
    campaignId: string;
    owner: string;
    nowMs: number;
    ttlMs: number;
  }): { claimed: boolean; campaign: CampaignRecord };
  scheduleCycleRetry(input: {
    cycleId: string;
    previousDelayMinutes: number;
    capMinutes: number;
  }): { delayMinutes: number; cycle: CycleRecord };
  recordAttemptUsage(input: {
    attemptId: string;
    usageEventId: string;
    turns: number;
    estimatedCostUsd: number;
  }): AttemptRecord;
}

interface ScenarioState {
  dbPath: string;
  store: CampaignStoreModule;
  campaignId?: string;
  cycleId?: string;
  attemptId?: string;
  originalCampaignId?: string;
  replacementCampaignId?: string;
  firstClaim?: boolean;
  secondClaim?: boolean;
  claimNowMs?: number;
  lastError?: unknown;
  idempotencyKey?: string;
  replayedAttemptId?: string;
  transitionApplied?: boolean;
  retryDelayMinutes?: number;
  retryCapMinutes?: number;
  usageBeforeReplay?: AttemptRecord;
  usageAfterReplay?: AttemptRecord;
  manualWorkstreamId?: string;
  manualTaskId?: string;
}

const scenarioStates = new WeakMap<CustomWorld, ScenarioState>();
const campaignStoreModulePath =
  '../../../src/api/src/stores/autonomous-campaign-store';

function isConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as Error & { code?: unknown }).code === 'CAMPAIGN_CONFLICT'
  );
}

async function loadCampaignStore(): Promise<CampaignStoreModule> {
  const loaded: unknown = await import(campaignStoreModulePath);
  return loaded as CampaignStoreModule;
}

async function stateFor(world: CustomWorld): Promise<ScenarioState> {
  const existing = scenarioStates.get(world);
  if (existing) return existing;

  closeDb();
  const dbPath = path.join(
    os.tmpdir(),
    `liliput-autonomous-campaign-bdd-${process.pid}-${randomUUID()}.db`,
  );
  process.env['DB_PATH'] = dbPath;
  const store = await loadCampaignStore();
  resetStore();
  store.resetAutonomousCampaignStore();
  const state: ScenarioState = { dbPath, store };
  scenarioStates.set(world, state);
  return state;
}

function transition(
  state: ScenarioState,
  expectedStatus: CampaignStatus,
  nextStatus: CampaignStatus,
  suffix: string,
): CampaignRecord {
  assert.ok(state.campaignId, 'campaign must exist');
  const result = state.store.transitionCampaign({
    campaignId: state.campaignId,
    expectedStatus,
    nextStatus,
    idempotencyKey: `${state.campaignId}-${suffix}`,
  });
  assert.equal(result.applied, true);
  return result.campaign;
}

After({ tags: '@ext-pre-001' }, async function (this: CustomWorld) {
  const state = scenarioStates.get(this);
  closeDb();
  if (state?.dbPath) {
    fs.rmSync(state.dbPath, { force: true });
    fs.rmSync(`${state.dbPath}-shm`, { force: true });
    fs.rmSync(`${state.dbPath}-wal`, { force: true });
  }
  scenarioStates.delete(this);
});

Given(
  'an autonomous campaign for repository {string} on branch {string}',
  async function (this: CustomWorld, repository: string, baseBranch: string) {
    const state = await stateFor(this);
    const campaign = state.store.createCampaign({ repository, baseBranch });
    state.campaignId = campaign.id;
    transition(state, 'draft', 'running', 'start');
  },
);

Given(
  'the campaign is running feature cycle {int} for {string}',
  async function (this: CustomWorld, sequence: number, title: string) {
    const state = await stateFor(this);
    assert.ok(state.campaignId, 'campaign must exist');
    const cycle = state.store.createCycle({
      campaignId: state.campaignId,
      sequence,
      title,
      status: 'proposing',
    });
    state.cycleId = cycle.id;
  },
);

Given(
  'delivery attempt {int} is waiting to retry',
  async function (this: CustomWorld, attemptNumber: number) {
    const state = await stateFor(this);
    assert.ok(state.cycleId, 'cycle must exist');
    const attempt = state.store.createAttempt({
      cycleId: state.cycleId,
      attemptNumber,
      status: 'retry_wait',
      idempotencyKey: `${state.cycleId}-attempt-${attemptNumber}`,
    });
    state.attemptId = attempt.id;
  },
);

When('the Liliput control plane restarts', async function (this: CustomWorld) {
  const state = await stateFor(this);
  closeDb();
  state.store = await loadCampaignStore();
});

Then(
  'the campaign should still be running feature cycle {int}',
  async function (this: CustomWorld, sequence: number) {
    const state = await stateFor(this);
    assert.ok(state.campaignId, 'campaign must exist');
    const campaign = state.store.getCampaign(state.campaignId);
    const cycle = state.store.getCurrentCycle(state.campaignId);
    assert.equal(campaign?.status, 'running');
    assert.equal(cycle?.sequence, sequence);
  },
);

Then(
  'the accepted feature should still be {string}',
  async function (this: CustomWorld, title: string) {
    const state = await stateFor(this);
    assert.ok(state.campaignId, 'campaign must exist');
    assert.equal(state.store.getCurrentCycle(state.campaignId)?.title, title);
  },
);

Then(
  'delivery attempt {int} should still be waiting to retry',
  async function (this: CustomWorld, attemptNumber: number) {
    const state = await stateFor(this);
    assert.ok(state.cycleId, 'cycle must exist');
    const attempt = state.store
      .listAttempts(state.cycleId)
      .find((candidate) => candidate.attemptNumber === attemptNumber);
    assert.equal(attempt?.status, 'retry_wait');
  },
);

Given(
  'a runnable autonomous campaign with no current coordinator',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    const campaign = state.store.createCampaign({
      repository: 'crgarcia12/liliput',
      baseBranch: 'main',
    });
    state.campaignId = campaign.id;
    transition(state, 'draft', 'running', 'start');
    assert.equal(state.store.getCampaign(campaign.id)?.leaseOwner, undefined);
  },
);

When(
  'coordinator {string} claims the campaign',
  async function (this: CustomWorld, owner: string) {
    const state = await stateFor(this);
    assert.ok(state.campaignId, 'campaign must exist');
    const result = state.store.claimCampaignLease({
      campaignId: state.campaignId,
      owner,
      nowMs: state.claimNowMs ?? 1_000,
      ttlMs: 60_000,
    });
    state.firstClaim = result.claimed;
  },
);

When(
  'coordinator {string} tries to claim it before the lease expires',
  async function (this: CustomWorld, owner: string) {
    const state = await stateFor(this);
    assert.ok(state.campaignId, 'campaign must exist');
    const result = state.store.claimCampaignLease({
      campaignId: state.campaignId,
      owner,
      nowMs: 30_000,
      ttlMs: 60_000,
    });
    state.secondClaim = result.claimed;
  },
);

Then(
  'coordinator {string} should remain the campaign owner',
  async function (this: CustomWorld, owner: string) {
    const state = await stateFor(this);
    assert.equal(state.firstClaim, true);
    assert.equal(state.store.getCampaign(state.campaignId!)?.leaseOwner, owner);
  },
);

Then(
  'coordinator {string} should not be allowed to advance the campaign',
  async function (this: CustomWorld, owner: string) {
    const state = await stateFor(this);
    assert.equal(state.secondClaim, false);
    assert.notEqual(state.store.getCampaign(state.campaignId!)?.leaseOwner, owner);
  },
);

Given(
  'coordinator {string} owns a campaign lease that has expired',
  async function (this: CustomWorld, owner: string) {
    const state = await stateFor(this);
    const campaign = state.store.createCampaign({
      repository: 'crgarcia12/liliput',
      baseBranch: 'main',
    });
    state.campaignId = campaign.id;
    transition(state, 'draft', 'running', 'start');
    const claim = state.store.claimCampaignLease({
      campaignId: campaign.id,
      owner,
      nowMs: 1_000,
      ttlMs: 1_000,
    });
    assert.equal(claim.claimed, true);
    state.claimNowMs = 2_001;
  },
);

Then(
  'coordinator {string} should become the campaign owner',
  async function (this: CustomWorld, owner: string) {
    const state = await stateFor(this);
    assert.equal(state.firstClaim, true);
    assert.equal(state.store.getCampaign(state.campaignId!)?.leaseOwner, owner);
  },
);

Then(
  'coordinator {string} should no longer be allowed to advance the campaign',
  async function (this: CustomWorld, owner: string) {
    const state = await stateFor(this);
    assert.notEqual(state.store.getCampaign(state.campaignId!)?.leaseOwner, owner);
  },
);

Given(
  'an active autonomous campaign for repository {string} on branch {string}',
  async function (this: CustomWorld, repository: string, baseBranch: string) {
    const state = await stateFor(this);
    const campaign = state.store.createCampaign({ repository, baseBranch });
    state.originalCampaignId = campaign.id;
    state.campaignId = campaign.id;
    transition(state, 'draft', 'running', 'start');
  },
);

When(
  'an administrator creates another campaign for repository {string} on branch {string}',
  async function (this: CustomWorld, repository: string, baseBranch: string) {
    const state = await stateFor(this);
    try {
      state.store.createCampaign({ repository, baseBranch });
    } catch (error) {
      state.lastError = error;
    }
  },
);

Then('the new campaign should be rejected as a conflict', async function (this: CustomWorld) {
  const state = await stateFor(this);
  assert.equal(isConflict(state.lastError), true);
});

Then('the original campaign should remain unchanged', async function (this: CustomWorld) {
  const state = await stateFor(this);
  assert.ok(state.originalCampaignId, 'original campaign must exist');
  const campaign = state.store.getCampaign(state.originalCampaignId);
  assert.equal(campaign?.status, 'running');
  assert.equal(campaign?.repository, 'crgarcia12/liliput');
});

Given(
  'a stopped autonomous campaign for repository {string} on branch {string}',
  async function (this: CustomWorld, repository: string, baseBranch: string) {
    const state = await stateFor(this);
    const campaign = state.store.createCampaign({ repository, baseBranch });
    state.campaignId = campaign.id;
    transition(state, 'draft', 'stopped', 'stop');
  },
);

When(
  'an administrator creates a new campaign for repository {string} on branch {string}',
  async function (this: CustomWorld, repository: string, baseBranch: string) {
    const state = await stateFor(this);
    const replacement = state.store.createCampaign({ repository, baseBranch });
    state.replacementCampaignId = replacement.id;
  },
);

Then('the new campaign should be created in draft state', async function (this: CustomWorld) {
  const state = await stateFor(this);
  assert.equal(
    state.store.getCampaign(state.replacementCampaignId!)?.status,
    'draft',
  );
});

Given(
  'an autonomous campaign has an active cycle for {string}',
  async function (this: CustomWorld, title: string) {
    const state = await stateFor(this);
    const campaign = state.store.createCampaign({
      repository: 'crgarcia12/liliput',
      baseBranch: 'main',
    });
    state.campaignId = campaign.id;
    transition(state, 'draft', 'running', 'start');
    const cycle = state.store.createCycle({
      campaignId: campaign.id,
      sequence: 1,
      title,
      status: 'proposing',
    });
    state.cycleId = cycle.id;
  },
);

When(
  'the coordinator tries to start another cycle for {string}',
  async function (this: CustomWorld, title: string) {
    const state = await stateFor(this);
    try {
      state.store.createCycle({
        campaignId: state.campaignId!,
        sequence: 2,
        title,
        status: 'proposing',
      });
    } catch (error) {
      state.lastError = error;
    }
  },
);

Then('the second cycle should be rejected as a conflict', async function (this: CustomWorld) {
  const state = await stateFor(this);
  assert.equal(isConflict(state.lastError), true);
});

Then(
  '{string} should remain the active cycle',
  async function (this: CustomWorld, title: string) {
    const state = await stateFor(this);
    assert.equal(state.store.getCurrentCycle(state.campaignId!)?.title, title);
  },
);

Given(
  'a campaign transition with idempotency key {string}',
  async function (this: CustomWorld, idempotencyKey: string) {
    const state = await stateFor(this);
    state.idempotencyKey = idempotencyKey;
    const campaign = state.store.createCampaign({
      repository: 'crgarcia12/liliput',
      baseBranch: 'main',
    });
    state.campaignId = campaign.id;
    transition(state, 'draft', 'running', 'start');
    const cycle = state.store.createCycle({
      campaignId: campaign.id,
      sequence: 3,
      title: 'Add cost alerts',
      status: 'proposing',
    });
    state.cycleId = cycle.id;
    const attempt = state.store.createAttempt({
      cycleId: cycle.id,
      attemptNumber: 1,
      status: 'running',
      idempotencyKey,
    });
    state.attemptId = attempt.id;
  },
);

Given(
  'the transition already created delivery attempt {int}',
  async function (this: CustomWorld, attemptNumber: number) {
    const state = await stateFor(this);
    assert.equal(state.store.getAttempt(state.attemptId!)?.attemptNumber, attemptNumber);
  },
);

When(
  'the same transition is replayed with the same idempotency key',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    const replay = state.store.createAttempt({
      cycleId: state.cycleId!,
      attemptNumber: 1,
      status: 'running',
      idempotencyKey: state.idempotencyKey!,
    });
    state.replayedAttemptId = replay.id;
  },
);

Then(
  'the campaign should still contain exactly one delivery attempt {int}',
  async function (this: CustomWorld, attemptNumber: number) {
    const state = await stateFor(this);
    const attempts = state.store
      .listAttempts(state.cycleId!)
      .filter((attempt) => attempt.attemptNumber === attemptNumber);
    assert.equal(attempts.length, 1);
  },
);

Then('the campaign state should match the first transition result', async function (this: CustomWorld) {
  const state = await stateFor(this);
  assert.equal(state.replayedAttemptId, state.attemptId);
});

Given('an autonomous campaign is paused', async function (this: CustomWorld) {
  const state = await stateFor(this);
  const campaign = state.store.createCampaign({
    repository: 'crgarcia12/liliput',
    baseBranch: 'main',
  });
  state.campaignId = campaign.id;
  transition(state, 'draft', 'running', 'start');
  transition(state, 'running', 'paused', 'pause');
});

When(
  'a coordinator tries to move it from running to stopped',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    const result = state.store.transitionCampaign({
      campaignId: state.campaignId!,
      expectedStatus: 'running',
      nextStatus: 'stopped',
      idempotencyKey: `${state.campaignId}-stale-stop`,
    });
    state.transitionApplied = result.applied;
  },
);

Then('the transition should be rejected as a conflict', async function (this: CustomWorld) {
  const state = await stateFor(this);
  assert.equal(state.transitionApplied, false);
});

Then('the campaign should remain paused', async function (this: CustomWorld) {
  const state = await stateFor(this);
  assert.equal(state.store.getCampaign(state.campaignId!)?.status, 'paused');
});

Given(
  'a failed delivery attempt already has a retry delay of {int} minutes',
  async function (this: CustomWorld, delayMinutes: number) {
    const state = await stateFor(this);
    const campaign = state.store.createCampaign({
      repository: 'crgarcia12/liliput',
      baseBranch: 'main',
    });
    state.campaignId = campaign.id;
    transition(state, 'draft', 'running', 'start');
    const cycle = state.store.createCycle({
      campaignId: campaign.id,
      sequence: 1,
      title: 'Add resilient deployments',
      status: 'proposing',
    });
    state.cycleId = cycle.id;
    state.retryDelayMinutes = delayMinutes;
  },
);

Given(
  'the campaign retry backoff cap is {int} minutes',
  async function (this: CustomWorld, capMinutes: number) {
    const state = await stateFor(this);
    assert.ok(capMinutes > 0);
    state.retryCapMinutes = capMinutes;
  },
);

When(
  'another failed attempt is recorded for the same feature',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    const result = state.store.scheduleCycleRetry({
      cycleId: state.cycleId!,
      previousDelayMinutes: state.retryDelayMinutes!,
      capMinutes: state.retryCapMinutes!,
    });
    state.retryDelayMinutes = result.delayMinutes;
  },
);

Then(
  'the next retry delay should be {int} minutes',
  async function (this: CustomWorld, expectedMinutes: number) {
    const state = await stateFor(this);
    assert.equal(state.retryDelayMinutes, expectedMinutes);
  },
);

Then('the same accepted feature should remain current', async function (this: CustomWorld) {
  const state = await stateFor(this);
  assert.equal(
    state.store.getCurrentCycle(state.campaignId!)?.title,
    'Add resilient deployments',
  );
});

Given(
  'delivery attempt {int} has recorded usage event {string}',
  async function (this: CustomWorld, attemptNumber: number, usageEventId: string) {
    const state = await stateFor(this);
    const campaign = state.store.createCampaign({
      repository: 'crgarcia12/liliput',
      baseBranch: 'main',
    });
    state.campaignId = campaign.id;
    transition(state, 'draft', 'running', 'start');
    const cycle = state.store.createCycle({
      campaignId: campaign.id,
      sequence: 1,
      title: 'Add cost history',
      status: 'proposing',
    });
    state.cycleId = cycle.id;
    const attempt = state.store.createAttempt({
      cycleId: cycle.id,
      attemptNumber,
      status: 'running',
      idempotencyKey: `${cycle.id}-attempt-${attemptNumber}`,
    });
    state.attemptId = attempt.id;
    state.usageBeforeReplay = state.store.recordAttemptUsage({
      attemptId: attempt.id,
      usageEventId,
      turns: 1,
      estimatedCostUsd: 2.5,
    });
  },
);

When(
  'usage event {string} is received again',
  async function (this: CustomWorld, usageEventId: string) {
    const state = await stateFor(this);
    state.usageAfterReplay = state.store.recordAttemptUsage({
      attemptId: state.attemptId!,
      usageEventId,
      turns: 1,
      estimatedCostUsd: 2.5,
    });
  },
);

Then('the attempt turn count should not increase', async function (this: CustomWorld) {
  const state = await stateFor(this);
  assert.equal(
    state.usageAfterReplay?.turnsUsed,
    state.usageBeforeReplay?.turnsUsed,
  );
});

Then('the attempt estimated cost should not increase', async function (this: CustomWorld) {
  const state = await stateFor(this);
  assert.equal(
    state.usageAfterReplay?.estimatedCostUsd,
    state.usageBeforeReplay?.estimatedCostUsd,
  );
});

Given(
  'a manually created workstream and task existed before autonomous campaigns were introduced',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    const workstream = createWorkstream(
      'crgarcia12/liliput',
      'Manual maintenance',
    );
    const task = createTask(
      'Update dependency',
      'Update one dependency without using an autonomous campaign.',
      'crgarcia12/liliput',
      { workstreamId: workstream.id },
    );
    state.manualWorkstreamId = workstream.id;
    state.manualTaskId = task.id;
  },
);

When(
  'the Liliput control plane starts with campaign storage enabled',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    closeDb();
    state.store = await loadCampaignStore();
    state.store.resetAutonomousCampaignStore();
  },
);

Then('the existing workstream should still be readable', async function (this: CustomWorld) {
  const state = await stateFor(this);
  assert.equal(
    getWorkstream(state.manualWorkstreamId!)?.name,
    'Manual maintenance',
  );
});

Then(
  'the existing task should retain its status and history',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    const task = getTask(state.manualTaskId!);
    assert.equal(task?.status, 'clarifying');
    assert.equal(task?.description, 'Update one dependency without using an autonomous campaign.');
    assert.equal(task?.turns?.length, 1);
  },
);
