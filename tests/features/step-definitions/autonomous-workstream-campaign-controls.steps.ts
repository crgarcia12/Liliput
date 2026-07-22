import { After, Given, Then, When } from '@cucumber/cucumber';
import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import { expect } from '@playwright/test';
import type {
  AutonomousCampaign,
  AutonomousCampaignAttempt,
  AutonomousCampaignCycle,
  CreateAutonomousCampaignInput,
} from '../../../src/shared/types/autonomous-campaign-state';
import { AutonomyPage } from '../../../e2e/pages/autonomy.page';
import type { CustomWorld } from '../support/world';

type CampaignAction = 'start' | 'pause' | 'resume' | 'stop';

interface CampaignDetailResponse {
  campaign: AutonomousCampaign;
  cycle: AutonomousCampaignCycle | null;
  attempts: AutonomousCampaignAttempt[];
  allowedActions: CampaignAction[];
}

interface ApiResult<T = unknown> {
  status: number;
  body: T;
}

interface CampaignControlsState {
  token?: string;
  config: CreateAutonomousCampaignInput;
  result?: ApiResult;
  campaign?: AutonomousCampaign;
  cycle?: AutonomousCampaignCycle | null;
  previousCycleId?: string;
  campaignCountBeforeSubmission?: number;
  originalCampaign?: AutonomousCampaign;
  list?: AutonomousCampaign[];
  autonomyPage?: AutonomyPage;
}

const states = new WeakMap<CustomWorld, CampaignControlsState>();
const API_URL = process.env.API_URL ?? 'http://localhost:5001';
const WEB_URL = process.env.WEB_URL ?? 'http://localhost:3001';

function stateFor(world: CustomWorld): CampaignControlsState {
  const existing = states.get(world);
  if (existing) return existing;
  const state: CampaignControlsState = {
    config: {
      repository: 'crgarcia12/Liliput',
      baseBranch: 'main',
      modelConfig: {
        metaAgent: { model: 'gpt-5.4' },
        coding: { model: 'gpt-5.4' },
        reviewer: { model: 'gpt-5.4' },
      },
    },
  };
  states.set(world, state);
  return state;
}

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function sessionToken(role: 'ADMIN' | 'USER'): string {
  const secret =
    process.env.BDD_JWT_SECRET ??
    (API_URL === 'http://localhost:5001' ? 'aspire-local-dev-jwt-secret' : undefined);
  if (!secret) {
    throw new Error('BDD_JWT_SECRET is required outside the local Aspire environment.');
  }
  const now = Math.floor(Date.now() / 1_000);
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({
    userId: `bdd-${role.toLowerCase()}`,
    username: `bdd-${role.toLowerCase()}`,
    role,
    iat: now,
    exp: now + 3_600,
  });
  const unsigned = `${header}.${payload}`;
  const signature = createHmac('sha256', secret).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}

async function api<T>(
  token: string,
  method: string,
  path: string,
  body?: object,
): Promise<ApiResult<T>> {
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const responseBody = (await response.json().catch(() => null)) as T;
  return { status: response.status, body: responseBody };
}

async function detail(token: string, campaignId: string): Promise<CampaignDetailResponse> {
  const result = await api<CampaignDetailResponse>(
    token,
    'GET',
    `/api/autonomous-campaigns/${campaignId}`,
  );
  assert.equal(result.status, 200);
  return result.body;
}

async function createCampaign(
  state: CampaignControlsState,
  overrides: Partial<CreateAutonomousCampaignInput> = {},
): Promise<AutonomousCampaign> {
  assert.ok(state.token);
  const result = await api<{ campaign: AutonomousCampaign }>(
    state.token,
    'POST',
    '/api/autonomous-campaigns',
    { ...state.config, ...overrides },
  );
  assert.equal(result.status, 201);
  state.campaign = result.body.campaign;
  return result.body.campaign;
}

async function act(
  state: CampaignControlsState,
  action: CampaignAction,
): Promise<CampaignDetailResponse> {
  assert.ok(state.token);
  assert.ok(state.campaign);
  const result = await api<CampaignDetailResponse>(
    state.token,
    'POST',
    `/api/autonomous-campaigns/${state.campaign.id}/${action}`,
  );
  assert.equal(result.status, 200);
  state.result = result;
  state.campaign = result.body.campaign;
  state.cycle = result.body.cycle;
  return result.body;
}

async function stopActiveCampaigns(): Promise<void> {
  const token = sessionToken('ADMIN');
  const listed = await api<{ campaigns?: AutonomousCampaign[] }>(
    token,
    'GET',
    '/api/autonomous-campaigns',
  );
  if (listed.status !== 200) return;
  for (const campaign of listed.body.campaigns ?? []) {
    if (campaign.createdBy === 'bdd-admin' && campaign.status !== 'stopped') {
      await api(token, 'POST', `/api/autonomous-campaigns/${campaign.id}/stop`);
    }
  }
}

async function listCampaigns(
  state: CampaignControlsState,
): Promise<ApiResult<{ campaigns: AutonomousCampaign[] }>> {
  assert.ok(state.token);
  const result = await api<{ campaigns: AutonomousCampaign[] }>(
    state.token,
    'GET',
    '/api/autonomous-campaigns',
  );
  state.result = result;
  state.list = result.body.campaigns;
  return result;
}

After({ tags: '@campaign-controls' }, async function (this: CustomWorld) {
  await stopActiveCampaigns();
  states.delete(this);
});

Given(
  'verified pricing exists for model {string}',
  function (this: CustomWorld, model: string) {
    assert.match(model, /^[A-Za-z0-9][A-Za-z0-9._-]+$/);
    stateFor(this);
  },
);

Given(
  'repository {string} has accessible branch {string}',
  function (this: CustomWorld, repository: string, branch: string) {
    assert.match(repository, /^[^/\s]+\/[^/\s]+$/);
    assert.match(branch, /^[^\s]+$/);
    const state = stateFor(this);
    state.config.repository = repository;
    state.config.baseBranch = branch;
  },
);

Given('I am an authenticated administrator', async function (this: CustomWorld) {
  await stopActiveCampaigns();
  stateFor(this).token = sessionToken('ADMIN');
});

Given('I am an authenticated non-administrator', async function (this: CustomWorld) {
  await stopActiveCampaigns();
  stateFor(this).token = sessionToken('USER');
});

Given(
  'campaign configuration targets repository {string} and branch {string}',
  function (this: CustomWorld, repository: string, branch: string) {
    const state = stateFor(this);
    state.config.repository = repository;
    state.config.baseBranch = branch;
    assert.equal(state.config.repository, repository);
    assert.equal(state.config.baseBranch, branch);
  },
);

Given(
  'I select model {string} for meta-agent, coding, and review work',
  function (this: CustomWorld, model: string) {
    const state = stateFor(this);
    state.config.modelConfig = {
      metaAgent: { model },
      coding: { model },
      reviewer: { model },
    };
    assert.equal(state.config.modelConfig?.metaAgent?.model, model);
  },
);

Given(
  'I set limits of {int} turns, {int} minutes, and {int} US dollars',
  function (this: CustomWorld, turns: number, minutes: number, costUsd: number) {
    const state = stateFor(this);
    state.config.maxTurnsPerAttempt = turns;
    state.config.maxMinutesPerAttempt = minutes;
    state.config.maxCostUsdPerAttempt = costUsd;
    assert.equal(state.config.maxTurnsPerAttempt, turns);
  },
);

When('I submit the campaign configuration', async function (this: CustomWorld) {
  const state = stateFor(this);
  assert.ok(state.token);
  const before = await api<{ campaigns?: AutonomousCampaign[] }>(
    sessionToken('ADMIN'),
    'GET',
    '/api/autonomous-campaigns',
  );
  state.campaignCountBeforeSubmission = before.body.campaigns?.length ?? 0;
  state.result = await api<{ campaign?: AutonomousCampaign }>(
    state.token,
    'POST',
    '/api/autonomous-campaigns',
    state.config,
  );
  state.campaign = (state.result.body as { campaign?: AutonomousCampaign }).campaign;
});

Then(
  'the campaign should be created in {string} status',
  function (this: CustomWorld, status: string) {
    const state = stateFor(this);
    assert.equal(state.result?.status, 201);
    assert.equal(state.campaign?.status, status);
  },
);

Then('the campaign should preserve the selected models and limits', function (this: CustomWorld) {
  const state = stateFor(this);
  assert.deepEqual(state.campaign?.modelConfig, state.config.modelConfig);
  assert.equal(
    state.campaign?.maxTurnsPerAttempt,
    state.config.maxTurnsPerAttempt,
  );
  assert.equal(
    state.campaign?.maxMinutesPerAttempt,
    state.config.maxMinutesPerAttempt,
  );
  assert.equal(
    state.campaign?.maxCostUsdPerAttempt,
    state.config.maxCostUsdPerAttempt,
  );
});

Given(
  'a draft campaign exists for repository {string} and branch {string}',
  async function (this: CustomWorld, repository: string, branch: string) {
    const state = stateFor(this);
    state.config.repository = repository;
    state.config.baseBranch = branch;
    const campaign = await createCampaign(state);
    assert.equal(campaign.status, 'draft');
  },
);

When('I start the campaign', async function (this: CustomWorld) {
  await act(stateFor(this), 'start');
});

Then('the campaign should be {string}', function (this: CustomWorld, status: string) {
  assert.equal(stateFor(this).campaign?.status, status);
});

Then('its first cycle should be {string}', function (this: CustomWorld, status: string) {
  const state = stateFor(this);
  assert.equal(state.cycle?.sequence, 1);
  assert.equal(state.cycle?.status, status);
});

Then('no campaign attempt should exist', async function (this: CustomWorld) {
  const state = stateFor(this);
  assert.ok(state.token);
  assert.ok(state.campaign);
  const response = await detail(state.token, state.campaign.id);
  assert.deepEqual(response.attempts, []);
});

Given(
  'a running campaign has a cycle in {string} status',
  async function (this: CustomWorld, status: string) {
    const state = stateFor(this);
    await createCampaign(state);
    const response = await act(state, 'start');
    assert.equal(response.cycle?.status, status);
    state.previousCycleId = response.cycle?.id;
  },
);

When('I pause the campaign', async function (this: CustomWorld) {
  await act(stateFor(this), 'pause');
});

Then('its current cycle should be {string}', function (this: CustomWorld, status: string) {
  assert.equal(stateFor(this).cycle?.status, status);
});

When('I resume the campaign', async function (this: CustomWorld) {
  await act(stateFor(this), 'resume');
});

Then(
  'the same cycle should return to {string}',
  function (this: CustomWorld, status: string) {
    const state = stateFor(this);
    assert.equal(state.cycle?.id, state.previousCycleId);
    assert.equal(state.cycle?.status, status);
  },
);

When('I stop the campaign', async function (this: CustomWorld) {
  await act(stateFor(this), 'stop');
});

Then(
  'the campaign should not offer a start or resume action',
  function (this: CustomWorld) {
    const body = stateFor(this).result?.body as CampaignDetailResponse;
    assert.ok(!body.allowedActions.includes('start'));
    assert.ok(!body.allowedActions.includes('resume'));
  },
);

When('I list autonomous campaigns', async function (this: CustomWorld) {
  await listCampaigns(stateFor(this));
});

Then(
  'the campaign list should include repository {string} and branch {string}',
  function (this: CustomWorld, repository: string, branch: string) {
    const state = stateFor(this);
    assert.equal(state.result?.status, 200);
    assert.ok(
      state.list?.some(
        (campaign) =>
          campaign.repository === repository && campaign.baseBranch === branch,
      ),
    );
  },
);

When('I open that campaign', async function (this: CustomWorld) {
  const state = stateFor(this);
  assert.ok(state.token);
  assert.ok(state.campaign);
  state.result = await api<CampaignDetailResponse>(
    state.token,
    'GET',
    `/api/autonomous-campaigns/${state.campaign.id}`,
  );
});

Then(
  'I should see its status, models, limits, cycle, attempts, cost, and timestamps',
  function (this: CustomWorld) {
    const body = stateFor(this).result?.body as CampaignDetailResponse;
    assert.ok(body.campaign.status);
    assert.ok(body.campaign.modelConfig);
    assert.ok(body.campaign.maxTurnsPerAttempt > 0);
    assert.ok(body.campaign.maxMinutesPerAttempt > 0);
    assert.ok(body.campaign.maxCostUsdPerAttempt > 0);
    assert.ok('cycle' in body);
    assert.ok(Array.isArray(body.attempts));
    assert.equal(typeof body.campaign.cumulativeCostUsd, 'number');
    assert.ok(body.campaign.createdAt);
    assert.ok(body.campaign.updatedAt);
  },
);

When('I request the autonomous campaign list', async function (this: CustomWorld) {
  await listCampaigns(stateFor(this));
});

Then(
  'access should be denied with an administrator-only error',
  function (this: CustomWorld) {
    const state = stateFor(this);
    assert.equal(state.result?.status, 403);
    assert.equal(
      (state.result?.body as { code?: string }).code,
      'ADMIN_REQUIRED',
    );
  },
);

When('I try to create a campaign', async function (this: CustomWorld) {
  const state = stateFor(this);
  assert.ok(state.token);
  state.result = await api(
    state.token,
    'POST',
    '/api/autonomous-campaigns',
    state.config,
  );
});

Given(
  'repository {string} does not have accessible branch {string}',
  function (this: CustomWorld, repository: string, branch: string) {
    assert.match(repository, /^[^/\s]+\/[^/\s]+$/);
    assert.equal(branch, 'missing-branch');
  },
);

Then(
  'campaign creation should fail with a branch validation error',
  function (this: CustomWorld) {
    const state = stateFor(this);
    assert.equal(state.result?.status, 400);
    assert.equal(
      (state.result?.body as { code?: string }).code,
      'CAMPAIGN_BRANCH_INACCESSIBLE',
    );
  },
);

Then('no campaign should be persisted', async function (this: CustomWorld) {
  const state = stateFor(this);
  const result = await api<{ campaigns: AutonomousCampaign[] }>(
    sessionToken('ADMIN'),
    'GET',
    '/api/autonomous-campaigns',
  );
  assert.equal(result.body.campaigns.length, state.campaignCountBeforeSubmission);
});

Given(
  'model {string} has no verified effective price',
  function (this: CustomWorld, model: string) {
    assert.equal(model, 'unpriced-campaign-model');
  },
);

Then(
  'campaign creation should fail with a pricing validation error',
  function (this: CustomWorld) {
    const state = stateFor(this);
    assert.equal(state.result?.status, 422);
    assert.equal(
      (state.result?.body as { code?: string }).code,
      'CAMPAIGN_MODEL_UNPRICED',
    );
  },
);

Given(
  'a running campaign exists for repository {string} and branch {string}',
  async function (this: CustomWorld, repository: string, branch: string) {
    const state = stateFor(this);
    state.config.repository = repository;
    state.config.baseBranch = branch;
    await createCampaign(state);
    await act(state, 'start');
    state.originalCampaign = state.campaign;
  },
);

When(
  'I create another campaign for repository {string} and branch {string}',
  async function (this: CustomWorld, repository: string, branch: string) {
    const state = stateFor(this);
    assert.ok(state.token);
    state.result = await api(
      state.token,
      'POST',
      '/api/autonomous-campaigns',
      { ...state.config, repository, baseBranch: branch },
    );
  },
);

Then(
  'campaign creation should fail with an active campaign conflict',
  function (this: CustomWorld) {
    const state = stateFor(this);
    assert.equal(state.result?.status, 409);
    assert.equal(
      (state.result?.body as { code?: string }).code,
      'ACTIVE_CAMPAIGN_EXISTS',
    );
  },
);

Then(
  'the active campaign status and cycle should remain unchanged',
  async function (this: CustomWorld) {
    const state = stateFor(this);
    assert.ok(state.token);
    assert.ok(state.originalCampaign);
    const response = await detail(state.token, state.originalCampaign.id);
    assert.equal(response.campaign.id, state.originalCampaign.id);
    assert.equal(response.campaign.status, state.originalCampaign.status);
    assert.equal(response.cycle?.id, state.cycle?.id);
  },
);

Given(
  'a paused campaign exists for repository {string} and branch {string}',
  async function (this: CustomWorld, repository: string, branch: string) {
    const state = stateFor(this);
    state.config.repository = repository;
    state.config.baseBranch = branch;
    await createCampaign(state);
    await act(state, 'start');
    await act(state, 'pause');
    assert.equal(state.campaign?.status, 'paused');
  },
);

When('I open the Autonomy portal', async function (this: CustomWorld) {
  const state = stateFor(this);
  assert.ok(this.page);
  const token = sessionToken('ADMIN');
  await this.context.addCookies([
    {
      name: 'session_token',
      value: token,
      url: WEB_URL,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  await this.page.addInitScript((value) => {
    window.localStorage.setItem('auth_token', value);
  }, token);
  state.autonomyPage = new AutonomyPage(this.page);
  await state.autonomyPage.goto();
  assert.ok(state.campaign);
  await state.autonomyPage.openCampaign(state.campaign.repository);
});

Then(
  'repository, branch, model, and budget inputs should have accessible labels',
  async function (this: CustomWorld) {
    await expect(this.page.getByLabel('Repository')).toBeVisible();
    await expect(this.page.getByLabel('Base branch')).toBeVisible();
    await expect(this.page.getByLabel('Meta-agent model')).toBeVisible();
    await expect(this.page.getByLabel('Maximum turns')).toBeVisible();
  },
);

Then(
  'the campaign should offer only resume and stop actions',
  async function (this: CustomWorld) {
    const page = stateFor(this).autonomyPage;
    assert.ok(page);
    await expect(page.resumeButton).toBeVisible();
    await expect(page.stopButton).toBeVisible();
    await expect(page.startButton).toBeHidden();
    await expect(page.pauseButton).toBeHidden();
  },
);
