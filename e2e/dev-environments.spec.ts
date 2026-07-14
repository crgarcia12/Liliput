import { test, expect } from '@playwright/test';
import { DevEnvironmentsPage } from './pages/dev-environments.page';

const TASKS = [
  {
    id: 'task-alpha',
    title: 'Alpha preview',
    description: 'Alpha',
    status: 'completed',
    repository: 'example/alpha',
    branch: 'liliput/alpha',
    commitSha: 'a123456789',
    imageRef: 'registry/alpha:a123456',
    devNamespace: 'dev-alpha',
    devUrl: 'https://alpha.example.test',
    devEnvState: 'active',
    agents: [],
    chatHistory: [],
    createdAt: '2026-07-12T09:00:00.000Z',
    updatedAt: '2026-07-14T09:00:00.000Z',
  },
  {
    id: 'task-beta',
    title: 'Beta preview',
    description: 'Beta',
    status: 'review',
    repository: 'example/beta',
    branch: 'liliput/beta',
    commitSha: 'b123456789',
    imageRef: 'registry/beta:b123456',
    devNamespace: 'dev-beta',
    devUrl: 'https://beta.example.test',
    devEnvState: 'stopped',
    agents: [],
    chatHistory: [],
    createdAt: '2026-07-11T09:00:00.000Z',
    updatedAt: '2026-07-13T09:00:00.000Z',
  },
  {
    id: 'task-deleted',
    title: 'Deleted preview',
    description: 'Deleted',
    status: 'failed',
    repository: 'example/deleted',
    branch: 'liliput/deleted',
    commitSha: 'd123456789',
    imageRef: 'registry/deleted:d123456',
    devNamespace: 'dev-deleted',
    devUrl: 'https://deleted.example.test',
    devEnvState: 'deleted',
    agents: [],
    chatHistory: [],
    createdAt: '2026-07-10T09:00:00.000Z',
    updatedAt: '2026-07-12T09:00:00.000Z',
  },
];

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3001';

test.describe('Flow: manage dev environments', () => {
  test.beforeEach(async ({ page }) => {
    await page.context().addCookies([
      { name: 'session_token', value: 'e2e-session', url: BASE_URL },
    ]);
    await page.route('**/api/tasks', async (route) => {
      await route.fulfill({ json: { tasks: TASKS } });
    });
  });

  test('switches from cards to a compact list of environments', async ({ page }) => {
    const environments = new DevEnvironmentsPage(page);
    await environments.goto();

    await expect(environments.cardsViewButton).toHaveAttribute('aria-pressed', 'true');
    await environments.showList();

    await expect(environments.listViewButton).toHaveAttribute('aria-pressed', 'true');
    await expect(environments.list).toBeVisible();
    await expect(environments.environmentRow('Alpha preview')).toContainText('example/alpha');
    await expect(environments.environmentRow('Beta preview')).toContainText('Stopped');
    await expect(environments.environmentRow('Deleted preview')).toContainText('Deleted');
  });

  test('selects and deletes multiple environments in one action', async ({ page }) => {
    const deletedTaskIds: string[] = [];
    await page.route('**/api/tasks/*/dev-env', async (route) => {
      if (route.request().method() !== 'DELETE') {
        await route.continue();
        return;
      }

      const match = new URL(route.request().url()).pathname.match(/\/api\/tasks\/([^/]+)\/dev-env$/);
      if (match?.[1]) deletedTaskIds.push(match[1]);
      await route.fulfill({ json: { task: {} } });
    });

    const environments = new DevEnvironmentsPage(page);
    await environments.goto();
    await environments.showList();
    await environments.selectEnvironment('Alpha preview');
    await environments.selectEnvironment('Beta preview');

    await expect(environments.bulkDeleteButton).toHaveText('Delete selected (2)');
    await expect(environments.environmentCheckbox('Deleted preview')).toBeDisabled();

    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toContain('Delete 2 dev environments?');
      await dialog.accept();
    });
    await environments.deleteSelected();

    await expect(environments.bulkResult).toHaveText('Deleted 2 environments.');
    expect(deletedTaskIds.sort()).toEqual(['task-alpha', 'task-beta']);
    await expect(environments.bulkDeleteButton).toBeDisabled();
  });
});
