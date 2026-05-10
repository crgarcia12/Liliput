import { test, expect } from '@playwright/test';

/**
 * Smoke test: confirm Liliput web shell loads and the top-bar brand renders.
 * Does NOT assert any product-specific behavior — that lives in feature-scoped
 * specs added per increment. The goal here is "the build is alive".
 */
test.describe('Liliput web smoke', () => {
  test('home page loads with Liliput brand visible', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.status(), `expected 2xx, got ${response?.status()}`).toBeLessThan(400);

    // TopBar renders "Liliput" as the brand link/title.
    await expect(page.getByText(/^Liliput$/).first()).toBeVisible({ timeout: 10_000 });
  });

  test('API /api/health is reachable from the browser context', async ({ request }) => {
    const res = await request.get('http://localhost:5001/api/health');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.service).toBe('liliput-api');
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
  });
});
