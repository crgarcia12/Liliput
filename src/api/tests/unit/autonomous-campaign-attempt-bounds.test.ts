import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type {
  AutonomousCampaign,
  AutonomousCampaignAttempt,
  AutonomousCampaignBudgetReason,
  AutonomousCampaignCycle,
  AutonomousCampaignJsonObject,
} from '../../../../shared/types/index.js';
import * as campaignStore from '../../src/stores/autonomous-campaign-store.js';
import { closeDb, getDb } from '../../src/stores/db.js';
import {
  createTask,
  resetStore,
  updateTask,
} from '../../src/stores/task-store.js';

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

interface Scenario {
  campaignId: string;
  cycleId: string;
  taskId: string;
  attemptId: string;
  proposal: AutonomousCampaignJsonObject;
}

const attemptManagerModulePath =
  '../../src/engine/autonomous-campaign-attempt-manager.js';
const owner = 'api-pod-a';
const proposal: AutonomousCampaignJsonObject = {
  title: 'Explain failed preview health checks',
  fingerprint: 'attempt-bounds-proposal',
};

let dbPath = '';
let nowMs = 1_000;
let interruptTask: ReturnType<
  typeof vi.fn<(taskId: string, reason: 'pause' | 'stop') => void>
>;
let module: CampaignAttemptManagerModule;

async function loadAttemptManager(): Promise<CampaignAttemptManagerModule> {
  const loaded: unknown = await import(attemptManagerModulePath);
  return loaded as CampaignAttemptManagerModule;
}

function createManager(): CampaignAttemptManager {
  return module.createAutonomousCampaignAttemptManager({
    owner,
    now: () => nowMs,
    interruptTask,
  });
}

function createScenario(): Scenario {
  const campaign = campaignStore.createCampaign({
    repository: 'crgarcia12/Liliput',
    baseBranch: 'main',
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
    nowMs,
  });
  const lease = campaignStore.claimCampaignLease({
    campaignId: campaign.id,
    owner,
    nowMs,
    ttlMs: 24 * 60 * 60_000,
  });
  expect(lease.claimed).toBe(true);
  const cycle = campaignStore.createCycle({
    campaignId: campaign.id,
    sequence: 5,
    title: 'Explain failed preview health checks',
    status: 'delivering',
    proposal,
    proposalFingerprint: 'attempt-bounds-proposal',
    baseSha: 'abc123def456',
    leaseOwner: owner,
    nowMs,
  });
  const task = createTask(
    'Explain failed preview health checks',
    'Expose failed preview probe evidence.',
    'crgarcia12/Liliput',
    {
      baseBranch: 'main',
      commitMode: 'pr',
      campaignCycleId: cycle.id,
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
    campaignId: campaign.id,
    cycleId: cycle.id,
    leaseOwner: owner,
    nowMs,
    taskId: task.id,
    branchName: 'liliput/campaign-cycle-5',
    imageRef: 'crgarliliputacr.azurecr.io/preview:cycle-5',
    previewNamespace: 'dev-cycle-5',
    previewUrl: 'https://liliput.example/dev/cycle-5',
    pullRequestUrl: 'https://github.com/crgarcia12/Liliput/pull/205',
    pullRequestNumber: 205,
  });
  const attempt = campaignStore.createAttempt({
    cycleId: cycle.id,
    attemptNumber: 2,
    status: 'running',
    idempotencyKey: `${cycle.id}-attempt-2`,
    leaseOwner: owner,
    nowMs,
  });
  return {
    campaignId: campaign.id,
    cycleId: cycle.id,
    taskId: task.id,
    attemptId: attempt.id,
    proposal,
  };
}

function updateAttempt(
  attemptId: string,
  values: {
    turnsUsed?: number;
    elapsedMs?: number;
    estimatedCostUsd?: number;
  },
): void {
  getDb()
    .prepare(
      `UPDATE autonomous_attempts
          SET turns_used = COALESCE(?, turns_used),
              elapsed_ms = COALESCE(?, elapsed_ms),
              estimated_cost_usd = COALESCE(?, estimated_cost_usd)
        WHERE id = ?`,
    )
    .run(
      values.turnsUsed ?? null,
      values.elapsedMs ?? null,
      values.estimatedCostUsd ?? null,
      attemptId,
    );
}

beforeEach(async () => {
  closeDb();
  dbPath = path.join(
    os.tmpdir(),
    `liliput-attempt-bounds-${process.pid}-${randomUUID()}.db`,
  );
  process.env['DB_PATH'] = dbPath;
  process.env['DEFAULT_ADMIN_PASSWORD'] = 'test-only-admin-password';
  campaignStore.resetAutonomousCampaignStore();
  resetStore();
  nowMs = 1_000;
  interruptTask = vi.fn();
  module = await loadAttemptManager();
});

afterEach(() => {
  closeDb();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  process.env['DB_PATH'] = ':memory:';
});

describe('autonomous campaign attempt bounds', () => {
  it.each([
    {
      name: 'turn count',
      reason: 'turns' as const,
      usage: { turnsUsed: 500 },
    },
    {
      name: 'elapsed time',
      reason: 'time' as const,
      usage: { elapsedMs: 240 * 60_000 },
    },
    {
      name: 'estimated cost',
      reason: 'cost' as const,
      usage: { estimatedCostUsd: 250 },
    },
  ])('should block another model action at the $name limit', ({ reason, usage }) => {
    const scenario = createScenario();
    updateAttempt(scenario.attemptId, usage);

    const result = createManager().evaluateBeforeAction(
      scenario.campaignId,
      scenario.cycleId,
      'agent-turn',
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe(reason);
    expect(result.attempt.status).toBe('failed');
    expect(result.attempt.failureMessage).toContain(`attempt-limit:${reason}`);
    expect(result.cycle.status).toBe('retry_wait');
    expect(result.cycle.nextRetryAt).toBeDefined();
  });

  it('should allow another action while every snapshotted limit has capacity', () => {
    const scenario = createScenario();
    updateAttempt(scenario.attemptId, {
      turnsUsed: 499,
      elapsedMs: 240 * 60_000 - 2,
      estimatedCostUsd: 249.99,
    });

    const result = createManager().evaluateBeforeAction(
      scenario.campaignId,
      scenario.cycleId,
      'agent-turn',
    );

    expect(result.allowed).toBe(true);
    expect(result.attempt.status).toBe('running');
    expect(result.cycle.status).toBe('delivering');
  });

  it('should record failure evidence and retry the same accepted proposal', () => {
    const scenario = createScenario();
    const manager = createManager();
    manager.recordUsage(scenario.campaignId, scenario.cycleId, {
      usageEventId: 'usage-build-2',
      turns: 3,
      estimatedCostUsd: 12.5,
    });
    nowMs += 45_000;

    const failed = manager.failAttempt(
      scenario.campaignId,
      scenario.cycleId,
      {
        stage: 'build',
        message: 'npm test exited with code 1',
      },
    );

    expect(failed.attempt).toMatchObject({
      status: 'failed',
      turnsUsed: 3,
      estimatedCostUsd: 12.5,
      failureStage: 'build',
      failureMessage: 'npm test exited with code 1',
    });
    expect(failed.attempt.elapsedMs).toBeGreaterThanOrEqual(45_000);
    expect(failed.cycle).toMatchObject({
      status: 'retry_wait',
      proposal: scenario.proposal,
      taskId: scenario.taskId,
      branchName: 'liliput/campaign-cycle-5',
      retryDelayMinutes: 1,
    });
  });

  it('should cap repeated retry delay while keeping another attempt eligible', () => {
    const scenario = createScenario();
    getDb()
      .prepare(
        `UPDATE autonomous_cycles
            SET retry_delay_minutes = 60
          WHERE id = ?`,
      )
      .run(scenario.cycleId);

    const failed = createManager().failAttempt(
      scenario.campaignId,
      scenario.cycleId,
      {
        stage: 'deployment',
        message: 'preview rollout timed out',
      },
    );

    expect(failed.cycle.retryDelayMinutes).toBe(60);
    expect(failed.cycle.nextRetryAt).toBeDefined();
    nowMs += 60 * 60_000;
    const retry = createManager().startDueRetry(
      scenario.campaignId,
      scenario.cycleId,
    );
    expect(retry.started).toBe(true);
    expect(retry.attempt?.attemptNumber).toBe(3);
    expect(retry.cycle.status).toBe('delivering');
  });

  it('should exclude an external wait from turns, cost, and active elapsed time', () => {
    const scenario = createScenario();
    const manager = createManager();
    const before = manager.recordUsage(
      scenario.campaignId,
      scenario.cycleId,
      {
        usageEventId: 'usage-before-external-wait',
        turns: 2,
        estimatedCostUsd: 4,
      },
    );

    const waiting = manager.waitForExternal(
      scenario.campaignId,
      scenario.cycleId,
      {
        stage: 'deployment',
        message: 'preview cluster is unavailable',
      },
    );
    nowMs += 30 * 60_000;
    const resumed = manager.resumeExternalWait(
      scenario.campaignId,
      scenario.cycleId,
    );

    expect(waiting.cycle.status).toBe('waiting_for_external');
    expect(waiting.attempt.activeStartedAt).toBeUndefined();
    expect(resumed.attempt.id).toBe(before.id);
    expect(resumed.attempt.turnsUsed).toBe(before.turnsUsed);
    expect(resumed.attempt.estimatedCostUsd).toBe(before.estimatedCostUsd);
    expect(resumed.attempt.elapsedMs).toBe(waiting.attempt.elapsedMs);
    expect(resumed.cycle.status).toBe('delivering');
  });

  it('should interrupt the task and preserve delivery evidence when paused', () => {
    const scenario = createScenario();

    const paused = createManager().pause(
      scenario.campaignId,
      scenario.cycleId,
    );

    expect(interruptTask).toHaveBeenCalledWith(scenario.taskId, 'pause');
    expect(paused.campaign.status).toBe('paused');
    expect(paused.cycle).toMatchObject({
      status: 'paused',
      proposal: scenario.proposal,
      taskId: scenario.taskId,
      branchName: 'liliput/campaign-cycle-5',
      imageRef: 'crgarliliputacr.azurecr.io/preview:cycle-5',
      previewNamespace: 'dev-cycle-5',
      pullRequestNumber: 205,
    });
    expect(paused.attempt.status).toBe('paused');
  });

  it('should resume the same paused attempt after a manager restart', () => {
    const scenario = createScenario();
    const firstManager = createManager();
    const paused = firstManager.pause(
      scenario.campaignId,
      scenario.cycleId,
    );
    nowMs += 10 * 60_000;

    const resumed = createManager().resume(
      scenario.campaignId,
      scenario.cycleId,
    );

    expect(resumed.campaign.status).toBe('running');
    expect(resumed.cycle.status).toBe('delivering');
    expect(resumed.attempt.id).toBe(paused.attempt.id);
    expect(resumed.attempt.attemptNumber).toBe(2);
    expect(resumed.attempt.status).toBe('running');
    expect(resumed.attempt.activeStartedAt).toBeDefined();
    expect(campaignStore.listAttempts(scenario.cycleId)).toHaveLength(1);
  });

  it('should prevent future retry or cycle work after stop', () => {
    const scenario = createScenario();
    const manager = createManager();
    manager.failAttempt(scenario.campaignId, scenario.cycleId, {
      stage: 'review',
      message: 'reviewer rejected the attempt',
    });

    const stopped = manager.stop(scenario.campaignId, scenario.cycleId);
    nowMs += 24 * 60 * 60_000;
    const retry = manager.startDueRetry(
      scenario.campaignId,
      scenario.cycleId,
    );

    expect(interruptTask).toHaveBeenCalledWith(scenario.taskId, 'stop');
    expect(stopped.campaign.status).toBe('stopped');
    expect(stopped.cycle.status).toBe('stopped');
    expect(stopped.cycle.nextRetryAt).toBeUndefined();
    expect(stopped.attempt.status).toBe('stopped');
    expect(retry.started).toBe(false);
    expect(campaignStore.listAttempts(scenario.cycleId)).toHaveLength(1);
  });

  it('should create exactly one attempt when a persisted retry becomes due', () => {
    const scenario = createScenario();
    const manager = createManager();
    const failed = manager.failAttempt(
      scenario.campaignId,
      scenario.cycleId,
      {
        stage: 'build',
        message: 'compiler failed',
      },
    );
    expect(failed.cycle.nextRetryAt).toBeDefined();
    nowMs = Date.parse(failed.cycle.nextRetryAt!);

    const first = createManager().startDueRetry(
      scenario.campaignId,
      scenario.cycleId,
    );
    const replay = createManager().startDueRetry(
      scenario.campaignId,
      scenario.cycleId,
    );

    expect(first.started).toBe(true);
    expect(first.attempt?.attemptNumber).toBe(3);
    expect(first.cycle).toMatchObject({
      status: 'delivering',
      proposal: scenario.proposal,
      taskId: scenario.taskId,
      branchName: 'liliput/campaign-cycle-5',
    });
    expect(replay.started).toBe(false);
    expect(replay.attempt?.id).toBe(first.attempt?.id);
    expect(campaignStore.listAttempts(scenario.cycleId)).toHaveLength(2);
  });

  it('should retain exact failure stage, message, timestamp, and usage', () => {
    const scenario = createScenario();
    const manager = createManager();
    manager.recordUsage(scenario.campaignId, scenario.cycleId, {
      usageEventId: 'usage-deploy-2',
      turns: 4,
      estimatedCostUsd: 8.75,
    });
    nowMs += 90_000;

    const result = manager.failAttempt(
      scenario.campaignId,
      scenario.cycleId,
      {
        stage: 'deployment',
        message: 'AKS API returned DNS failure',
      },
    );

    expect(result.attempt.status).toBe('failed');
    expect(result.attempt.failureStage).toBe('deployment');
    expect(result.attempt.failureMessage).toBe(
      'AKS API returned DNS failure',
    );
    expect(result.attempt.completedAt).toBe(new Date(nowMs).toISOString());
    expect(result.attempt.turnsUsed).toBe(4);
    expect(result.attempt.estimatedCostUsd).toBe(8.75);
    expect(result.cycle.status).not.toBe('succeeded');
  });

  it('should snapshot limits per attempt and apply changes only to the next attempt', () => {
    const scenario = createScenario();
    const manager = createManager();
    const current = campaignStore.getAttempt(
      scenario.attemptId,
    ) as BoundedCampaignAttempt;
    expect(current).toMatchObject({
      maxTurns: 500,
      maxElapsedMs: 240 * 60_000,
      maxEstimatedCostUsd: 250,
    });
    getDb()
      .prepare(
        `UPDATE autonomous_campaigns
            SET max_turns_per_attempt = 100,
                max_minutes_per_attempt = 60,
                max_cost_usd_per_attempt = 25
          WHERE id = ?`,
      )
      .run(scenario.campaignId);
    const failed = manager.failAttempt(
      scenario.campaignId,
      scenario.cycleId,
      {
        stage: 'build',
        message: 'retry with lower limits',
      },
    );
    nowMs = Date.parse(failed.cycle.nextRetryAt!);

    const retry = manager.startDueRetry(
      scenario.campaignId,
      scenario.cycleId,
    );

    expect(failed.attempt).toMatchObject({
      maxTurns: 500,
      maxElapsedMs: 240 * 60_000,
      maxEstimatedCostUsd: 250,
    });
    expect(retry.attempt).toMatchObject({
      maxTurns: 100,
      maxElapsedMs: 60 * 60_000,
      maxEstimatedCostUsd: 25,
    });
  });
});
