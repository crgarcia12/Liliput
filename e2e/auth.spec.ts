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

test.describe('Registration', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/register');
  });

  test('should register a new user and redirect to login with success message', async ({ page }) => {
    const username = uniqueUser();
    await page.getByLabel('Username').fill(username);
    await page.getByLabel('Password').fill('SecurePass123!');
    await page.getByRole('button', { name: 'Register' }).click();

    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText(/registration successful/i)).toBeVisible();
  });

  test('should show error when registering with duplicate username', async ({ page }) => {
    const username = uniqueUser();
    await registerUser(page, username, 'SecurePass123!');

    await page.getByLabel('Username').fill(username);
    await page.getByLabel('Password').fill('SecurePass123!');
    await page.getByRole('button', { name: 'Register' }).click();

    await expect(page.getByText(/already exists/i)).toBeVisible();
  });

  test('should show validation error for invalid username', async ({ page }) => {
    await page.getByLabel('Username').fill('ab');
    await page.getByLabel('Password').fill('SecurePass123!');
    await page.getByRole('button', { name: 'Register' }).click();

    await expect(page.getByText(/username/i)).toBeVisible();
  });

  test('should show validation error for short password', async ({ page }) => {
    await page.getByLabel('Username').fill(uniqueUser());
    await page.getByLabel('Password').fill('short');
    await page.getByRole('button', { name: 'Register' }).click();

    await expect(page.getByText(/password/i)).toBeVisible();
  });

  test('should have a link to login page', async ({ page }) => {
    const loginLink = page.getByRole('link', { name: /log in/i });
    await expect(loginLink).toBeVisible();
    await loginLink.click();
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe('Login', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
  });

  test('should login with valid credentials and redirect to profile', async ({ page }) => {
    const username = uniqueUser();
    const password = 'SecurePass123!';
    await registerUser(page, username, password);

    await page.getByLabel('Username').fill(username);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Log in' }).click();

    await expect(page).toHaveURL(/\/profile/);
  });

  test('should show error for wrong password', async ({ page }) => {
    const username = uniqueUser();
    await registerUser(page, username, 'SecurePass123!');

    await page.getByLabel('Username').fill(username);
    await page.getByLabel('Password').fill('WrongPassword!');
    await page.getByRole('button', { name: 'Log in' }).click();

    await expect(page.getByText('Invalid username or password')).toBeVisible();
  });

  test('should show error for non-existent user', async ({ page }) => {
    await page.getByLabel('Username').fill('nonexistent_user_xyz');
    await page.getByLabel('Password').fill('SomePassword123!');
    await page.getByRole('button', { name: 'Log in' }).click();

    await expect(page.getByText('Invalid username or password')).toBeVisible();
  });

  test('should have a link to register page', async ({ page }) => {
    const registerLink = page.getByRole('link', { name: /register/i });
    await expect(registerLink).toBeVisible();
    await registerLink.click();
    await expect(page).toHaveURL(/\/register/);
  });

  test('should show success message when redirected after registration', async ({ page }) => {
    await page.goto('/login?registered=true');
    await expect(page.getByText(/registration successful/i)).toBeVisible();
  });
});

test.describe('Logout', () => {
  test('should logout and redirect to login', async ({ page }) => {
    const username = uniqueUser();
    const password = 'SecurePass123!';
    await registerUser(page, username, password);
    await loginUser(page, username, password);

    await page.goto('/profile');
    await page.getByRole('button', { name: /logout/i }).click();

    await expect(page).toHaveURL(/\/login/);
  });

  test('should redirect to login when visiting profile after logout', async ({ page }) => {
    const username = uniqueUser();
    const password = 'SecurePass123!';
    await registerUser(page, username, password);
    await loginUser(page, username, password);

    await page.goto('/profile');
    await page.getByRole('button', { name: /logout/i }).click();
    await expect(page).toHaveURL(/\/login/);

    await page.goto('/profile');
    await expect(page).toHaveURL(/\/login/);
  });
});
