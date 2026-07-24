import { createHmac } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function sessionToken(): string {
  const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3001';
  const secret =
    process.env.PLAYWRIGHT_JWT_SECRET ??
    (baseUrl === 'http://localhost:3001'
      ? 'aspire-local-dev-jwt-secret'
      : undefined);
  if (!secret) {
    throw new Error(
      'PLAYWRIGHT_JWT_SECRET is required outside the local Aspire environment.',
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({
    userId: 'e2e-admin',
    username: 'e2e-admin',
    role: 'ADMIN',
    iat: now,
    exp: now + 3_600,
  });
  const unsigned = `${header}.${payload}`;
  const signature = createHmac('sha256', secret)
    .update(unsigned)
    .digest('base64url');
  return `${unsigned}.${signature}`;
}

async function authenticate(page: Page): Promise<void> {
  const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3001';
  const token = sessionToken();
  await page.context().addCookies([
    {
      name: 'session_token',
      value: token,
      url: baseUrl,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  await page.addInitScript((sessionTokenValue) => {
    window.localStorage.setItem('auth_token', sessionTokenValue);
  }, token);
}

test.describe('Campaign workstreams', () => {
  test('shows inactive campaign work in the normal workstream tree', async ({
    page,
  }) => {
    await authenticate(page);
    await page.route('**/api/tasks', async (route) => {
      await route.fulfill({
        json: {
          tasks: [
            {
              id: 'campaign-task-1',
              title: 'Stabilize release loop',
              description: 'Release one reviewed PR before continuing.',
              status: 'failed',
              campaignCycleId: 'campaign-cycle-1',
              workstreamId: 'campaign-workstream-1',
              repository: 'owner/repo',
              baseBranch: 'main',
              commitMode: 'pr',
              agents: [],
              chatHistory: [],
              createdAt: '2026-07-25T10:00:00.000Z',
              updatedAt: '2026-07-25T11:00:00.000Z',
            },
            {
              id: 'ordinary-task-1',
              title: 'Old manual task',
              description: 'An unrelated inactive task.',
              status: 'failed',
              workstreamId: 'ordinary-workstream-1',
              repository: 'owner/repo',
              baseBranch: 'main',
              commitMode: 'pr',
              agents: [],
              chatHistory: [],
              createdAt: '2026-07-24T10:00:00.000Z',
              updatedAt: '2026-07-24T11:00:00.000Z',
            },
          ],
        },
      });
    });
    await page.route('**/api/workstreams', async (route) => {
      await route.fulfill({
        json: {
          workstreams: [
            {
              id: 'campaign-workstream-1',
              repository: 'owner/repo',
              name: '[Campaign owner/repo #1] Stabilize release loop',
              description: 'Release one reviewed PR before continuing.',
              campaignCycleId: 'campaign-cycle-1',
              createdAt: '2026-07-25T10:00:00.000Z',
              updatedAt: '2026-07-25T11:00:00.000Z',
            },
            {
              id: 'ordinary-workstream-1',
              repository: 'owner/repo',
              name: 'Old manual workstream',
              description: 'Unrelated inactive work.',
              createdAt: '2026-07-24T10:00:00.000Z',
              updatedAt: '2026-07-24T11:00:00.000Z',
            },
          ],
        },
      });
    });
    await page.route(
      /\/api\/(?:repos|workstreams)-(?:usage|cost)$/,
      async (route) => {
        await route.fulfill({ json: {} });
      },
    );

    await page.goto('/dashboard');

    await expect(page.getByLabel('Show inactive')).not.toBeChecked();
    await expect(
      page.getByText('[Campaign owner/repo #1] Stabilize release loop'),
    ).toBeVisible();
    await expect(page.getByText('Campaign', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', {
        name: 'Failed Stabilize release loop',
      }),
    ).toBeVisible();
    await expect(page.getByText('Old manual workstream')).toHaveCount(0);

    await page.getByLabel('Show inactive').check();
    await expect(page.getByText('Old manual workstream')).toBeVisible();
  });
});
