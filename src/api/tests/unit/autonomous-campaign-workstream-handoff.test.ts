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
  AutonomousCampaignCycle,
  AutonomousCampaignJsonObject,
  PipelineState,
  Task,
  Workstream,
} from '../../../../shared/types/index.js';
import type { AcceptedCampaignProposal } from '../../../../shared/types/autonomous-campaign-proposal.js';
import * as campaignStore from '../../src/stores/autonomous-campaign-store.js';
import { closeDb, getDb } from '../../src/stores/db.js';
import {
  createTask,
  getTask,
  getTasks,
  resetStore,
  updateTask,
} from '../../src/stores/task-store.js';
import {
  listWorkstreams,
} from '../../src/stores/workstream-store.js';

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
  resumeTaskPipeline?: (taskId: string) => void;
  prepareProposal?: (
    campaign: AutonomousCampaign,
    cycle: AutonomousCampaignCycle,
  ) => Promise<void>;
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

const coordinatorModulePath =
  '../../src/engine/autonomous-campaign-coordinator.js';
const repository = 'crgarcia12/Liliput';
const baseBranch = 'main';
const leaseOwner = 'api-pod-a';
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

let dbPath = '';
let nowMs = 1_000;
let coordinatorModule: CampaignCoordinatorModule;
let startTaskPipeline: ReturnType<typeof vi.fn<(taskId: string) => void>>;
let previousDefaultAdminPassword: string | undefined;

async function loadCoordinatorModule(): Promise<CampaignCoordinatorModule> {
  const loaded: unknown = await import(coordinatorModulePath);
  return loaded as CampaignCoordinatorModule;
}

function createAcceptedCycle(
  targetRepository = repository,
  targetBaseBranch = baseBranch,
  occurredAt?: string,
): {
  campaignId: string;
  cycleId: string;
} {
  const campaign = campaignStore.createCampaign(
    {
      repository: targetRepository,
      baseBranch: targetBaseBranch,
      modelConfig: {
        metaAgent: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
        coding: { model: 'gpt-5.6-terra', reasoningEffort: 'high' },
        reviewer: { model: 'gpt-5.6-luna', reasoningEffort: 'medium' },
      },
    },
    occurredAt ? { occurredAt } : {},
  );
  campaignStore.transitionCampaign({
    campaignId: campaign.id,
    expectedStatus: 'draft',
    nextStatus: 'running',
    idempotencyKey: `${campaign.id}-start`,
  });
  const lease = campaignStore.claimCampaignLease({
    campaignId: campaign.id,
    owner: leaseOwner,
    nowMs,
    ttlMs: 60_000,
  });
  expect(lease.claimed).toBe(true);
  const cycle = campaignStore.createCycle({
    campaignId: campaign.id,
    sequence: 3,
    title: proposal.title,
    status: 'proposing',
    proposal: proposal as unknown as AutonomousCampaignJsonObject,
    proposalFingerprint: proposal.fingerprint,
    baseSha: proposal.baseSha,
    leaseOwner,
    nowMs,
  });
  return { campaignId: campaign.id, cycleId: cycle.id };
}

function createUnpreparedCycle(
  targetRepository = repository,
  targetBaseBranch = baseBranch,
  occurredAt?: string,
): {
  campaignId: string;
  cycleId: string;
} {
  const campaign = campaignStore.createCampaign(
    {
      repository: targetRepository,
      baseBranch: targetBaseBranch,
      modelConfig: {
        metaAgent: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
        coding: { model: 'gpt-5.6-terra', reasoningEffort: 'high' },
        reviewer: { model: 'gpt-5.6-luna', reasoningEffort: 'medium' },
      },
    },
    occurredAt ? { occurredAt } : {},
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
    title: 'Pending proposal',
    status: 'proposing',
  });
  return { campaignId: campaign.id, cycleId: cycle.id };
}

function createCoordinator(
  overrides: Partial<CampaignCoordinatorOptions> = {},
): CampaignCoordinator {
  return coordinatorModule.createAutonomousCampaignCoordinator({
    owner: leaseOwner,
    leaseTtlMs: 60_000,
    now: () => nowMs,
    startTaskPipeline,
    ...overrides,
  });
}

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

function setTaskDeliveryState(
  taskId: string,
  status: Task['status'],
  errorMessage?: string,
): Task {
  const updated = updateTask(taskId, {
    status,
    branch: 'liliput/campaign-cycle-3',
    imageRef: 'crgarliliputacr.azurecr.io/preview:cycle-3',
    devNamespace: 'dev-cycle-3',
    devUrl: 'https://liliput.example/dev/cycle-3',
    pullRequestUrl: 'https://github.com/crgarcia12/Liliput/pull/104',
    pullRequestNumber: 104,
    pipeline: completedPipeline(),
    ...(errorMessage ? { errorMessage } : {}),
  });
  expect(updated).toBeDefined();
  return updated!;
}

function countRows(table: 'autonomous_cycles' | 'tasks' | 'workstreams'): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .get() as { count: number };
  return row.count;
}

function persistAcceptedProposal(cycleId: string): void {
  getDb()
    .prepare(
      `UPDATE autonomous_cycles
          SET proposal_json = ?,
              proposal_fingerprint = ?,
              base_sha = ?,
              updated_at = ?
        WHERE id = ?`,
    )
    .run(
      JSON.stringify(proposal),
      proposal.fingerprint,
      proposal.baseSha,
      new Date(nowMs).toISOString(),
      cycleId,
    );
}

beforeEach(async () => {
  closeDb();
  dbPath = path.join(
    os.tmpdir(),
    `liliput-campaign-handoff-${process.pid}-${randomUUID()}.db`,
  );
  process.env['DB_PATH'] = dbPath;
  previousDefaultAdminPassword = process.env['DEFAULT_ADMIN_PASSWORD'];
  process.env['DEFAULT_ADMIN_PASSWORD'] = 'test-only-admin-password';
  campaignStore.resetAutonomousCampaignStore();
  resetStore();
  nowMs = 1_000;
  startTaskPipeline = vi.fn();
  coordinatorModule = await loadCoordinatorModule();
});

afterEach(() => {
  closeDb();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  process.env['DB_PATH'] = ':memory:';
  if (previousDefaultAdminPassword === undefined) {
    delete process.env['DEFAULT_ADMIN_PASSWORD'];
  } else {
    process.env['DEFAULT_ADMIN_PASSWORD'] = previousDefaultAdminPassword;
  }
});

describe('autonomous campaign workstream handoff', () => {
  it('should create one workstream and one task from an accepted proposal', async () => {
    const accepted = createAcceptedCycle();
    const result = await createCoordinator().handoffAcceptedProposal(
      accepted.campaignId,
      accepted.cycleId,
    );

    expect(result.replayed).toBe(false);
    expect(countRows('workstreams')).toBe(1);
    expect(countRows('tasks')).toBe(1);
    expect(result.workstream).toMatchObject({
      repository,
      name: proposal.title,
    });
    expect((result.workstream as CampaignLinkedWorkstream).campaignCycleId).toBe(
      accepted.cycleId,
    );
    expect(result.task).toMatchObject({
      title: proposal.title,
      repository,
      baseBranch,
      commitMode: 'pr',
      status: 'building',
      workstreamId: result.workstream.id,
      model: 'gpt-5.6-terra',
      reasoningEffort: 'high',
      reviewerModel: 'gpt-5.6-luna',
      reviewerReasoningEffort: 'medium',
      reviewerEnabled: true,
    });
    expect((result.task as CampaignLinkedTask).campaignCycleId).toBe(
      accepted.cycleId,
    );
    expect(result.task.description).toContain(proposal.problem);
    expect(result.task.spec).toContain(proposal.title);
    expect(result.task.spec).toContain(proposal.acceptanceCriteria[0]);
    expect(result.cycle).toMatchObject({
      id: accepted.cycleId,
      status: 'delivering',
      workstreamId: result.workstream.id,
      taskId: result.task.id,
    });
    expect(startTaskPipeline).toHaveBeenCalledTimes(1);
    expect(startTaskPipeline).toHaveBeenCalledWith(result.task.id);
  });

  it('should return the same local resources when handoff is replayed', async () => {
    const accepted = createAcceptedCycle();
    const coordinator = createCoordinator();
    const first = await coordinator.handoffAcceptedProposal(
      accepted.campaignId,
      accepted.cycleId,
    );
    const second = await coordinator.handoffAcceptedProposal(
      accepted.campaignId,
      accepted.cycleId,
    );

    expect(second.replayed).toBe(true);
    expect(second.workstream.id).toBe(first.workstream.id);
    expect(second.task.id).toBe(first.task.id);
    expect(countRows('workstreams')).toBe(1);
    expect(countRows('tasks')).toBe(1);
    expect(startTaskPipeline).toHaveBeenCalledTimes(1);
  });

  it('should keep the current cycle serial while its task is active', async () => {
    const accepted = createAcceptedCycle();
    const coordinator = createCoordinator();
    const handoff = await coordinator.handoffAcceptedProposal(
      accepted.campaignId,
      accepted.cycleId,
    );

    const tick = await coordinator.runOnce();

    expect(tick).toMatchObject({
      outcome: 'active',
      campaignId: accepted.campaignId,
      cycleId: accepted.cycleId,
      taskId: handoff.task.id,
    });
    expect(campaignStore.getCurrentCycle(accepted.campaignId)?.id).toBe(
      accepted.cycleId,
    );
    expect(countRows('autonomous_cycles')).toBe(1);
    expect(countRows('workstreams')).toBe(1);
    expect(countRows('tasks')).toBe(1);
  });

  it('should keep a cluster outage paused until its durable retry time', async () => {
    const accepted = createAcceptedCycle();
    const resumeTaskPipeline = vi.fn<(taskId: string) => void>();
    const coordinator = createCoordinator({ resumeTaskPipeline });
    const handoff = await coordinator.handoffAcceptedProposal(
      accepted.campaignId,
      accepted.cycleId,
    );
    updateTask(handoff.task.id, {
      status: 'deploying',
      branch: 'liliput/campaign-cycle-3',
    });
    const retryAt = nowMs + 60_000;
    getDb()
      .prepare(
        `UPDATE autonomous_cycles
            SET status = 'waiting_for_external',
                last_error = ?
          WHERE id = ?`,
      )
      .run(
        `kubernetes-cluster-unavailable-until=${retryAt}:connect ECONNREFUSED`,
        accepted.cycleId,
      );
    getDb()
      .prepare(
        `UPDATE autonomous_attempts
            SET active_started_at = NULL
          WHERE cycle_id = ?`,
      )
      .run(accepted.cycleId);
    startTaskPipeline.mockClear();

    nowMs = retryAt - 1;
    expect(await coordinator.runOnce()).toMatchObject({ outcome: 'idle' });
    expect(resumeTaskPipeline).not.toHaveBeenCalled();

    nowMs = retryAt;
    expect(await coordinator.runOnce()).toMatchObject({
      outcome: 'handed-off',
      taskId: handoff.task.id,
    });
    expect(resumeTaskPipeline).toHaveBeenCalledWith(handoff.task.id);
    expect(campaignStore.getCycle(accepted.cycleId)?.status).toBe('delivering');
  });

  it('should renew the same coordinator lease while delivery is active', async () => {
    const accepted = createAcceptedCycle();
    const coordinator = createCoordinator();
    await coordinator.handoffAcceptedProposal(
      accepted.campaignId,
      accepted.cycleId,
    );
    const before = campaignStore.getCampaign(accepted.campaignId);
    nowMs = 30_000;

    const renewed = await coordinator.renewLease(accepted.campaignId);

    expect(renewed.claimed).toBe(true);
    expect(renewed.leaseOwner).toBe(leaseOwner);
    expect(renewed.leaseExpiresAt).toBeGreaterThan(before?.leaseExpiresAt ?? 0);
  });

  it('should reject another coordinator while the renewed lease is active', async () => {
    const accepted = createAcceptedCycle();
    const first = createCoordinator();
    await first.handoffAcceptedProposal(accepted.campaignId, accepted.cycleId);
    nowMs = 30_000;
    await first.renewLease(accepted.campaignId);
    const second = createCoordinator({ owner: 'api-pod-b' });

    await expect(
      second.handoffAcceptedProposal(accepted.campaignId, accepted.cycleId),
    ).rejects.toMatchObject({ code: 'CAMPAIGN_CONFLICT' });
    expect(countRows('workstreams')).toBe(1);
    expect(countRows('tasks')).toBe(1);
  });

  it('should reuse a committed workstream after a crash boundary', async () => {
    const accepted = createAcceptedCycle();
    const crashing = createCoordinator({
      hooks: {
        afterWorkstreamCreated: () => {
          throw new Error('fault after workstream creation');
        },
      },
    });

    await expect(
      crashing.handoffAcceptedProposal(accepted.campaignId, accepted.cycleId),
    ).rejects.toThrow('fault after workstream creation');
    expect(countRows('workstreams')).toBe(1);
    expect(countRows('tasks')).toBe(0);
    const existingWorkstream = listWorkstreams(repository)[0];

    const recovered = await createCoordinator().handoffAcceptedProposal(
      accepted.campaignId,
      accepted.cycleId,
    );

    expect(recovered.workstream.id).toBe(existingWorkstream?.id);
    expect(countRows('workstreams')).toBe(1);
    expect(countRows('tasks')).toBe(1);
  });

  it('should recover a committed task when the cycle link was not persisted', async () => {
    const accepted = createAcceptedCycle();
    const crashing = createCoordinator({
      hooks: {
        afterTaskCreated: () => {
          throw new Error('fault after task creation');
        },
      },
    });

    await expect(
      crashing.handoffAcceptedProposal(accepted.campaignId, accepted.cycleId),
    ).rejects.toThrow('fault after task creation');
    expect(countRows('workstreams')).toBe(1);
    expect(countRows('tasks')).toBe(1);
    expect(campaignStore.getCycle(accepted.cycleId)?.taskId).toBeUndefined();
    const existingTask = getTasks()[0];

    const recovered = await createCoordinator().handoffAcceptedProposal(
      accepted.campaignId,
      accepted.cycleId,
    );

    expect(recovered.task.id).toBe(existingTask?.id);
    expect(countRows('tasks')).toBe(1);
    expect(startTaskPipeline).toHaveBeenCalledTimes(1);
  });

  it('should recover branch image preview and pull request identifiers after restart', async () => {
    const accepted = createAcceptedCycle();
    const firstCoordinator = createCoordinator();
    const handoff = await firstCoordinator.handoffAcceptedProposal(
      accepted.campaignId,
      accepted.cycleId,
    );
    setTaskDeliveryState(handoff.task.id, 'review');
    getDb()
      .prepare(
        `UPDATE autonomous_cycles
            SET branch_name = NULL,
                image_ref = NULL,
                preview_namespace = NULL,
                preview_url = NULL,
                pull_request_url = NULL,
                pull_request_number = NULL
          WHERE id = ?`,
      )
      .run(accepted.cycleId);

    closeDb();
    const restartedCoordinator = createCoordinator();
    const reconciled = await restartedCoordinator.reconcileDelivery(
      accepted.campaignId,
      accepted.cycleId,
    );

    expect(reconciled.cycle).toMatchObject({
      taskId: handoff.task.id,
      branchName: 'liliput/campaign-cycle-3',
      imageRef: 'crgarliliputacr.azurecr.io/preview:cycle-3',
      previewNamespace: 'dev-cycle-3',
      previewUrl: 'https://liliput.example/dev/cycle-3',
      pullRequestUrl: 'https://github.com/crgarcia12/Liliput/pull/104',
      pullRequestNumber: 104,
    });
    expect(countRows('workstreams')).toBe(1);
    expect(countRows('tasks')).toBe(1);
  });

  it('should mark a cycle ready to release when the existing task reaches review', async () => {
    const accepted = createAcceptedCycle();
    const coordinator = createCoordinator();
    const handoff = await coordinator.handoffAcceptedProposal(
      accepted.campaignId,
      accepted.cycleId,
    );
    setTaskDeliveryState(handoff.task.id, 'review');

    const reconciled = await coordinator.reconcileDelivery(
      accepted.campaignId,
      accepted.cycleId,
    );

    expect(reconciled.outcome).toBe('ready-to-release');
    expect(reconciled.cycle.status).toBe('ready_to_release');
    expect(reconciled.cycle.taskId).toBe(handoff.task.id);
    expect(campaignStore.getCurrentCycle(accepted.campaignId)?.id).toBe(
      accepted.cycleId,
    );
  });

  it('should not treat completed task status as confirmed merge success', async () => {
    const accepted = createAcceptedCycle();
    const coordinator = createCoordinator();
    const handoff = await coordinator.handoffAcceptedProposal(
      accepted.campaignId,
      accepted.cycleId,
    );
    setTaskDeliveryState(handoff.task.id, 'completed');

    const reconciled = await coordinator.reconcileDelivery(
      accepted.campaignId,
      accepted.cycleId,
    );

    expect(reconciled.outcome).toBe('awaiting-merge-confirmation');
    expect(reconciled.cycle.status).toBe('ready_to_release');
    expect(reconciled.cycle.mergeSha).toBeUndefined();
    expect(reconciled.cycle.completedAt).toBeUndefined();
    expect(countRows('autonomous_cycles')).toBe(1);
  });

  it('should retain the same feature and local resources when delivery fails', async () => {
    const accepted = createAcceptedCycle();
    const coordinator = createCoordinator();
    const handoff = await coordinator.handoffAcceptedProposal(
      accepted.campaignId,
      accepted.cycleId,
    );
    setTaskDeliveryState(
      handoff.task.id,
      'failed',
      'container build exited with code 1',
    );

    const reconciled = await coordinator.reconcileDelivery(
      accepted.campaignId,
      accepted.cycleId,
    );

    expect(reconciled.outcome).toBe('failed');
    expect(reconciled.cycle.status).toBe('delivering');
    expect(reconciled.cycle.lastError).toContain(
      'container build exited with code 1',
    );
    expect(reconciled.cycle.proposal?.['fingerprint']).toBe(
      proposal.fingerprint,
    );
    expect(reconciled.cycle.workstreamId).toBe(handoff.workstream.id);
    expect(reconciled.cycle.taskId).toBe(handoff.task.id);
    expect(countRows('autonomous_cycles')).toBe(1);
  });

  it('should leave manually created tasks outside campaign coordination', async () => {
    const manual = createTask(
      'Manual documentation update',
      'Update the operator runbook.',
      repository,
      { baseBranch, commitMode: 'pr' },
    );
    const before = getTask(manual.id);

    const tick = await createCoordinator().runOnce();

    expect(tick.outcome).toBe('idle');
    expect(getTask(manual.id)).toMatchObject({
      id: manual.id,
      status: before?.status,
      workstreamId: before?.workstreamId,
      description: before?.description,
    });
    expect(startTaskPipeline).not.toHaveBeenCalled();
  });

  it('should discover and hand off one accepted cycle from a coordinator tick', async () => {
    const accepted = createAcceptedCycle();

    const tick = await createCoordinator().runOnce();

    expect(tick).toMatchObject({
      outcome: 'handed-off',
      campaignId: accepted.campaignId,
      cycleId: accepted.cycleId,
    });
    expect(countRows('workstreams')).toBe(1);
    expect(countRows('tasks')).toBe(1);
    expect(startTaskPipeline).toHaveBeenCalledTimes(1);
  });

  it('should prepare then hand off a newly started proposing cycle', async () => {
    const started = createUnpreparedCycle();
    const prepareProposal = vi.fn(
      async (
        _campaign: AutonomousCampaign,
        cycle: AutonomousCampaignCycle,
      ): Promise<void> => {
        persistAcceptedProposal(cycle.id);
      },
    );
    const coordinator = createCoordinator({ prepareProposal });

    const preparationTick = await coordinator.runOnce();

    expect(prepareProposal).toHaveBeenCalledWith(
      expect.objectContaining({ id: started.campaignId, status: 'running' }),
      expect.objectContaining({ id: started.cycleId, status: 'proposing' }),
    );
    expect(preparationTick).toMatchObject({
      outcome: 'idle',
      campaignId: started.campaignId,
      cycleId: started.cycleId,
    });
    await vi.waitFor(() => {
      expect(campaignStore.getCycle(started.cycleId)?.proposal).toBeDefined();
    });

    const handoffTick = await coordinator.runOnce();

    expect(handoffTick).toMatchObject({
      outcome: 'handed-off',
      campaignId: started.campaignId,
      cycleId: started.cycleId,
    });
    expect(countRows('workstreams')).toBe(1);
    expect(countRows('tasks')).toBe(1);
    expect(startTaskPipeline).toHaveBeenCalledTimes(1);
  });

  it('should keep coordinating other campaigns while a proposal is prepared', async () => {
    const started = createUnpreparedCycle(
      repository,
      baseBranch,
      '2026-07-23T12:00:00Z',
    );
    const accepted = createAcceptedCycle(
      'crgarcia12/another-repository',
      baseBranch,
      '2026-07-23T12:00:01Z',
    );
    let finishProposal: (() => void) | undefined;
    const preparationFinished = new Promise<void>((resolvePreparation) => {
      finishProposal = () => {
        persistAcceptedProposal(started.cycleId);
        resolvePreparation();
      };
    });
    const prepareProposal = vi.fn(async (): Promise<void> => preparationFinished);
    const coordinator = createCoordinator({ prepareProposal });

    const preparationTick = await coordinator.runOnce();
    const deliveryTick = await coordinator.runOnce();

    expect(preparationTick).toMatchObject({
      outcome: 'idle',
      campaignId: started.campaignId,
      cycleId: started.cycleId,
    });
    expect(deliveryTick).toMatchObject({
      outcome: 'handed-off',
      campaignId: accepted.campaignId,
      cycleId: accepted.cycleId,
    });
    expect(prepareProposal).toHaveBeenCalledTimes(1);
    expect(countRows('workstreams')).toBe(1);
    expect(countRows('tasks')).toBe(1);

    finishProposal?.();
    await preparationFinished;
    await vi.waitFor(() => {
      expect(campaignStore.getCycle(started.cycleId)?.proposal).toBeDefined();
    });
  });

  it('should renew the campaign lease while proposal preparation is active', async () => {
    vi.useFakeTimers();
    try {
      const started = createUnpreparedCycle();
      let finishProposal: (() => void) | undefined;
      const prepareProposal = vi.fn(
        async (
          _campaign: AutonomousCampaign,
          cycle: AutonomousCampaignCycle,
        ): Promise<void> =>
          new Promise<void>((resolve) => {
            finishProposal = () => {
              persistAcceptedProposal(cycle.id);
              resolve();
            };
          }),
      );
      const coordinator = createCoordinator({
        leaseTtlMs: 60,
        prepareProposal,
      });

      await coordinator.runOnce();
      await vi.advanceTimersByTimeAsync(0);
      expect(prepareProposal).toHaveBeenCalledTimes(1);
      const initialLease = campaignStore.getCampaign(started.campaignId);

      nowMs = 1_020;
      await vi.advanceTimersByTimeAsync(20);
      const renewedLease = campaignStore.getCampaign(started.campaignId);

      expect(renewedLease?.leaseExpiresAt).toBeGreaterThan(
        initialLease?.leaseExpiresAt ?? 0,
      );
      expect(finishProposal).toBeDefined();
      finishProposal?.();
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
