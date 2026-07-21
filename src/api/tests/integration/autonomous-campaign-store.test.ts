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
} from 'vitest';
import { closeDb } from '../../src/stores/db.js';
import {
  createTask,
  getTask,
  resetStore,
} from '../../src/stores/task-store.js';
import {
  createWorkstream,
  getWorkstream,
} from '../../src/stores/workstream-store.js';

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
  getCurrentCycle(campaignId: string): CycleRecord | undefined;
  createAttempt(input: {
    cycleId: string;
    attemptNumber: number;
    status?: AttemptStatus;
    idempotencyKey: string;
  }): AttemptRecord;
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

const campaignStoreModulePath =
  '../../src/stores/autonomous-campaign-store.js';

let dbPath = '';
let store: CampaignStoreModule;

async function loadCampaignStore(): Promise<CampaignStoreModule> {
  const loaded: unknown = await import(campaignStoreModulePath);
  return loaded as CampaignStoreModule;
}

function isConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as Error & { code?: unknown }).code === 'CAMPAIGN_CONFLICT'
  );
}

function startCampaign(
  campaign: CampaignRecord,
  suffix = 'start',
): CampaignRecord {
  const result = store.transitionCampaign({
    campaignId: campaign.id,
    expectedStatus: 'draft',
    nextStatus: 'running',
    idempotencyKey: `${campaign.id}-${suffix}`,
  });
  expect(result.applied).toBe(true);
  return result.campaign;
}

beforeEach(async () => {
  closeDb();
  dbPath = path.join(
    os.tmpdir(),
    `liliput-autonomous-campaign-vitest-${process.pid}-${randomUUID()}.db`,
  );
  process.env['DB_PATH'] = dbPath;
  store = await loadCampaignStore();
  resetStore();
  store.resetAutonomousCampaignStore();
});

afterEach(() => {
  closeDb();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  process.env['DB_PATH'] = ':memory:';
});

describe('autonomous campaign store', () => {
  it('should preserve campaign cycle and attempt when the database reopens', () => {
    const campaign = startCampaign(
      store.createCampaign({
        repository: 'crgarcia12/podcast-generator',
        baseBranch: 'main',
      }),
    );
    const cycle = store.createCycle({
      campaignId: campaign.id,
      sequence: 4,
      title: 'Add searchable transcripts',
      status: 'proposing',
    });
    store.createAttempt({
      cycleId: cycle.id,
      attemptNumber: 2,
      status: 'retry_wait',
      idempotencyKey: `${cycle.id}-attempt-2`,
    });

    closeDb();

    expect(store.getCampaign(campaign.id)?.status).toBe('running');
    expect(store.getCurrentCycle(campaign.id)?.title).toBe(
      'Add searchable transcripts',
    );
    expect(store.listAttempts(cycle.id)).toEqual([
      expect.objectContaining({
        attemptNumber: 2,
        status: 'retry_wait',
      }),
    ]);
  });

  it('should grant an unexpired campaign lease to only one coordinator', () => {
    const campaign = startCampaign(
      store.createCampaign({
        repository: 'crgarcia12/liliput',
        baseBranch: 'main',
      }),
    );

    const first = store.claimCampaignLease({
      campaignId: campaign.id,
      owner: 'api-pod-a',
      nowMs: 1_000,
      ttlMs: 60_000,
    });
    const second = store.claimCampaignLease({
      campaignId: campaign.id,
      owner: 'api-pod-b',
      nowMs: 30_000,
      ttlMs: 60_000,
    });

    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
    expect(store.getCampaign(campaign.id)?.leaseOwner).toBe('api-pod-a');
  });

  it('should allow another coordinator to claim an expired campaign lease', () => {
    const campaign = startCampaign(
      store.createCampaign({
        repository: 'crgarcia12/liliput',
        baseBranch: 'main',
      }),
    );
    store.claimCampaignLease({
      campaignId: campaign.id,
      owner: 'api-pod-a',
      nowMs: 1_000,
      ttlMs: 1_000,
    });

    const takeover = store.claimCampaignLease({
      campaignId: campaign.id,
      owner: 'api-pod-b',
      nowMs: 2_001,
      ttlMs: 60_000,
    });

    expect(takeover.claimed).toBe(true);
    expect(store.getCampaign(campaign.id)?.leaseOwner).toBe('api-pod-b');
  });

  it('should reject a second active campaign for the same repository branch', () => {
    startCampaign(
      store.createCampaign({
        repository: 'crgarcia12/liliput',
        baseBranch: 'main',
      }),
    );

    let error: unknown;
    try {
      store.createCampaign({
        repository: 'crgarcia12/liliput',
        baseBranch: 'main',
      });
    } catch (caught) {
      error = caught;
    }

    expect(isConflict(error)).toBe(true);
  });

  it('should allow a replacement campaign when the previous campaign is stopped', () => {
    const original = store.createCampaign({
      repository: 'crgarcia12/liliput',
      baseBranch: 'main',
    });
    const stopped = store.transitionCampaign({
      campaignId: original.id,
      expectedStatus: 'draft',
      nextStatus: 'stopped',
      idempotencyKey: `${original.id}-stop`,
    });
    expect(stopped.applied).toBe(true);

    const replacement = store.createCampaign({
      repository: 'crgarcia12/liliput',
      baseBranch: 'main',
    });

    expect(replacement.status).toBe('draft');
  });

  it('should reject a second active cycle for one campaign', () => {
    const campaign = startCampaign(
      store.createCampaign({
        repository: 'crgarcia12/liliput',
        baseBranch: 'main',
      }),
    );
    store.createCycle({
      campaignId: campaign.id,
      sequence: 1,
      title: 'Add repository health history',
      status: 'proposing',
    });

    let error: unknown;
    try {
      store.createCycle({
        campaignId: campaign.id,
        sequence: 2,
        title: 'Add deployment cost trends',
        status: 'proposing',
      });
    } catch (caught) {
      error = caught;
    }

    expect(isConflict(error)).toBe(true);
    expect(store.getCurrentCycle(campaign.id)?.title).toBe(
      'Add repository health history',
    );
  });

  it('should return the same attempt when an idempotency key is replayed', () => {
    const campaign = startCampaign(
      store.createCampaign({
        repository: 'crgarcia12/liliput',
        baseBranch: 'main',
      }),
    );
    const cycle = store.createCycle({
      campaignId: campaign.id,
      sequence: 1,
      title: 'Add cost alerts',
      status: 'proposing',
    });
    const input = {
      cycleId: cycle.id,
      attemptNumber: 1,
      status: 'running' as const,
      idempotencyKey: `${campaign.id}-${cycle.id}-attempt-1`,
    };

    const first = store.createAttempt(input);
    const replay = store.createAttempt(input);

    expect(replay.id).toBe(first.id);
    expect(store.listAttempts(cycle.id)).toHaveLength(1);
  });

  it('should reject a transition when the expected state is stale', () => {
    const campaign = startCampaign(
      store.createCampaign({
        repository: 'crgarcia12/liliput',
        baseBranch: 'main',
      }),
    );
    const paused = store.transitionCampaign({
      campaignId: campaign.id,
      expectedStatus: 'running',
      nextStatus: 'paused',
      idempotencyKey: `${campaign.id}-pause`,
    });
    expect(paused.applied).toBe(true);

    const stale = store.transitionCampaign({
      campaignId: campaign.id,
      expectedStatus: 'running',
      nextStatus: 'stopped',
      idempotencyKey: `${campaign.id}-stale-stop`,
    });

    expect(stale.applied).toBe(false);
    expect(store.getCampaign(campaign.id)?.status).toBe('paused');
  });

  it('should cap retry scheduling and preserve the accepted cycle', () => {
    const campaign = startCampaign(
      store.createCampaign({
        repository: 'crgarcia12/liliput',
        baseBranch: 'main',
      }),
    );
    const cycle = store.createCycle({
      campaignId: campaign.id,
      sequence: 1,
      title: 'Add resilient deployments',
      status: 'proposing',
    });

    const retry = store.scheduleCycleRetry({
      cycleId: cycle.id,
      previousDelayMinutes: 60,
      capMinutes: 60,
    });

    expect(retry.delayMinutes).toBe(60);
    expect(retry.cycle.status).toBe('retry_wait');
    expect(store.getCurrentCycle(campaign.id)?.title).toBe(
      'Add resilient deployments',
    );
  });

  it('should count a repeated usage event only once', () => {
    const campaign = startCampaign(
      store.createCampaign({
        repository: 'crgarcia12/liliput',
        baseBranch: 'main',
      }),
    );
    const cycle = store.createCycle({
      campaignId: campaign.id,
      sequence: 1,
      title: 'Add cost history',
      status: 'proposing',
    });
    const attempt = store.createAttempt({
      cycleId: cycle.id,
      attemptNumber: 1,
      status: 'running',
      idempotencyKey: `${cycle.id}-attempt-1`,
    });

    const first = store.recordAttemptUsage({
      attemptId: attempt.id,
      usageEventId: 'usage-call-42',
      turns: 1,
      estimatedCostUsd: 2.5,
    });
    const replay = store.recordAttemptUsage({
      attemptId: attempt.id,
      usageEventId: 'usage-call-42',
      turns: 1,
      estimatedCostUsd: 2.5,
    });

    expect(replay.turnsUsed).toBe(first.turnsUsed);
    expect(replay.estimatedCostUsd).toBe(first.estimatedCostUsd);
  });

  it('should preserve existing manual workstreams and tasks after campaign storage initializes', () => {
    const workstream = createWorkstream(
      'crgarcia12/liliput',
      'Manual maintenance',
    );
    const task = createTask(
      'Update dependency',
      'Update one dependency without an autonomous campaign.',
      'crgarcia12/liliput',
      { workstreamId: workstream.id },
    );

    closeDb();
    store.resetAutonomousCampaignStore();

    expect(getWorkstream(workstream.id)?.name).toBe('Manual maintenance');
    expect(getTask(task.id)).toEqual(
      expect.objectContaining({
        status: 'clarifying',
        description: 'Update one dependency without an autonomous campaign.',
      }),
    );
  });
});
