import { test, expect, Page } from '@playwright/test';

async function registerUser(page: Page, username: string, password: string) {
  await page.request.post('/api/auth/register', { data: { username, password } });
}

async function loginUser(page: Page, username: string, password: string) {
  await page.request.post('/api/auth/login', { data: { username, password } });
}

function uniqueUser() {
  return `user_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

test.beforeEach(async ({ context }) => {
  await context.request.post('http://localhost:5001/api/test/reset');
  await context.clearCookies();
});

test.describe('Landing Page', () => {
  test('guest should see heading, description, and Login/Register CTAs', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: /userauth/i })).toBeVisible();
    await expect(page.getByText(/simple authentication demo/i)).toBeVisible();
    await expect(page.getByRole('main').getByRole('link', { name: /login/i })).toBeVisible();
    await expect(page.getByRole('main').getByRole('link', { name: /register/i })).toBeVisible();
  });

  test('authenticated user should see "Go to Profile" link instead of Login/Register', async ({ page }) => {
    const username = uniqueUser();
    const password = 'SecurePass123!';
    await registerUser(page, username, password);
    await loginUser(page, username, password);

    await page.goto('/');

    await expect(page.getByRole('link', { name: /go to profile/i })).toBeVisible();
  });
});
