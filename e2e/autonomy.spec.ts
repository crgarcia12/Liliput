import { createHmac } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { AutonomyPage } from './pages/autonomy.page';

const REPOSITORY = process.env.PLAYWRIGHT_CAMPAIGN_REPOSITORY ?? 'crgarcia12/Liliput';
const BRANCH =
  process.env.PLAYWRIGHT_CAMPAIGN_BRANCH ?? 'liliput/e2e-autonomy-controls';
const MODEL = process.env.PLAYWRIGHT_CAMPAIGN_MODEL ?? 'gpt-5.4';

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function createSessionToken(role: 'ADMIN' | 'USER'): string {
  const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3001';
  const secret =
    process.env.PLAYWRIGHT_JWT_SECRET ??
    (baseUrl === 'http://localhost:3001' ? 'aspire-local-dev-jwt-secret' : undefined);
  if (!secret) {
    throw new Error('PLAYWRIGHT_JWT_SECRET is required outside the local Aspire environment.');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({
    userId: `e2e-${role.toLowerCase()}`,
    username: `e2e-${role.toLowerCase()}`,
    role,
    iat: now,
    exp: now + 3_600,
  });
  const unsigned = `${header}.${payload}`;
  const signature = createHmac('sha256', secret).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}

async function authenticate(page: Page, role: 'ADMIN' | 'USER'): Promise<string> {
  const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3001';
  const token = createSessionToken(role);
  await page.context().addCookies([
    {
      name: 'session_token',
      value: token,
      url: baseUrl,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  await page.addInitScript((sessionToken) => {
    window.localStorage.setItem('auth_token', sessionToken);
  }, token);
  return token;
}

function apiBaseUrl(): string {
  if (process.env.PLAYWRIGHT_API_BASE_URL) {
    return process.env.PLAYWRIGHT_API_BASE_URL;
  }
  const webBaseUrl = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3001';
  return webBaseUrl.startsWith('http://localhost:')
    ? webBaseUrl.replace(/:300[01]$/, ':5001')
    : webBaseUrl;
}

async function stopExistingTestCampaigns(
  page: Page,
  adminToken: string,
): Promise<void> {
  const headers = { Authorization: `Bearer ${adminToken}` };
  const listed = await page.request.get(
    `${apiBaseUrl()}/api/autonomous-campaigns`,
    { headers },
  );
  expect(listed.ok()).toBe(true);
  const body = (await listed.json()) as {
    campaigns: Array<{
      id: string;
      repository: string;
      baseBranch: string;
      status: string;
    }>;
  };
  for (const campaign of body.campaigns) {
    if (
      campaign.repository === REPOSITORY &&
      campaign.baseBranch === BRANCH &&
      campaign.status !== 'stopped'
    ) {
      const stopped = await page.request.post(
        `${apiBaseUrl()}/api/autonomous-campaigns/${campaign.id}/stop`,
        { headers },
      );
      expect(stopped.ok()).toBe(true);
    }
  }
}

test.describe('Flow: autonomous campaign controls', () => {
  test('@smoke @flow:campaign-controls @frd:autonomous-workstream-campaigns admin controls one campaign lifecycle', async ({
    page,
  }) => {
    const adminToken = await authenticate(page, 'ADMIN');
    await stopExistingTestCampaigns(page, adminToken);
    const autonomy = new AutonomyPage(page);

    await autonomy.goto();
    await expect(autonomy.heading).toHaveText('Autonomous campaigns');

    await autonomy.createCampaign({
      repository: REPOSITORY,
      branch: BRANCH,
      model: MODEL,
      maxTurns: 7,
      maxMinutes: 30,
      maxCostUsd: 5,
    });
    await autonomy.expectStatus('draft');

    await autonomy.startButton.click();
    await autonomy.expectStatus('proposing');

    await autonomy.pauseButton.click();
    await autonomy.expectStatus('paused');

    await autonomy.resumeButton.click();
    await autonomy.expectStatus('proposing');

    await autonomy.stopButton.click();
    await autonomy.expectStatus('stopped');
    await expect(autonomy.startButton).toBeHidden();
  });

  test('@flow:campaign-controls @frd:autonomous-workstream-campaigns admin creates and starts a campaign in one action', async ({
    page,
  }) => {
    const adminToken = await authenticate(page, 'ADMIN');
    await stopExistingTestCampaigns(page, adminToken);
    const autonomy = new AutonomyPage(page);

    await autonomy.goto();
    await autonomy.createAndStartCampaign({
      repository: REPOSITORY,
      branch: BRANCH,
      model: MODEL,
      maxTurns: 7,
      maxMinutes: 30,
      maxCostUsd: 5,
    });

    await autonomy.expectStatus('proposing');
    await expect(autonomy.startButton).toBeHidden();

    await autonomy.stopButton.click();
    await autonomy.expectStatus('stopped');
  });

  test('@flow:campaign-controls @frd:autonomous-workstream-campaigns non-admin is denied campaign controls', async ({
    page,
  }) => {
    await stopExistingTestCampaigns(page, createSessionToken('ADMIN'));
    await authenticate(page, 'USER');
    const autonomy = new AutonomyPage(page);

    await autonomy.goto();

    await expect(autonomy.errorAlert).toHaveText('Admin access required.');
    await expect(autonomy.createButton).toBeHidden();
  });
});
