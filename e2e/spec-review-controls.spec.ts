import { test, expect } from '@playwright/test';

const task = (requireSpecApproval: boolean) => ({
  id: 'spec-review-task',
  title: 'Spec review task',
  description: 'Build a feature',
  status: 'specifying',
  spec: '# Specification\n\n## Overview\nGenerated spec.',
  requireSpecApproval,
  chatHistory: [],
  activityHistory: [],
  agents: [],
  updatedAt: new Date().toISOString(),
});

test.describe('spec review controls', () => {
  test.beforeEach(async ({ context }) => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3001';
    await context.addCookies([
      {
        name: 'session_token',
        value: 'test-session',
        url: `${baseURL}/`,
      },
    ]);
  });

  test('should not expose edit or approve controls for automatic tasks', async ({ page }) => {
    await page.route('**/api/tasks/spec-review-task', async (route) => {
      await route.fulfill({ json: { task: task(false) } });
    });

    await page.goto('/m/task/spec-review-task');

    await expect(page.getByRole('button', { name: /Edit/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Approve/ })).toHaveCount(0);
  });

  test('should keep approve and edit controls for manually gated tasks', async ({ page }) => {
    await page.route('**/api/tasks/spec-review-task', async (route) => {
      await route.fulfill({ json: { task: task(true) } });
    });

    await page.goto('/m/task/spec-review-task');

    await expect(page.getByRole('button', { name: /Approve/ })).toBeVisible();
    await page.getByRole('button', { name: /Edit/ }).click();
    await expect(page.getByRole('button', { name: /Save/ })).toBeVisible();
  });
});
