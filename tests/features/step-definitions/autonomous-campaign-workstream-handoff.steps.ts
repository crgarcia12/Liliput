import { After, Given, Then, When } from '@cucumber/cucumber';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AutonomousCampaignCycle,
  AutonomousCampaignJsonObject,
  PipelineState,
  Task,
  Workstream,
} from '../../../src/shared/types/index';
import type { AcceptedCampaignProposal } from '../../../src/shared/types/autonomous-campaign-proposal';
import * as campaignStore from '../../../src/api/src/stores/autonomous-campaign-store';
import { closeDb, getDb } from '../../../src/api/src/stores/db';
import {
  createTask,
  getTask,
  getTasks,
  resetStore,
  updateTask,
} from '../../../src/api/src/stores/task-store';
import {
  listWorkstreams,
} from '../../../src/api/src/stores/workstream-store';
import type { CustomWorld } from '../support/world';

interface CampaignDeliveryCycle extends AutonomousCampaignCycle {
  imageRef?: string;
  previewNamespace?: string;
  previewUrl?: string;
  pullRequestNumber?: number;
}

interface CampaignDeliveryHandoff {
  cycle: CampaignDeliveryCycle;
  workstream: Workstream;
  task: Task;
  replayed: boolean;
}

type CampaignDeliveryOutcome =
  | 'active'
  | 'ready-to-release'
  | 'failed'
  | 'awaiting-merge-confirmation';

interface CampaignDeliveryReconciliation {
  outcome: CampaignDeliveryOutcome;
  cycle: CampaignDeliveryCycle;
  task: Task;
}

interface CampaignCoordinatorTickResult {
  outcome: 'idle' | 'handed-off' | CampaignDeliveryOutcome;
  campaignId?: string;
  cycleId?: string;
  taskId?: string;
}

interface CampaignCoordinator {
  handoffAcceptedProposal(
    campaignId: string,
    cycleId: string,
  ): Promise<CampaignDeliveryHandoff>;
  reconcileDelivery(
    campaignId: string,
    cycleId: string,
  ): Promise<CampaignDeliveryReconciliation>;
  renewLease(campaignId: string): Promise<{
    claimed: boolean;
    leaseOwner?: string;
    leaseExpiresAt?: number;
  }>;
  runOnce(): Promise<CampaignCoordinatorTickResult>;
}

interface CampaignCoordinatorOptions {
  owner: string;
  leaseTtlMs: number;
  now: () => number;
  startTaskPipeline: (taskId: string) => void;
  hooks?: {
    afterWorkstreamCreated?: (workstream: Workstream) => void;
    afterTaskCreated?: (task: Task) => void;
  };
}

interface CampaignCoordinatorModule {
  createAutonomousCampaignCoordinator(
    options: CampaignCoordinatorOptions,
  ): CampaignCoordinator;
}

interface CampaignLinkedTask extends Task {
  campaignCycleId?: string;
}

interface CampaignLinkedWorkstream extends Workstream {
  campaignCycleId?: string;
}

interface ScenarioState {
  dbPath: string;
  previousDefaultAdminPassword?: string;
  repository: string;
  baseBranch: string;
  campaignId?: string;
  cycleId?: string;
  nowMs: number;
  leaseOwner: string;
  module?: CampaignCoordinatorModule;
  handoff?: CampaignDeliveryHandoff;
  replayedHandoff?: CampaignDeliveryHandoff;
  reconciliation?: CampaignDeliveryReconciliation;
  tick?: CampaignCoordinatorTickResult;
  error?: unknown;
  previousLeaseExpiresAt?: number;
  renewedLease?: {
    claimed: boolean;
    leaseOwner?: string;
    leaseExpiresAt?: number;
  };
  startTaskPipelineCalls: string[];
  originalWorkstreamId?: string;
  originalTaskId?: string;
  manualTaskId?: string;
  manualTaskBefore?: Task;
}

const coordinatorModulePath =
  '../../../src/api/src/engine/autonomous-campaign-coordinator';
const scenarioStates = new WeakMap<CustomWorld, ScenarioState>();
const proposal: AcceptedCampaignProposal = {
  candidateId: 'cand-preview-health',
  title: 'Explain failed preview health checks',
  problem:
    'Preview deployments report failed health checks without a clear reason.',
  evidence: ['telemetry: preview health probe failed'],
  targetUsers: ['campaign operators'],
  userValue: 'Operators can diagnose unhealthy previews without searching raw logs.',
  scope: ['show the failed probe', 'link the related runtime log'],
  nonGoals: ['replace preview infrastructure'],
  acceptanceCriteria: [
    'the failed probe name and message are visible',
    'the failure links to its runtime log',
  ],
  affectedComponents: ['src/api/src/engine', 'src/web/app/previews'],
  likelyTests: ['unit coordinator recovery', 'preview diagnostic flow'],
  risks: ['diagnostic text could expose internal details'],
  rollback: 'Disable the diagnostic panel.',
  size: 'medium',
  fingerprint: '0123456789abcdef0123456789abcdef',
  evidenceSnapshotId: 'evidence-cycle-3',
  baseSha: 'abc123def456',
};

function completedPipeline(): PipelineState {
  return {
    runId: 'campaign-cycle-3-run',
    stages: {
      rewrite: 'done',
      plan: 'done',
      critique: 'done',
      implement: 'done',
      build: 'done',
      deploy: 'done',
      validate: 'done',
      review: 'done',
    },
    startedAt: '2026-07-22T11:00:00Z',
    updatedAt: '2026-07-22T11:20:00Z',
  };
}

async function stateFor(world: CustomWorld): Promise<ScenarioState> {
  const existing = scenarioStates.get(world);
  if (existing) return existing;

  closeDb();
  const dbPath = path.join(
    os.tmpdir(),
    `liliput-campaign-handoff-bdd-${process.pid}-${randomUUID()}.db`,
  );
  process.env['DB_PATH'] = dbPath;
  const previousDefaultAdminPassword = process.env['DEFAULT_ADMIN_PASSWORD'];
  process.env['DEFAULT_ADMIN_PASSWORD'] = 'test-only-admin-password';
  campaignStore.resetAutonomousCampaignStore();
  resetStore();
  const state: ScenarioState = {
    dbPath,
    previousDefaultAdminPassword,
    repository: 'crgarcia12/Liliput',
    baseBranch: 'main',
    nowMs: 1_000,
    leaseOwner: 'api-pod-a',
    startTaskPipelineCalls: [],
  };
  scenarioStates.set(world, state);
  return state;
}

async function loadCoordinatorModule(
  state: ScenarioState,
): Promise<CampaignCoordinatorModule> {
  if (state.module) return state.module;
  const loaded: unknown = await import(coordinatorModulePath);
  state.module = loaded as CampaignCoordinatorModule;
  return state.module;
}

async function coordinatorFor(
  state: ScenarioState,
  overrides: Partial<CampaignCoordinatorOptions> = {},
): Promise<CampaignCoordinator> {
  const module = await loadCoordinatorModule(state);
  return module.createAutonomousCampaignCoordinator({
    owner: state.leaseOwner,
    leaseTtlMs: 60_000,
    now: () => state.nowMs,
    startTaskPipeline: (taskId) => {
      state.startTaskPipelineCalls.push(taskId);
    },
    ...overrides,
  });
}

function requireCampaignId(state: ScenarioState): string {
  assert.ok(state.campaignId, 'campaign must exist');
  return state.campaignId;
}

function requireCycleId(state: ScenarioState): string {
  assert.ok(state.cycleId, 'cycle must exist');
  return state.cycleId;
}

function requireTask(state: ScenarioState): Task {
  const taskId = state.handoff?.task.id ?? state.originalTaskId;
  assert.ok(taskId, 'campaign task must exist');
  const task = getTask(taskId);
  assert.ok(task, 'campaign task must be readable');
  return task;
}

function setTaskDeliveryState(
  state: ScenarioState,
  status: Task['status'],
  errorMessage?: string,
): Task {
  const task = requireTask(state);
  const updated = updateTask(task.id, {
    status,
    branch: 'liliput/campaign-cycle-3',
    imageRef: 'crgarliliputacr.azurecr.io/preview:cycle-3',
    devNamespace: 'dev-cycle-3',
    devUrl: 'https://liliput.example/dev/cycle-3',
    pullRequestUrl: 'https://github.com/crgarcia12/Liliput/pull/104',
    pullRequestNumber: 104,
    commitSha: 'reviewed-head',
    pipeline: completedPipeline(),
    ...(status !== 'failed'
      ? {
          campaignReleaseReview: {
            status: 'accepted' as const,
            reviewedSha: 'reviewed-head',
            validationHealthy: true,
            reviewerRan: true,
            reviewedAt: new Date(state.nowMs).toISOString(),
          },
        }
      : {}),
    ...(errorMessage ? { errorMessage } : {}),
  });
  assert.ok(updated, 'campaign task update must succeed');
  return updated;
}

function countRows(table: 'autonomous_cycles' | 'tasks' | 'workstreams'): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .get() as { count: number };
  return row.count;
}

async function handoff(state: ScenarioState): Promise<CampaignDeliveryHandoff> {
  const coordinator = await coordinatorFor(state);
  const result = await coordinator.handoffAcceptedProposal(
    requireCampaignId(state),
    requireCycleId(state),
  );
  state.handoff = result;
  return result;
}

async function reconcile(
  state: ScenarioState,
): Promise<CampaignDeliveryReconciliation> {
  const coordinator = await coordinatorFor(state);
  const result = await coordinator.reconcileDelivery(
    requireCampaignId(state),
    requireCycleId(state),
  );
  state.reconciliation = result;
  return result;
}

After(
  { tags: '@campaign-workstream-handoff' },
  async function (this: CustomWorld) {
    const state = scenarioStates.get(this);
    closeDb();
    if (state?.dbPath) {
      fs.rmSync(state.dbPath, { force: true });
      fs.rmSync(`${state.dbPath}-shm`, { force: true });
      fs.rmSync(`${state.dbPath}-wal`, { force: true });
    }
    process.env['DB_PATH'] = ':memory:';
    if (state?.previousDefaultAdminPassword === undefined) {
      delete process.env['DEFAULT_ADMIN_PASSWORD'];
    } else {
      process.env['DEFAULT_ADMIN_PASSWORD'] =
        state.previousDefaultAdminPassword;
    }
    scenarioStates.delete(this);
  },
);

Given(
  'a coordinator-owned running campaign targets repository {string} and branch {string}',
  async function (
    this: CustomWorld,
    repository: string,
    baseBranch: string,
  ) {
    const state = await stateFor(this);
    state.repository = repository;
    state.baseBranch = baseBranch;
    const campaign = campaignStore.createCampaign({
      repository,
      baseBranch,
      modelConfig: {
        metaAgent: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
        coding: { model: 'gpt-5.6-terra', reasoningEffort: 'high' },
        reviewer: { model: 'gpt-5.6-luna', reasoningEffort: 'medium' },
      },
    });
    const started = campaignStore.transitionCampaign({
      campaignId: campaign.id,
      expectedStatus: 'draft',
      nextStatus: 'running',
      idempotencyKey: `${campaign.id}-start`,
    });
    assert.equal(started.applied, true);
    const lease = campaignStore.claimCampaignLease({
      campaignId: campaign.id,
      owner: state.leaseOwner,
      nowMs: state.nowMs,
      ttlMs: 60_000,
    });
    assert.equal(lease.claimed, true);
    state.campaignId = campaign.id;
  },
);

Given(
  'feature cycle {int} has an accepted proposal for {string}',
  async function (this: CustomWorld, sequence: number, title: string) {
    const state = await stateFor(this);
    assert.equal(title, proposal.title);
    const cycle = campaignStore.createCycle({
      campaignId: requireCampaignId(state),
      sequence,
      title,
      status: 'proposing',
      proposal: proposal as unknown as AutonomousCampaignJsonObject,
      proposalFingerprint: proposal.fingerprint,
      baseSha: proposal.baseSha,
      leaseOwner: state.leaseOwner,
      nowMs: state.nowMs,
    });
    assert.equal(cycle.proposalFingerprint, proposal.fingerprint);
    state.cycleId = cycle.id;
  },
);

When(
  'the coordinator hands the accepted proposal to delivery',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    const result = await handoff(state);
    assert.equal(result.cycle.status, 'delivering');
  },
);

Then(
  'exactly one campaign workstream should exist for feature cycle {int}',
  async function (this: CustomWorld, sequence: number) {
    const state = await stateFor(this);
    assert.equal(sequence, 3);
    assert.equal(countRows('workstreams'), 1);
    const workstream = listWorkstreams(state.repository)[0] as
      | CampaignLinkedWorkstream
      | undefined;
    assert.equal(workstream?.campaignCycleId, requireCycleId(state));
  },
);

Then(
  'exactly one campaign task should exist in that workstream',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    assert.equal(countRows('tasks'), 1);
    const task = requireTask(state) as CampaignLinkedTask;
    assert.equal(task.workstreamId, state.handoff?.workstream.id);
    assert.equal(task.campaignCycleId, requireCycleId(state));
  },
);

Then(
  'the task intent and specification should contain the accepted proposal',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    const task = requireTask(state);
    assert.match(task.description, /failed health checks/i);
    assert.match(task.spec ?? '', /Explain failed preview health checks/);
    assert.match(task.spec ?? '', /failed probe name and message/);
  },
);

Then(
  'feature cycle {int} should retain the workstream and task identifiers',
  async function (this: CustomWorld, sequence: number) {
    const state = await stateFor(this);
    const cycle = campaignStore.getCycle(requireCycleId(state));
    assert.equal(sequence, 3);
    assert.equal(cycle?.workstreamId, state.handoff?.workstream.id);
    assert.equal(cycle?.taskId, state.handoff?.task.id);
  },
);

Given(
  'the accepted proposal has been handed to one campaign task',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    const result = await handoff(state);
    assert.equal(result.task.status, 'building');
    assert.equal(state.startTaskPipelineCalls.length, 1);
  },
);

When(
  'the task reaches the normal review stage',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    const task = setTaskDeliveryState(state, 'review');
    assert.equal(task.status, 'review');
    const result = await reconcile(state);
    assert.equal(result.outcome, 'ready-to-release');
  },
);

Then(
  'the task should have used the existing specification, build, test, preview, and review stages',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    const task = requireTask(state);
    assert.ok(task.spec);
    assert.equal(task.pipeline?.stages.build, 'done');
    assert.equal(task.pipeline?.stages.validate, 'done');
    assert.equal(task.pipeline?.stages.deploy, 'done');
    assert.equal(task.pipeline?.stages.review, 'done');
  },
);

Then(
  'feature cycle {int} should be ready for campaign release review',
  async function (this: CustomWorld, sequence: number) {
    const state = await stateFor(this);
    assert.equal(sequence, 3);
    assert.equal(
      campaignStore.getCycle(requireCycleId(state))?.status,
      'ready_to_release',
    );
  },
);

Then(
  'the cycle should retain its branch, image, preview, and pull request identifiers',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    const cycle = campaignStore.getCycle(
      requireCycleId(state),
    ) as CampaignDeliveryCycle | undefined;
    assert.equal(cycle?.branchName, 'liliput/campaign-cycle-3');
    assert.equal(
      cycle?.imageRef,
      'crgarliliputacr.azurecr.io/preview:cycle-3',
    );
    assert.equal(cycle?.previewNamespace, 'dev-cycle-3');
    assert.equal(cycle?.previewUrl, 'https://liliput.example/dev/cycle-3');
    assert.equal(
      cycle?.pullRequestUrl,
      'https://github.com/crgarcia12/Liliput/pull/104',
    );
    assert.equal(cycle?.pullRequestNumber, 104);
  },
);

Given(
  'the campaign task is still building the accepted feature',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    const result = await handoff(state);
    assert.equal(result.task.status, 'building');
  },
);

When(
  'the coordinator looks for another runnable feature cycle',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    const coordinator = await coordinatorFor(state);
    state.tick = await coordinator.runOnce();
    assert.equal(state.tick.outcome, 'active');
  },
);

Then(
  'feature cycle {int} should remain the campaign\'s only active cycle',
  async function (this: CustomWorld, sequence: number) {
    const state = await stateFor(this);
    const cycle = campaignStore.getCurrentCycle(requireCampaignId(state));
    assert.equal(sequence, 3);
    assert.equal(cycle?.id, requireCycleId(state));
    assert.equal(countRows('autonomous_cycles'), 1);
  },
);

Then(
  'no workstream or task should be created for feature cycle {int}',
  async function (this: CustomWorld, sequence: number) {
    const state = await stateFor(this);
    assert.equal(sequence, 4);
    assert.equal(countRows('workstreams'), 1);
    assert.equal(countRows('tasks'), 1);
    assert.equal(campaignStore.getCampaign(requireCampaignId(state))?.nextSequence, 4);
  },
);

Given(
  'coordinator {string} owns the campaign lease',
  async function (this: CustomWorld, owner: string) {
    const state = await stateFor(this);
    const campaign = campaignStore.getCampaign(requireCampaignId(state));
    assert.equal(owner, state.leaseOwner);
    assert.equal(campaign?.leaseOwner, owner);
    state.previousLeaseExpiresAt = campaign?.leaseExpiresAt;
  },
);

Given(
  'the campaign task is still running',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    const result = await handoff(state);
    assert.equal(result.task.status, 'building');
  },
);

When(
  'coordinator {string} renews the lease during delivery',
  async function (this: CustomWorld, owner: string) {
    const state = await stateFor(this);
    assert.equal(owner, state.leaseOwner);
    state.previousLeaseExpiresAt =
      campaignStore.getCampaign(requireCampaignId(state))?.leaseExpiresAt;
    state.nowMs = 30_000;
    const coordinator = await coordinatorFor(state);
    state.renewedLease = await coordinator.renewLease(
      requireCampaignId(state),
    );
    assert.equal(state.renewedLease.claimed, true);
  },
);

Then(
  'coordinator {string} should remain the active campaign owner',
  async function (this: CustomWorld, owner: string) {
    const state = await stateFor(this);
    assert.equal(state.renewedLease?.leaseOwner, owner);
    assert.equal(
      campaignStore.getCampaign(requireCampaignId(state))?.leaseOwner,
      owner,
    );
  },
);

Then(
  'the renewed lease should expire later than the previous lease',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    assert.ok(state.previousLeaseExpiresAt);
    assert.ok(state.renewedLease?.leaseExpiresAt);
    assert.ok(
      state.renewedLease.leaseExpiresAt > state.previousLeaseExpiresAt,
    );
  },
);

Given(
  'coordinator {string} renewed the campaign lease during delivery',
  async function (this: CustomWorld, owner: string) {
    const state = await stateFor(this);
    await handoff(state);
    state.nowMs = 30_000;
    const coordinator = await coordinatorFor(state, { owner });
    state.renewedLease = await coordinator.renewLease(
      requireCampaignId(state),
    );
    assert.equal(state.renewedLease.claimed, true);
  },
);

When(
  'coordinator {string} tries to advance feature cycle {int} before the renewed lease expires',
  async function (this: CustomWorld, owner: string, sequence: number) {
    const state = await stateFor(this);
    assert.equal(sequence, 3);
    const coordinator = await coordinatorFor(state, { owner });
    try {
      await coordinator.handoffAcceptedProposal(
        requireCampaignId(state),
        requireCycleId(state),
      );
    } catch (error) {
      state.error = error;
    }
    assert.ok(state.error);
  },
);

Then(
  'coordinator {string} should be rejected as a conflicting coordinator',
  async function (this: CustomWorld, owner: string) {
    const state = await stateFor(this);
    assert.equal(owner, 'api-pod-b');
    assert.ok(state.error instanceof Error);
    assert.equal(
      (state.error as Error & { code?: string }).code,
      'CAMPAIGN_CONFLICT',
    );
  },
);

Then(
  'the existing workstream and task should remain unchanged',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    assert.equal(countRows('workstreams'), 1);
    assert.equal(countRows('tasks'), 1);
    assert.equal(getTasks()[0]?.id, state.handoff?.task.id);
  },
);

Given(
  'feature cycle {int} already retains its campaign workstream and task identifiers',
  async function (this: CustomWorld, sequence: number) {
    const state = await stateFor(this);
    const result = await handoff(state);
    assert.equal(sequence, 3);
    assert.equal(result.cycle.workstreamId, result.workstream.id);
    assert.equal(result.cycle.taskId, result.task.id);
    state.originalWorkstreamId = result.workstream.id;
    state.originalTaskId = result.task.id;
  },
);

When(
  'the coordinator hands the accepted proposal to delivery again',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    const coordinator = await coordinatorFor(state);
    state.replayedHandoff = await coordinator.handoffAcceptedProposal(
      requireCampaignId(state),
      requireCycleId(state),
    );
    assert.equal(state.replayedHandoff.replayed, true);
  },
);

Then(
  'the existing campaign workstream should be returned',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    assert.equal(state.replayedHandoff?.workstream.id, state.originalWorkstreamId);
    assert.equal(countRows('workstreams'), 1);
  },
);

Then(
  'the existing campaign task should be returned',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    assert.equal(state.replayedHandoff?.task.id, state.originalTaskId);
    assert.equal(countRows('tasks'), 1);
  },
);

Then(
  'the cycle should still have exactly one workstream and one task',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    const cycle = campaignStore.getCycle(requireCycleId(state));
    assert.equal(cycle?.workstreamId, state.originalWorkstreamId);
    assert.equal(cycle?.taskId, state.originalTaskId);
    assert.equal(countRows('workstreams'), 1);
    assert.equal(countRows('tasks'), 1);
  },
);

Given(
  'delivery stopped after the campaign workstream was created',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    const coordinator = await coordinatorFor(state, {
      hooks: {
        afterWorkstreamCreated: () => {
          assert.fail('fault after workstream creation');
        },
      },
    });
    try {
      await coordinator.handoffAcceptedProposal(
        requireCampaignId(state),
        requireCycleId(state),
      );
    } catch (error) {
      state.error = error;
    }
    assert.match(String(state.error), /fault after workstream creation/);
    const workstream = listWorkstreams(state.repository)[0];
    assert.ok(workstream);
    state.originalWorkstreamId = workstream.id;
  },
);

Given(
  'no campaign task was linked before the control plane stopped',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    assert.equal(countRows('tasks'), 0);
    assert.equal(
      campaignStore.getCycle(requireCycleId(state))?.taskId,
      undefined,
    );
  },
);

When(
  'the Liliput control plane restarts and resumes the handoff',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    closeDb();
    state.module = undefined;
    state.error = undefined;
    const coordinator = await coordinatorFor(state);
    state.handoff = await coordinator.handoffAcceptedProposal(
      requireCampaignId(state),
      requireCycleId(state),
    );
    assert.ok(state.handoff.task.id);
  },
);

Then(
  'the existing campaign workstream should be reused',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    assert.equal(state.handoff?.workstream.id, state.originalWorkstreamId);
    assert.equal(countRows('workstreams'), 1);
  },
);

Then(
  'exactly one campaign task should be created and linked',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    assert.equal(countRows('tasks'), 1);
    assert.equal(
      campaignStore.getCycle(requireCycleId(state))?.taskId,
      state.handoff?.task.id,
    );
  },
);

Then(
  'no replacement workstream should be created',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    assert.equal(countRows('workstreams'), 1);
    assert.equal(listWorkstreams(state.repository)[0]?.id, state.originalWorkstreamId);
  },
);

Given(
  'the campaign task already has a branch, image, preview, and pull request',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    const result = await handoff(state);
    const task = setTaskDeliveryState(state, 'review');
    state.originalTaskId = result.task.id;
    state.originalWorkstreamId = result.workstream.id;
    assert.equal(task.pullRequestNumber, 104);
    assert.ok(task.branch);
    assert.ok(task.imageRef);
    assert.ok(task.devUrl);
  },
);

Given(
  'the control plane stops before feature cycle {int} records those identifiers',
  async function (this: CustomWorld, sequence: number) {
    const state = await stateFor(this);
    assert.equal(sequence, 3);
    getDb()
      .prepare(
        `UPDATE autonomous_cycles
            SET task_id = NULL,
                branch_name = NULL,
                image_ref = NULL,
                preview_namespace = NULL,
                preview_url = NULL,
                pull_request_url = NULL,
                pull_request_number = NULL
          WHERE id = ?`,
      )
      .run(requireCycleId(state));
    const cycle = campaignStore.getCycle(
      requireCycleId(state),
    ) as CampaignDeliveryCycle | undefined;
    assert.equal(cycle?.taskId, undefined);
    assert.equal(cycle?.branchName, undefined);
    closeDb();
  },
);

When(
  'the Liliput control plane restarts and reconciles the active cycle',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    state.module = undefined;
    const coordinator = await coordinatorFor(state);
    state.reconciliation = await coordinator.reconcileDelivery(
      requireCampaignId(state),
      requireCycleId(state),
    );
    assert.ok(state.reconciliation.task.id);
  },
);

Then(
  'the cycle should recover the existing task identifier',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    assert.equal(state.reconciliation?.cycle.taskId, state.originalTaskId);
    assert.equal(countRows('tasks'), 1);
  },
);

Then(
  'the cycle should recover the existing branch, image, preview, and pull request identifiers',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    const cycle = state.reconciliation?.cycle;
    assert.equal(cycle?.branchName, 'liliput/campaign-cycle-3');
    assert.equal(
      cycle?.imageRef,
      'crgarliliputacr.azurecr.io/preview:cycle-3',
    );
    assert.equal(cycle?.previewNamespace, 'dev-cycle-3');
    assert.equal(cycle?.previewUrl, 'https://liliput.example/dev/cycle-3');
    assert.equal(
      cycle?.pullRequestUrl,
      'https://github.com/crgarcia12/Liliput/pull/104',
    );
    assert.equal(cycle?.pullRequestNumber, 104);
  },
);

Then(
  'no second workstream, task, branch, image, preview, or pull request should be created',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    assert.equal(countRows('workstreams'), 1);
    assert.equal(countRows('tasks'), 1);
    assert.equal(state.reconciliation?.cycle.workstreamId, state.originalWorkstreamId);
    assert.equal(state.reconciliation?.cycle.taskId, state.originalTaskId);
  },
);

Given(
  'the campaign task has a healthy preview and is awaiting release review',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    await handoff(state);
    const task = setTaskDeliveryState(state, 'review');
    assert.equal(task.status, 'review');
    assert.ok(task.devUrl);
    assert.equal(task.pipeline?.stages.validate, 'done');
  },
);

When(
  'the coordinator checks the existing task pipeline',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    const result = await reconcile(state);
    assert.ok(result.task.id);
  },
);

Then(
  'the accepted proposal should remain the current campaign feature',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    const cycle = campaignStore.getCurrentCycle(requireCampaignId(state));
    assert.equal(cycle?.id, requireCycleId(state));
    assert.equal(cycle?.proposal?.['fingerprint'], proposal.fingerprint);
  },
);

Then(
  'no next feature cycle should begin',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    assert.equal(countRows('autonomous_cycles'), 1);
    assert.equal(
      campaignStore.getCurrentCycle(requireCampaignId(state))?.id,
      requireCycleId(state),
    );
  },
);

Given(
  'the campaign task reports completed',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    await handoff(state);
    const task = setTaskDeliveryState(state, 'completed');
    assert.equal(task.status, 'completed');
  },
);

Given(
  'the base branch does not contain a confirmed merge for feature cycle {int}',
  async function (this: CustomWorld, sequence: number) {
    const state = await stateFor(this);
    assert.equal(sequence, 3);
    assert.equal(
      campaignStore.getCycle(requireCycleId(state))?.mergeSha,
      undefined,
    );
  },
);

Then(
  'feature cycle {int} should not be marked successful',
  async function (this: CustomWorld, sequence: number) {
    const state = await stateFor(this);
    assert.equal(sequence, 3);
    assert.notEqual(state.reconciliation?.cycle.status, 'succeeded');
    assert.equal(state.reconciliation?.cycle.mergeSha, undefined);
  },
);

Then(
  'the cycle should remain pending campaign release confirmation',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    assert.equal(
      state.reconciliation?.outcome,
      'awaiting-merge-confirmation',
    );
    assert.equal(state.reconciliation?.cycle.status, 'ready_to_release');
    assert.equal(state.reconciliation?.cycle.completedAt, undefined);
  },
);

Given(
  'the campaign task reports a build failure',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    await handoff(state);
    const task = setTaskDeliveryState(
      state,
      'failed',
      'container build exited with code 1',
    );
    assert.equal(task.status, 'failed');
    assert.match(task.errorMessage ?? '', /container build exited/);
  },
);

Then(
  'the delivery failure should be recorded on feature cycle {int}',
  async function (this: CustomWorld, sequence: number) {
    const state = await stateFor(this);
    assert.equal(sequence, 3);
    assert.equal(state.reconciliation?.outcome, 'failed');
    assert.match(
      state.reconciliation?.cycle.lastError ?? '',
      /container build exited/,
    );
  },
);

Then(
  'the accepted proposal, workstream, and task should remain linked',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    const cycle = state.reconciliation?.cycle;
    assert.equal(cycle?.proposal?.['fingerprint'], proposal.fingerprint);
    assert.equal(cycle?.workstreamId, state.handoff?.workstream.id);
    assert.equal(cycle?.taskId, state.handoff?.task.id);
  },
);

Then(
  'no replacement proposal or next feature cycle should be created',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    assert.equal(countRows('autonomous_cycles'), 1);
    assert.equal(
      campaignStore.getCurrentCycle(requireCampaignId(state))?.proposalFingerprint,
      proposal.fingerprint,
    );
  },
);

Given(
  'an operator creates a normal task outside an autonomous campaign',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    const task = createTask(
      'Manual documentation update',
      'Update the operator runbook.',
      state.repository,
      { baseBranch: state.baseBranch, commitMode: 'pr' },
    );
    state.manualTaskId = task.id;
    state.manualTaskBefore = getTask(task.id);
    assert.ok(state.manualTaskBefore);
    assert.equal(
      (state.manualTaskBefore as CampaignLinkedTask).campaignCycleId,
      undefined,
    );
  },
);

When(
  'the campaign coordinator scans for active delivery work',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    const coordinator = await coordinatorFor(state);
    state.tick = await coordinator.runOnce();
    assert.equal(state.tick.outcome, 'handed-off');
  },
);

Then(
  'the manual task should not be claimed by the campaign',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    assert.ok(state.manualTaskId);
    const task = getTask(state.manualTaskId) as CampaignLinkedTask | undefined;
    assert.ok(task);
    assert.equal(task.campaignCycleId, undefined);
    assert.notEqual(task.id, state.tick?.taskId);
  },
);

Then(
  'the manual task should retain its normal workstream and lifecycle',
  async function (this: CustomWorld) {
    const state = await stateFor(this);
    assert.ok(state.manualTaskId);
    const task = getTask(state.manualTaskId);
    assert.equal(task?.status, state.manualTaskBefore?.status);
    assert.equal(task?.workstreamId, state.manualTaskBefore?.workstreamId);
    assert.equal(task?.description, state.manualTaskBefore?.description);
  },
);
