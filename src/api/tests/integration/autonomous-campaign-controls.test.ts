import http from 'node:http';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { Server as SocketServer } from 'socket.io';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AutonomousCampaign,
  AutonomousCampaignAttempt,
  AutonomousCampaignCycle,
  CreateAutonomousCampaignInput,
} from '../../../../shared/types/autonomous-campaign-state.js';
import { createAutonomousCampaignsRouter } from '../../src/routes/autonomous-campaigns.js';
import type { AutonomousCampaignControlOptions } from '../../src/engine/autonomous-campaign-control.js';
import { resetAutonomousCampaignStore } from '../../src/stores/autonomous-campaign-store.js';
import { getDb, resetDb } from '../../src/stores/db.js';

interface CampaignRouterDeps {
  verifyRepositoryBranch?: (
    repository: string,
    branch: string,
  ) => Promise<
    | { ok: true }
    | { ok: false; status: number; reason: string }
  >;
  now?: () => string;
  control?: AutonomousCampaignControlOptions;
}

interface CampaignDetailResponse {
  campaign: AutonomousCampaign;
  cycle: AutonomousCampaignCycle | null;
  attempts: AutonomousCampaignAttempt[];
  allowedActions: Array<'start' | 'pause' | 'resume' | 'stop'>;
}

const now = '2026-07-23T12:00:00.000Z';
const validInput: CreateAutonomousCampaignInput = {
  repository: 'crgarcia12/Liliput',
  baseBranch: 'main',
  ideaSources: ['code', 'issues', 'ideation'],
  modelConfig: {
    metaAgent: { model: 'gpt-5.4', reasoningEffort: 'high' },
    coding: { model: 'gpt-5.4', reasoningEffort: 'high' },
    reviewer: { model: 'gpt-5.4', reasoningEffort: 'high' },
  },
  maxTurnsPerAttempt: 7,
  maxMinutesPerAttempt: 30,
  maxCostUsdPerAttempt: 5,
};

async function buildApp(input: {
  role?: 'ADMIN' | 'USER';
  verifyRepositoryBranch?: CampaignRouterDeps['verifyRepositoryBranch'];
  control?: AutonomousCampaignControlOptions;
} = {}) {
  const server = http.createServer();
  const io = new SocketServer(server);
  const emit = vi.spyOn(io, 'emit');
  const app = express();
  app.use(express.json());
  app.use(((req, _res, next) => {
    req.user = {
      userId: input.role === 'USER' ? 'user-1' : 'admin-1',
      username: input.role === 'USER' ? 'user' : 'admin',
      role: input.role ?? 'ADMIN',
    };
    next();
  }) as RequestHandler);
  app.use(
    createAutonomousCampaignsRouter(io, {
      verifyRepositoryBranch:
        input.verifyRepositoryBranch ??
        vi.fn(async () => ({ ok: true as const })),
      now: () => now,
      ...(input.control ? { control: input.control } : {}),
    }),
  );
  return { app, io, emit };
}

async function createCampaign(app: express.Express): Promise<AutonomousCampaign> {
  const response = await request(app)
    .post('/api/autonomous-campaigns')
    .send(validInput);
  expect(response.status).toBe(201);
  return response.body.campaign as AutonomousCampaign;
}

beforeEach(() => {
  resetDb();
  resetAutonomousCampaignStore();
});

describe('autonomous campaign admin routes', () => {
  it('should deny list and create operations when the user is not an administrator', async () => {
    const { app } = await buildApp({ role: 'USER' });

    const list = await request(app).get('/api/autonomous-campaigns');
    const create = await request(app)
      .post('/api/autonomous-campaigns')
      .send(validInput);

    expect(list.status).toBe(403);
    expect(list.body).toMatchObject({ code: 'ADMIN_REQUIRED' });
    expect(create.status).toBe(403);
    expect(create.body).toMatchObject({ code: 'ADMIN_REQUIRED' });
  });

  it('should create a draft campaign with validated models, sources, and limits', async () => {
    const verifyRepositoryBranch = vi.fn(async () => ({ ok: true as const }));
    const { app, emit } = await buildApp({ verifyRepositoryBranch });

    const response = await request(app)
      .post('/api/autonomous-campaigns')
      .send(validInput);

    expect(response.status).toBe(201);
    expect(response.body.campaign).toMatchObject({
      repository: validInput.repository,
      baseBranch: validInput.baseBranch,
      status: 'draft',
      ideaSources: validInput.ideaSources,
      modelConfig: validInput.modelConfig,
      maxTurnsPerAttempt: validInput.maxTurnsPerAttempt,
      maxMinutesPerAttempt: validInput.maxMinutesPerAttempt,
      maxCostUsdPerAttempt: validInput.maxCostUsdPerAttempt,
      createdBy: 'admin-1',
    });
    expect(verifyRepositoryBranch).toHaveBeenCalledWith(
      validInput.repository,
      validInput.baseBranch,
    );
    expect(emit).toHaveBeenCalledWith(
      'autonomous-campaign:updated',
      expect.objectContaining({ action: 'created' }),
    );
  });

  it('should start at proposing without creating an attempt or invoking an agent', async () => {
    const { app, emit } = await buildApp();
    const campaign = await createCampaign(app);

    const response = await request(app)
      .post(`/api/autonomous-campaigns/${campaign.id}/start`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      campaign: { id: campaign.id, status: 'running' },
      cycle: { campaignId: campaign.id, sequence: 1, status: 'proposing' },
      attempts: [],
      allowedActions: ['pause', 'stop'],
    });
    const attempts = getDb()
      .prepare(
        `SELECT COUNT(*) AS count
           FROM autonomous_attempts attempt
           JOIN autonomous_cycles cycle ON cycle.id = attempt.cycle_id
          WHERE cycle.campaign_id = ?`,
      )
      .get(campaign.id) as { count: number };
    expect(attempts.count).toBe(0);
    expect(emit).toHaveBeenCalledWith(
      'autonomous-campaign:updated',
      expect.objectContaining({
        action: 'started',
        cycle: expect.objectContaining({ status: 'proposing' }),
      }),
    );
  });

  it('should pause and resume the same cycle without resetting campaign usage', async () => {
    const { app } = await buildApp();
    const campaign = await createCampaign(app);
    const started = await request(app)
      .post(`/api/autonomous-campaigns/${campaign.id}/start`);
    const startedCycleId = started.body.cycle.id as string;

    const paused = await request(app)
      .post(`/api/autonomous-campaigns/${campaign.id}/pause`);
    const resumed = await request(app)
      .post(`/api/autonomous-campaigns/${campaign.id}/resume`);

    expect(paused.status).toBe(200);
    expect(paused.body).toMatchObject({
      campaign: { status: 'paused', cumulativeTurns: 0, cumulativeCostUsd: 0 },
      cycle: { id: startedCycleId, status: 'paused' },
      allowedActions: ['resume', 'stop'],
    });
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({
      campaign: { status: 'running', cumulativeTurns: 0, cumulativeCostUsd: 0 },
      cycle: { id: startedCycleId, status: 'proposing' },
      allowedActions: ['pause', 'stop'],
    });
  });

  it.each(['pause', 'stop'] as const)(
    'should cancel active proposal work when the operator requests %s',
    async (action) => {
      const cancelProposal = vi.fn();
      const { app } = await buildApp({
        control: { cancelProposal },
      });
      const campaign = await createCampaign(app);
      const started = await request(app)
        .post(`/api/autonomous-campaigns/${campaign.id}/start`);
      const cycleId = started.body.cycle.id as string;

      const response = await request(app)
        .post(`/api/autonomous-campaigns/${campaign.id}/${action}`);

      expect(response.status).toBe(200);
      expect(cancelProposal).toHaveBeenCalledWith(campaign.id, cycleId);
    },
  );

  it('should make stop terminal for the campaign and current cycle', async () => {
    const { app } = await buildApp();
    const campaign = await createCampaign(app);
    await request(app).post(`/api/autonomous-campaigns/${campaign.id}/start`);

    const stopped = await request(app)
      .post(`/api/autonomous-campaigns/${campaign.id}/stop`);
    const resume = await request(app)
      .post(`/api/autonomous-campaigns/${campaign.id}/resume`);

    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({
      campaign: { status: 'stopped' },
      cycle: { status: 'stopped' },
      allowedActions: [],
    });
    expect(resume.status).toBe(409);
    expect(resume.body).toMatchObject({ code: 'INVALID_CAMPAIGN_ACTION' });
  });

  it('should return campaign list and detail evidence', async () => {
    const { app } = await buildApp();
    const campaign = await createCampaign(app);
    await request(app).post(`/api/autonomous-campaigns/${campaign.id}/start`);

    const list = await request(app).get('/api/autonomous-campaigns');
    const detail = await request(app)
      .get(`/api/autonomous-campaigns/${campaign.id}`);

    expect(list.status).toBe(200);
    expect(list.body.campaigns).toEqual([
      expect.objectContaining({
        id: campaign.id,
        repository: validInput.repository,
        baseBranch: validInput.baseBranch,
        status: 'running',
      }),
    ]);
    expect(detail.status).toBe(200);
    expect(detail.body as CampaignDetailResponse).toMatchObject({
      campaign: {
        id: campaign.id,
        modelConfig: validInput.modelConfig,
        maxTurnsPerAttempt: validInput.maxTurnsPerAttempt,
        maxMinutesPerAttempt: validInput.maxMinutesPerAttempt,
        maxCostUsdPerAttempt: validInput.maxCostUsdPerAttempt,
        cumulativeCostUsd: 0,
        cumulativeTurns: 0,
        createdAt: now,
        updatedAt: now,
      },
      cycle: { status: 'proposing' },
      attempts: [],
      allowedActions: ['pause', 'stop'],
    });
  });

  it('should reject an inaccessible branch before persisting a campaign', async () => {
    const { app } = await buildApp({
      verifyRepositoryBranch: vi.fn(async () => ({
        ok: false as const,
        status: 404,
        reason: 'Branch "missing-branch" was not found.',
      })),
    });

    const response = await request(app)
      .post('/api/autonomous-campaigns')
      .send({ ...validInput, baseBranch: 'missing-branch' });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: 'CAMPAIGN_BRANCH_INACCESSIBLE',
      field: 'baseBranch',
    });
    const count = getDb()
      .prepare('SELECT COUNT(*) AS count FROM autonomous_campaigns')
      .get() as { count: number };
    expect(count.count).toBe(0);
  });

  it('should reject an unpriced model before persisting a campaign', async () => {
    const { app } = await buildApp();

    const response = await request(app)
      .post('/api/autonomous-campaigns')
      .send({
        ...validInput,
        modelConfig: {
          ...validInput.modelConfig,
          metaAgent: { model: 'unpriced-campaign-model' },
        },
      });

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      code: 'CAMPAIGN_MODEL_UNPRICED',
      unpricedModels: ['unpriced-campaign-model'],
    });
    const count = getDb()
      .prepare('SELECT COUNT(*) AS count FROM autonomous_campaigns')
      .get() as { count: number };
    expect(count.count).toBe(0);
  });

  it('should reject invalid limits and preserve default limits when omitted', async () => {
    const { app } = await buildApp();

    const invalid = await request(app)
      .post('/api/autonomous-campaigns')
      .send({
        ...validInput,
        maxTurnsPerAttempt: 0,
        maxMinutesPerAttempt: -1,
        maxCostUsdPerAttempt: -5,
      });
    const defaults = await request(app)
      .post('/api/autonomous-campaigns')
      .send({
        ...validInput,
        baseBranch: 'release',
        maxTurnsPerAttempt: undefined,
        maxMinutesPerAttempt: undefined,
        maxCostUsdPerAttempt: undefined,
      });

    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({
      code: 'CAMPAIGN_VALIDATION_FAILED',
      field: 'maxTurnsPerAttempt',
    });
    expect(defaults.status).toBe(201);
    expect(defaults.body.campaign).toMatchObject({
      maxTurnsPerAttempt: 500,
      maxMinutesPerAttempt: 240,
      maxCostUsdPerAttempt: 250,
    });
  });

  it('should reject a second active campaign for the same repository branch', async () => {
    const { app } = await buildApp();
    const original = await createCampaign(app);
    await request(app).post(`/api/autonomous-campaigns/${original.id}/start`);

    const duplicate = await request(app)
      .post('/api/autonomous-campaigns')
      .send(validInput);
    const detail = await request(app)
      .get(`/api/autonomous-campaigns/${original.id}`);

    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toMatchObject({ code: 'ACTIVE_CAMPAIGN_EXISTS' });
    expect(detail.body.campaign).toMatchObject({
      id: original.id,
      status: 'running',
    });
  });
});
