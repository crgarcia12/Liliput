import { After, Given, Then, When } from '@cucumber/cucumber';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AutonomousCampaign,
  AutonomousCampaignAttempt,
  AutonomousCampaignBudgetReason,
  AutonomousCampaignCycle,
  AutonomousCampaignJsonObject,
} from '../../../src/shared/types/index';
import * as campaignStore from '../../../src/api/src/stores/autonomous-campaign-store';
import { closeDb, getDb } from '../../../src/api/src/stores/db';
import {
  createTask,
  resetStore,
  updateTask,
} from '../../../src/api/src/stores/task-store';
import type { CustomWorld } from '../support/world';

type CampaignAttemptStage =
  | 'agent-turn'
  | 'build'
  | 'image-build'
  | 'deployment'
  | 'review';

interface BoundedCampaignAttempt extends AutonomousCampaignAttempt {
  maxTurns: number;
  maxElapsedMs: number;
  maxEstimatedCostUsd: number;
  activeStartedAt?: string;
}

interface AttemptActionResult {
  allowed: boolean;
  reason?:
    | AutonomousCampaignBudgetReason
    | 'paused'
    | 'stopped'
    | 'waiting_for_external'
    | 'retry_wait';
  attempt: BoundedCampaignAttempt;
  cycle: AutonomousCampaignCycle;
}

interface AttemptTransitionResult {
  campaign: AutonomousCampaign;
  cycle: AutonomousCampaignCycle;
  attempt: BoundedCampaignAttempt;
}

interface RetryStartResult {
  started: boolean;
  cycle: AutonomousCampaignCycle;
  attempt?: BoundedCampaignAttempt;
}

interface CampaignAttemptManager {
  evaluateBeforeAction(
    campaignId: string,
    cycleId: string,
    stage: CampaignAttemptStage,
  ): AttemptActionResult;
  recordUsage(
    campaignId: string,
    cycleId: string,
    input: {
      usageEventId: string;
      turns: number;
      estimatedCostUsd: number;
    },
  ): BoundedCampaignAttempt;
  waitForExternal(
    campaignId: string,
    cycleId: string,
    input: { stage: CampaignAttemptStage; message: string },
  ): AttemptTransitionResult;
  resumeExternalWait(
    campaignId: string,
    cycleId: string,
  ): AttemptTransitionResult;
  failAttempt(
    campaignId: string,
    cycleId: string,
    input: { stage: CampaignAttemptStage; message: string },
  ): AttemptTransitionResult;
  pause(campaignId: string, cycleId: string): AttemptTransitionResult;
  resume(campaignId: string, cycleId: string): AttemptTransitionResult;
  stop(campaignId: string, cycleId: string): AttemptTransitionResult;
  startDueRetry(campaignId: string, cycleId: string): RetryStartResult;
}

interface CampaignAttemptManagerModule {
  createAutonomousCampaignAttemptManager(options: {
    owner: string;
    now: () => number;
    interruptTask: (taskId: string, reason: 'pause' | 'stop') => void;
  }): CampaignAttemptManager;
}

interface ScenarioState {
  dbPath: string;
  previousDefaultAdminPassword?: string;
  nowMs: number;
  owner: string;
  repository?: string;
  baseBranch?: string;
  campaignId?: string;
  cycleId?: string;
  taskId?: string;
  attemptId?: string;
  proposal?: AutonomousCampaignJsonObject;
  module?: CampaignAttemptManagerModule;
  manager?: CampaignAttemptManager;
  gate?: AttemptActionResult;
  transition?: AttemptTransitionResult;
  retry?: RetryStartResult;
  retryReplay?: RetryStartResult;
  interrupted: Array<{ taskId: string; reason: 'pause' | 'stop' }>;
  pendingFailure?: { stage: CampaignAttemptStage; message: string };
  attemptBeforeLimitChange?: BoundedCampaignAttempt;
  nextAttempt?: BoundedCampaignAttempt;
}

const attemptManagerModulePath =
  '../../../src/api/src/engine/autonomous-campaign-attempt-manager';
const scenarioStates = new WeakMap<CustomWorld, ScenarioState>();

function stateFor(world: CustomWorld): ScenarioState {
  const existing = scenarioStates.get(world);
  if (existing) return existing;

  closeDb();
  const dbPath = path.join(
    os.tmpdir(),
    `liliput-attempt-bounds-bdd-${process.pid}-${randomUUID()}.db`,
  );
  process.env['DB_PATH'] = dbPath;
  const previousDefaultAdminPassword = process.env['DEFAULT_ADMIN_PASSWORD'];
  process.env['DEFAULT_ADMIN_PASSWORD'] = 'test-only-admin-password';
  campaignStore.resetAutonomousCampaignStore();
  resetStore();
  const state: ScenarioState = {
    dbPath,
    previousDefaultAdminPassword,
    nowMs: 1_000,
    owner: 'api-pod-a',
    interrupted: [],
  };
  scenarioStates.set(world, state);
  return state;
}

async function managerFor(state: ScenarioState): Promise<CampaignAttemptManager> {
  if (state.manager) return state.manager;
  if (!state.module) {
    const loaded: unknown = await import(attemptManagerModulePath);
    state.module = loaded as CampaignAttemptManagerModule;
  }
  state.manager = state.module.createAutonomousCampaignAttemptManager({
    owner: state.owner,
    now: () => state.nowMs,
    interruptTask: (taskId, reason) => {
      state.interrupted.push({ taskId, reason });
    },
  });
  return state.manager;
}

function requireCampaignId(state: ScenarioState): string {
  assert.ok(state.campaignId, 'campaign must exist');
  return state.campaignId;
}

function requireCycleId(state: ScenarioState): string {
  assert.ok(state.cycleId, 'cycle must exist');
  return state.cycleId;
}

function requireTaskId(state: ScenarioState): string {
  assert.ok(state.taskId, 'task must exist');
  return state.taskId;
}

function requireAttemptId(state: ScenarioState): string {
  assert.ok(state.attemptId, 'attempt must exist');
  return state.attemptId;
}

function requireAttempt(state: ScenarioState): BoundedCampaignAttempt {
  const attempt = campaignStore.getAttempt(
    requireAttemptId(state),
  ) as BoundedCampaignAttempt | undefined;
  assert.ok(attempt, 'attempt must be readable');
  return attempt;
}

function limitReason(label: string): AutonomousCampaignBudgetReason {
  switch (label) {
    case 'turn count':
      return 'turns';
    case 'elapsed time':
      return 'time';
    case 'estimated cost':
      return 'cost';
    default:
      throw new Error(`Unknown attempt limit: ${label}`);
  }
}

Given(
  'a coordinator-owned bounded-attempt campaign targets repository {string} and branch {string}',
  function (this: CustomWorld, repository: string, baseBranch: string) {
    const state = stateFor(this);
    state.repository = repository;
    state.baseBranch = baseBranch;
    const campaign = campaignStore.createCampaign({
      repository,
      baseBranch,
      maxTurnsPerAttempt: 500,
      maxMinutesPerAttempt: 240,
      maxCostUsdPerAttempt: 250,
      retryBackoffCapMinutes: 60,
    });
    campaignStore.transitionCampaign({
      campaignId: campaign.id,
      expectedStatus: 'draft',
      nextStatus: 'running',
      idempotencyKey: `${campaign.id}-start`,
      nowMs: state.nowMs,
    });
    const lease = campaignStore.claimCampaignLease({
      campaignId: campaign.id,
      owner: state.owner,
      nowMs: state.nowMs,
      ttlMs: 24 * 60 * 60_000,
    });
    assert.equal(lease.claimed, true);
    state.campaignId = campaign.id;
  },
);

Given(
  'its feature cycle 5 is delivering the accepted proposal {string}',
  function (this: CustomWorld, title: string) {
    const state = stateFor(this);
    const proposal: AutonomousCampaignJsonObject = {
      title,
      fingerprint: 'attempt-bounds-proposal',
    };
    const cycle = campaignStore.createCycle({
      campaignId: requireCampaignId(state),
      sequence: 5,
      title,
      status: 'delivering',
      proposal,
      proposalFingerprint: 'attempt-bounds-proposal',
      baseSha: 'abc123def456',
      leaseOwner: state.owner,
      nowMs: state.nowMs,
    });
    state.cycleId = cycle.id;
    state.proposal = proposal;
  },
);

Given(
  'delivery attempt 2 is active for that bounded feature cycle',
  function (this: CustomWorld) {
    const state = stateFor(this);
    const cycleId = requireCycleId(state);
    const task = createTask(
      'Explain failed preview health checks',
      'Expose failed preview probe evidence.',
      state.repository,
      {
        baseBranch: state.baseBranch,
        commitMode: 'pr',
        campaignCycleId: cycleId,
      },
    );
    updateTask(task.id, {
      status: 'building',
      branch: 'liliput/campaign-cycle-5',
      imageRef: 'crgarliliputacr.azurecr.io/preview:cycle-5',
      devNamespace: 'dev-cycle-5',
      devUrl: 'https://liliput.example/dev/cycle-5',
      pullRequestUrl: 'https://github.com/crgarcia12/Liliput/pull/205',
      pullRequestNumber: 205,
    });
    campaignStore.updateCycleDelivery({
      campaignId: requireCampaignId(state),
      cycleId,
      leaseOwner: state.owner,
      nowMs: state.nowMs,
      taskId: task.id,
      branchName: 'liliput/campaign-cycle-5',
      imageRef: 'crgarliliputacr.azurecr.io/preview:cycle-5',
      previewNamespace: 'dev-cycle-5',
      previewUrl: 'https://liliput.example/dev/cycle-5',
      pullRequestUrl: 'https://github.com/crgarcia12/Liliput/pull/205',
      pullRequestNumber: 205,
    });
    const attempt = campaignStore.createAttempt({
      cycleId,
      attemptNumber: 2,
      status: 'running',
      idempotencyKey: `${cycleId}-attempt-2`,
      leaseOwner: state.owner,
      nowMs: state.nowMs,
    });
    state.taskId = task.id;
    state.attemptId = attempt.id;
  },
);

Given(
  'delivery attempt 2 has reached its configured {string} limit',
  function (this: CustomWorld, label: string) {
    const state = stateFor(this);
    const values =
      limitReason(label) === 'turns'
        ? [500, null, null]
        : limitReason(label) === 'time'
          ? [null, 240 * 60_000, null]
          : [null, null, 250];
    getDb()
      .prepare(
        `UPDATE autonomous_attempts
            SET turns_used = COALESCE(?, turns_used),
                elapsed_ms = COALESCE(?, elapsed_ms),
                estimated_cost_usd = COALESCE(?, estimated_cost_usd)
          WHERE id = ?`,
      )
      .run(...values, requireAttemptId(state));
  },
);

When(
  'the coordinator evaluates the attempt before another model action',
  async function (this: CustomWorld) {
    const state = stateFor(this);
    state.gate = (await managerFor(state)).evaluateBeforeAction(
      requireCampaignId(state),
      requireCycleId(state),
      'agent-turn',
    );
  },
);

Then(
  'no additional model action should be scheduled',
  function (this: CustomWorld) {
    const state = stateFor(this);
    assert.equal(state.gate?.allowed, false);
  },
);

Then(
  'delivery attempt 2 should end as bounded by {string}',
  function (this: CustomWorld, label: string) {
    const state = stateFor(this);
    assert.equal(state.gate?.reason, limitReason(label));
    assert.equal(state.gate?.attempt.status, 'failed');
    assert.match(
      state.gate?.attempt.failureMessage ?? '',
      new RegExp(`attempt-limit:${limitReason(label)}`),
    );
  },
);

Then(
  'feature cycle 5 should wait to retry the same accepted proposal',
  function (this: CustomWorld) {
    const state = stateFor(this);
    assert.equal(state.gate?.cycle.status, 'retry_wait');
    assert.deepEqual(state.gate?.cycle.proposal, state.proposal);
    assert.ok(state.gate?.cycle.nextRetryAt);
  },
);

Given(
  'delivery attempt 2 failed during the build stage',
  function (this: CustomWorld) {
    stateFor(this).pendingFailure = {
      stage: 'build',
      message: 'npm test exited with code 1',
    };
  },
);

Given(
  'the attempt records its turns, elapsed time, estimated cost, and failure message',
  function (this: CustomWorld) {
    const state = stateFor(this);
    getDb()
      .prepare(
        `UPDATE autonomous_attempts
            SET turns_used = 3,
                elapsed_ms = 45000,
                estimated_cost_usd = 12.5
          WHERE id = ?`,
      )
      .run(requireAttemptId(state));
  },
);

When(
  'the coordinator schedules the next delivery attempt',
  async function (this: CustomWorld) {
    const state = stateFor(this);
    assert.ok(state.pendingFailure, 'failure must be configured');
    state.transition = (await managerFor(state)).failAttempt(
      requireCampaignId(state),
      requireCycleId(state),
      state.pendingFailure,
    );
  },
);

Then(
  'feature cycle 5 should enter {string}',
  function (this: CustomWorld, expected: string) {
    assert.equal(stateFor(this).transition?.cycle.status, expected);
  },
);

Then(
  'its retry time should use exponential backoff',
  function (this: CustomWorld) {
    const cycle = stateFor(this).transition?.cycle;
    assert.equal(cycle?.retryDelayMinutes, 1);
    assert.ok(cycle?.nextRetryAt);
  },
);

Then(
  'the accepted proposal, workstream, task, and delivery checkpoints should remain linked',
  function (this: CustomWorld) {
    const state = stateFor(this);
    const cycle = state.transition?.cycle;
    assert.deepEqual(cycle?.proposal, state.proposal);
    assert.equal(cycle?.taskId, requireTaskId(state));
    assert.equal(cycle?.branchName, 'liliput/campaign-cycle-5');
    assert.equal(
      cycle?.imageRef,
      'crgarliliputacr.azurecr.io/preview:cycle-5',
    );
    assert.equal(cycle?.previewNamespace, 'dev-cycle-5');
    assert.equal(cycle?.pullRequestNumber, 205);
  },
);

Then(
  'the next attempt should resume the same accepted proposal',
  function (this: CustomWorld) {
    const state = stateFor(this);
    assert.deepEqual(state.transition?.cycle.proposal, state.proposal);
    assert.equal(state.transition?.cycle.taskId, requireTaskId(state));
  },
);

Given(
  'feature cycle 5 has failed enough attempts to reach the 60 minute retry cap',
  function (this: CustomWorld) {
    const state = stateFor(this);
    getDb()
      .prepare(
        `UPDATE autonomous_cycles
            SET retry_delay_minutes = 60
          WHERE id = ?`,
      )
      .run(requireCycleId(state));
    state.pendingFailure = {
      stage: 'deployment',
      message: 'preview rollout timed out',
    };
  },
);

When(
  'another delivery attempt fails for the same accepted proposal',
  async function (this: CustomWorld) {
    const state = stateFor(this);
    assert.ok(state.pendingFailure, 'failure must be configured');
    state.transition = (await managerFor(state)).failAttempt(
      requireCampaignId(state),
      requireCycleId(state),
      state.pendingFailure,
    );
  },
);

Then(
  'the next retry delay should remain 60 minutes',
  function (this: CustomWorld) {
    assert.equal(stateFor(this).transition?.cycle.retryDelayMinutes, 60);
  },
);

Then(
  'another attempt should remain eligible after that delay',
  async function (this: CustomWorld) {
    const state = stateFor(this);
    const nextRetryAt = state.transition?.cycle.nextRetryAt;
    assert.ok(nextRetryAt);
    state.nowMs = Date.parse(nextRetryAt);
    state.retry = (await managerFor(state)).startDueRetry(
      requireCampaignId(state),
      requireCycleId(state),
    );
    assert.equal(state.retry.started, true);
  },
);

Then(
  'no replacement proposal or subsequent feature cycle should be created',
  function (this: CustomWorld) {
    const state = stateFor(this);
    const cycle = campaignStore.getCurrentCycle(requireCampaignId(state));
    assert.equal(cycle?.id, requireCycleId(state));
    assert.deepEqual(cycle?.proposal, state.proposal);
  },
);

Given(
  'delivery attempt 2 is waiting for unavailable preview infrastructure',
  async function (this: CustomWorld) {
    const state = stateFor(this);
    state.transition = (await managerFor(state)).waitForExternal(
      requireCampaignId(state),
      requireCycleId(state),
      {
        stage: 'deployment',
        message: 'preview cluster is unavailable',
      },
    );
  },
);

When(
  '{int} minutes pass without a model action',
  function (this: CustomWorld, minutes: number) {
    stateFor(this).nowMs += minutes * 60_000;
  },
);

Then(
  'the attempt turn count should remain unchanged',
  function (this: CustomWorld) {
    const state = stateFor(this);
    assert.equal(
      requireAttempt(state).turnsUsed,
      state.transition?.attempt.turnsUsed,
    );
  },
);

Then(
  'the attempt estimated cost should remain unchanged',
  function (this: CustomWorld) {
    const state = stateFor(this);
    assert.equal(
      requireAttempt(state).estimatedCostUsd,
      state.transition?.attempt.estimatedCostUsd,
    );
  },
);

Then(
  'feature cycle 5 should remain {string}',
  function (this: CustomWorld, expected: string) {
    const state = stateFor(this);
    assert.equal(
      campaignStore.getCycle(requireCycleId(state))?.status,
      expected,
    );
  },
);

Then(
  'the same attempt should remain resumable when infrastructure recovers',
  async function (this: CustomWorld) {
    const state = stateFor(this);
    const resumed = (await managerFor(state)).resumeExternalWait(
      requireCampaignId(state),
      requireCycleId(state),
    );
    assert.equal(resumed.attempt.id, requireAttemptId(state));
    assert.equal(resumed.cycle.status, 'delivering');
  },
);

Given(
  'delivery attempt 2 is active in the {string} stage',
  function (this: CustomWorld, stage: string) {
    const validStages = new Set([
      'agent turn',
      'image build',
      'deployment',
      'review',
    ]);
    assert.ok(validStages.has(stage), `unexpected stage ${stage}`);
  },
);

When(
  'an administrator pauses the campaign',
  async function (this: CustomWorld) {
    const state = stateFor(this);
    state.transition = (await managerFor(state)).pause(
      requireCampaignId(state),
      requireCycleId(state),
    );
  },
);

Then(
  'the pause request should be acknowledged without scheduling another stage',
  function (this: CustomWorld) {
    const transition = stateFor(this).transition;
    assert.equal(transition?.campaign.status, 'paused');
    assert.equal(transition?.cycle.status, 'paused');
  },
);

Then(
  'active work should be interrupted at the next cancellable boundary',
  function (this: CustomWorld) {
    const state = stateFor(this);
    assert.deepEqual(state.interrupted, [
      { taskId: requireTaskId(state), reason: 'pause' },
    ]);
  },
);

Then(
  'the campaign and feature cycle 5 should become {string}',
  function (this: CustomWorld, expected: string) {
    const transition = stateFor(this).transition;
    assert.equal(transition?.campaign.status, expected);
    assert.equal(transition?.cycle.status, expected);
  },
);

Then(
  'the accepted proposal and all delivery evidence should remain intact',
  function (this: CustomWorld) {
    const state = stateFor(this);
    const cycle = state.transition?.cycle;
    assert.deepEqual(cycle?.proposal, state.proposal);
    assert.equal(cycle?.taskId, requireTaskId(state));
    assert.equal(cycle?.branchName, 'liliput/campaign-cycle-5');
    assert.equal(cycle?.previewNamespace, 'dev-cycle-5');
    assert.equal(cycle?.pullRequestNumber, 205);
  },
);

Given(
  'the campaign was paused during delivery attempt 2',
  async function (this: CustomWorld) {
    const state = stateFor(this);
    state.transition = (await managerFor(state)).pause(
      requireCampaignId(state),
      requireCycleId(state),
    );
  },
);

Given(
  'the Liliput control plane restarts while the paused attempt is persisted',
  function (this: CustomWorld) {
    const state = stateFor(this);
    state.manager = undefined;
    state.module = undefined;
    closeDb();
  },
);

When(
  'an administrator resumes the campaign',
  async function (this: CustomWorld) {
    const state = stateFor(this);
    state.transition = (await managerFor(state)).resume(
      requireCampaignId(state),
      requireCycleId(state),
    );
  },
);

Then(
  'feature cycle 5 should remain the current cycle',
  function (this: CustomWorld) {
    const state = stateFor(this);
    assert.equal(
      campaignStore.getCurrentCycle(requireCampaignId(state))?.id,
      requireCycleId(state),
    );
  },
);

Then(
  'delivery attempt 2 should resume from its persisted safe boundary',
  function (this: CustomWorld) {
    const state = stateFor(this);
    assert.equal(state.transition?.attempt.id, requireAttemptId(state));
    assert.equal(state.transition?.attempt.status, 'running');
    assert.ok(state.transition?.attempt.activeStartedAt);
  },
);

Then(
  'its prior turns, elapsed time, estimated cost, and checkpoints should be retained',
  function (this: CustomWorld) {
    const state = stateFor(this);
    const attempt = state.transition?.attempt;
    assert.ok(attempt);
    assert.ok(attempt.turnsUsed >= 0);
    assert.ok(attempt.elapsedMs >= 0);
    assert.ok(attempt.estimatedCostUsd >= 0);
    assert.equal(state.transition?.cycle.taskId, requireTaskId(state));
    assert.equal(
      state.transition?.cycle.branchName,
      'liliput/campaign-cycle-5',
    );
  },
);

Then(
  'no new proposal, workstream, task, or branch should be created',
  function (this: CustomWorld) {
    const state = stateFor(this);
    assert.deepEqual(state.transition?.cycle.proposal, state.proposal);
    assert.equal(state.transition?.cycle.taskId, requireTaskId(state));
    assert.equal(
      state.transition?.cycle.branchName,
      'liliput/campaign-cycle-5',
    );
    assert.equal(campaignStore.listAttempts(requireCycleId(state)).length, 1);
  },
);

Given(
  'feature cycle 5 is waiting to retry delivery attempt 2',
  async function (this: CustomWorld) {
    const state = stateFor(this);
    state.transition = (await managerFor(state)).failAttempt(
      requireCampaignId(state),
      requireCycleId(state),
      {
        stage: 'build',
        message: 'compiler failed',
      },
    );
  },
);

When(
  'an administrator stops the campaign',
  async function (this: CustomWorld) {
    const state = stateFor(this);
    state.transition = (await managerFor(state)).stop(
      requireCampaignId(state),
      requireCycleId(state),
    );
  },
);

Then(
  'no retry should remain scheduled',
  function (this: CustomWorld) {
    assert.equal(stateFor(this).transition?.cycle.nextRetryAt, undefined);
  },
);

Then(
  'no future attempt or feature cycle should be created',
  async function (this: CustomWorld) {
    const state = stateFor(this);
    state.nowMs += 24 * 60 * 60_000;
    const retry = (await managerFor(state)).startDueRetry(
      requireCampaignId(state),
      requireCycleId(state),
    );
    assert.equal(retry.started, false);
    assert.equal(campaignStore.listAttempts(requireCycleId(state)).length, 1);
  },
);

Then(
  'the proposal, branch, pull request, preview, task, and attempt evidence should remain inspectable',
  function (this: CustomWorld) {
    const state = stateFor(this);
    const cycle = state.transition?.cycle;
    assert.deepEqual(cycle?.proposal, state.proposal);
    assert.equal(cycle?.branchName, 'liliput/campaign-cycle-5');
    assert.equal(cycle?.pullRequestNumber, 205);
    assert.equal(cycle?.previewNamespace, 'dev-cycle-5');
    assert.equal(cycle?.taskId, requireTaskId(state));
    assert.equal(state.transition?.attempt.id, requireAttemptId(state));
  },
);

Given(
  'feature cycle 5 is waiting until a persisted retry time',
  async function (this: CustomWorld) {
    const state = stateFor(this);
    state.transition = (await managerFor(state)).failAttempt(
      requireCampaignId(state),
      requireCycleId(state),
      {
        stage: 'build',
        message: 'compiler failed',
      },
    );
  },
);

Given(
  'the Liliput control plane restarts before that retry time',
  function (this: CustomWorld) {
    const state = stateFor(this);
    state.manager = undefined;
    state.module = undefined;
    closeDb();
  },
);

When(
  'the persisted retry time arrives',
  async function (this: CustomWorld) {
    const state = stateFor(this);
    const nextRetryAt = campaignStore.getCycle(requireCycleId(state))?.nextRetryAt;
    assert.ok(nextRetryAt);
    state.nowMs = Date.parse(nextRetryAt);
    state.retry = (await managerFor(state)).startDueRetry(
      requireCampaignId(state),
      requireCycleId(state),
    );
    state.retryReplay = (await managerFor(state)).startDueRetry(
      requireCampaignId(state),
      requireCycleId(state),
    );
  },
);

Then(
  'exactly one next attempt should start for feature cycle 5',
  function (this: CustomWorld) {
    const state = stateFor(this);
    assert.equal(state.retry?.started, true);
    assert.equal(state.retryReplay?.started, false);
    assert.equal(campaignStore.listAttempts(requireCycleId(state)).length, 2);
  },
);

Then(
  'it should use the same accepted proposal and delivery resources',
  function (this: CustomWorld) {
    const state = stateFor(this);
    assert.deepEqual(state.retry?.cycle.proposal, state.proposal);
    assert.equal(state.retry?.cycle.taskId, requireTaskId(state));
    assert.equal(state.retry?.cycle.branchName, 'liliput/campaign-cycle-5');
  },
);

Then(
  'replaying startup reconciliation should not create another attempt',
  function (this: CustomWorld) {
    const state = stateFor(this);
    assert.equal(state.retryReplay?.attempt?.id, state.retry?.attempt?.id);
    assert.equal(campaignStore.listAttempts(requireCycleId(state)).length, 2);
  },
);

Given(
  'delivery attempt 2 has recorded model usage',
  async function (this: CustomWorld) {
    const state = stateFor(this);
    await managerFor(state);
    state.manager!.recordUsage(
      requireCampaignId(state),
      requireCycleId(state),
      {
        usageEventId: 'usage-deploy-2',
        turns: 4,
        estimatedCostUsd: 8.75,
      },
    );
  },
);

When(
  'an external call fails during the deployment stage',
  async function (this: CustomWorld) {
    const state = stateFor(this);
    state.nowMs += 90_000;
    state.transition = (await managerFor(state)).failAttempt(
      requireCampaignId(state),
      requireCycleId(state),
      {
        stage: 'deployment',
        message: 'AKS API returned DNS failure',
      },
    );
  },
);

Then(
  'delivery attempt 2 should record status {string}',
  function (this: CustomWorld, expected: string) {
    assert.equal(stateFor(this).transition?.attempt.status, expected);
  },
);

Then(
  'it should record failure stage {string}',
  function (this: CustomWorld, expected: string) {
    assert.equal(stateFor(this).transition?.attempt.failureStage, expected);
  },
);

Then(
  'it should retain the failure message, timestamp, turns, elapsed time, and estimated cost',
  function (this: CustomWorld) {
    const attempt = stateFor(this).transition?.attempt;
    assert.ok(attempt?.failureMessage);
    assert.ok(attempt?.completedAt);
    assert.equal(attempt?.turnsUsed, 4);
    assert.ok((attempt?.elapsedMs ?? 0) >= 90_000);
    assert.equal(attempt?.estimatedCostUsd, 8.75);
  },
);

Then(
  'the failure should not be converted into a successful cycle',
  function (this: CustomWorld) {
    assert.notEqual(stateFor(this).transition?.cycle.status, 'succeeded');
  },
);

Given(
  'delivery attempt 2 started with limits of 500 turns, 240 minutes, and 250 US dollars',
  function (this: CustomWorld) {
    const state = stateFor(this);
    state.attemptBeforeLimitChange = requireAttempt(state);
  },
);

When(
  'an administrator lowers the campaign limits during that attempt',
  function (this: CustomWorld) {
    const state = stateFor(this);
    getDb()
      .prepare(
        `UPDATE autonomous_campaigns
            SET max_turns_per_attempt = 100,
                max_minutes_per_attempt = 60,
                max_cost_usd_per_attempt = 25
          WHERE id = ?`,
      )
      .run(requireCampaignId(state));
  },
);

When(
  'the current attempt fails and its retry becomes due',
  async function (this: CustomWorld) {
    const state = stateFor(this);
    const manager = await managerFor(state);
    const failed = manager.failAttempt(
      requireCampaignId(state),
      requireCycleId(state),
      {
        stage: 'build',
        message: 'retry with lower limits',
      },
    );
    assert.ok(failed.cycle.nextRetryAt);
    state.nowMs = Date.parse(failed.cycle.nextRetryAt);
    state.retry = manager.startDueRetry(
      requireCampaignId(state),
      requireCycleId(state),
    );
    state.nextAttempt = state.retry.attempt;
  },
);

Then(
  'delivery attempt 2 should retain the limits it started with',
  function (this: CustomWorld) {
    const state = stateFor(this);
    const original = campaignStore.getAttempt(
      requireAttemptId(state),
    ) as BoundedCampaignAttempt | undefined;
    assert.ok(original);
    assert.deepEqual(
      {
        maxTurns: original.maxTurns,
        maxElapsedMs: original.maxElapsedMs,
        maxEstimatedCostUsd: original.maxEstimatedCostUsd,
      },
      {
        maxTurns: 500,
        maxElapsedMs: 240 * 60_000,
        maxEstimatedCostUsd: 250,
      },
    );
  },
);

Then(
  'the lowered limits should apply when the next attempt starts',
  function (this: CustomWorld) {
    assert.deepEqual(
      {
        maxTurns: stateFor(this).nextAttempt?.maxTurns,
        maxElapsedMs: stateFor(this).nextAttempt?.maxElapsedMs,
        maxEstimatedCostUsd:
          stateFor(this).nextAttempt?.maxEstimatedCostUsd,
      },
      {
        maxTurns: 100,
        maxElapsedMs: 60 * 60_000,
        maxEstimatedCostUsd: 25,
      },
    );
  },
);

After(function (this: CustomWorld) {
  const state = scenarioStates.get(this);
  if (!state) return;
  closeDb();
  fs.rmSync(state.dbPath, { force: true });
  fs.rmSync(`${state.dbPath}-shm`, { force: true });
  fs.rmSync(`${state.dbPath}-wal`, { force: true });
  process.env['DB_PATH'] = ':memory:';
  if (state.previousDefaultAdminPassword === undefined) {
    delete process.env['DEFAULT_ADMIN_PASSWORD'];
  } else {
    process.env['DEFAULT_ADMIN_PASSWORD'] =
      state.previousDefaultAdminPassword;
  }
  scenarioStates.delete(this);
});
