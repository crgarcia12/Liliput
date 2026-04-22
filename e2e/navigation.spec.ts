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

test.describe('Navigation Bar', () => {
  test('guest should see Login and Register links but not Profile or Logout', async ({ page }) => {
    await page.goto('/');
    const nav = page.getByRole('navigation');

    await expect(nav.getByRole('link', { name: /login/i })).toBeVisible();
    await expect(nav.getByRole('link', { name: /register/i })).toBeVisible();
    await expect(nav.getByRole('link', { name: /profile/i })).not.toBeVisible();
    await expect(nav.getByRole('button', { name: /logout/i })).not.toBeVisible();
  });

  test('logged-in user should see Profile and Logout but not Login, Register, or Admin', async ({ page }) => {
    // Register a dummy admin first so the test user gets 'user' role
    await registerUser(page, uniqueUser(), 'SecurePass123!');
    const username = uniqueUser();
    const password = 'SecurePass123!';
    await registerUser(page, username, password);
    await loginUser(page, username, password);

    await page.goto('/');
    const nav = page.getByRole('navigation');

    await expect(nav.getByRole('link', { name: /profile/i })).toBeVisible();
    await expect(nav.getByRole('button', { name: /logout/i })).toBeVisible();
    await expect(nav.getByRole('link', { name: /login/i })).not.toBeVisible();
    await expect(nav.getByRole('link', { name: /register/i })).not.toBeVisible();
    await expect(nav.getByRole('link', { name: /admin/i })).not.toBeVisible();
  });

  test('admin user should see Profile, Admin, and Logout', async ({ page }) => {
    // The first registered user becomes admin
    const username = uniqueUser();
    const password = 'SecurePass123!';
    await registerUser(page, username, password);
    await loginUser(page, username, password);

    await page.goto('/');
    const nav = page.getByRole('navigation');

    await expect(nav.getByRole('link', { name: /profile/i })).toBeVisible();
    await expect(nav.getByRole('link', { name: /admin/i })).toBeVisible();
    await expect(nav.getByRole('button', { name: /logout/i })).toBeVisible();
  });
});
