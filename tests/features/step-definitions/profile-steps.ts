import { Given, When, Then } from '@cucumber/cucumber';
import { CustomWorld } from '../support/world';
import assert from 'assert';

// ── Given steps ─────────────────────────────────────────────────

Given('I am logged in as a user with username {string} and role {string} created at {string}', async function (this: CustomWorld, username: string, role: string, createdAt: string) {
  // Create user with specific createdAt for profile display testing
  if (role === 'admin') {
    await this.apiRequest('POST', '/api/test/create-user', { username, password: 'TestPassword1!', role: 'admin', createdAt });
  } else {
    // Register a dummy admin first to take the first-user slot
    await this.apiRequest('POST', '/api/test/create-user', { username: 'dummy_admin_setup', password: 'TestPassword1!', role: 'admin' });
    await this.apiRequest('POST', '/api/test/create-user', { username, password: 'TestPassword1!', role: 'user', createdAt });
  }
  // Login
  await this.apiRequest('POST', '/api/auth/login', { username, password: 'TestPassword1!' });
  // Inject cookies into browser context
  if (this.context && this.cookies.length) {
    for (const cookieStr of this.cookies) {
      const [nameValue] = cookieStr.split(';');
      const [name, ...valueParts] = nameValue.split('=');
      await this.context.addCookies([{
        name: name.trim(),
        value: valueParts.join('=').trim(),
        domain: 'localhost',
        path: '/',
      }]);
    }
  }
});

Given('I am not authenticated', async function (this: CustomWorld) {
  this.cookies = [];
  if (this.context) {
    await this.context.clearCookies();
  }
});

Given('the API response for {string} is delayed', async function (this: CustomWorld, apiPath: string) {
  // Intercept the API call and delay the response
  await this.page.route(`**${apiPath}`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 10000));
    await route.continue();
  });
});

Given('the API at {string} is unreachable', async function (this: CustomWorld, apiPath: string) {
  // Intercept and abort the request
  await this.page.route(`**${apiPath}`, async (route) => {
    await route.abort('connectionrefused');
  });
});

Given('I have an expired JWT token', async function (this: CustomWorld) {
  // Set a cookie with an expired JWT (header.payload.signature with exp in the past)
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ username: 'expired_user', role: 'user', exp: 1 })).toString('base64url');
  const fakeSignature = 'invalidsignature';
  const expiredToken = `${header}.${payload}.${fakeSignature}`;
  if (this.context) {
    await this.context.addCookies([{
      name: 'token',
      value: expiredToken,
      domain: 'localhost',
      path: '/',
    }]);
  }
  this.cookies = [`token=${expiredToken}`];
});

Given('I have a malformed JWT token', async function (this: CustomWorld) {
  const malformedToken = 'not.a.valid.jwt.at.all';
  if (this.context) {
    await this.context.addCookies([{
      name: 'token',
      value: malformedToken,
      domain: 'localhost',
      path: '/',
    }]);
  }
  this.cookies = [`token=${malformedToken}`];
});

Given('I have a valid JWT token for a deleted user', async function (this: CustomWorld) {
  // Create and login a user to get a valid JWT, then delete the user
  await this.apiRequest('POST', '/api/test/create-user', { username: 'deleted_user', password: 'TestPassword1!', role: 'user' });
  await this.apiRequest('POST', '/api/auth/login', { username: 'deleted_user', password: 'TestPassword1!' });
  // Inject cookies into browser
  if (this.context && this.cookies.length) {
    for (const cookieStr of this.cookies) {
      const [nameValue] = cookieStr.split(';');
      const [name, ...valueParts] = nameValue.split('=');
      await this.context.addCookies([{
        name: name.trim(),
        value: valueParts.join('=').trim(),
        domain: 'localhost',
        path: '/',
      }]);
    }
  }
  // Delete the user so the JWT is now for a non-existent user
  await fetch(`${this.apiBaseUrl}/api/test/users/deleted_user`, { method: 'DELETE' });
});

// ── When steps ──────────────────────────────────────────────────

When('I visit the {string} page', async function (this: CustomWorld, pagePath: string) {
  await this.page.goto(`${this.webBaseUrl}${pagePath}`);
});

// ── Then steps — Profile ────────────────────────────────────────

Then('I should see the username {string}', async function (this: CustomWorld, username: string) {
  const locator = this.page.getByText(username);
  await locator.waitFor({ timeout: 5000 });
  assert.ok(await locator.isVisible(), `Expected to see username "${username}"`);
});

Then('I should see a role badge displaying {string}', async function (this: CustomWorld, role: string) {
  const locator = this.page.getByTestId('role-badge');
  await locator.waitFor({ timeout: 5000 });
  const text = await locator.textContent();
  assert.ok(text?.trim() === role, `Expected role badge to display "${role}" but got "${text?.trim()}"`);
});

Then('I should see the member since date {string}', async function (this: CustomWorld, dateStr: string) {
  const locator = this.page.getByText(dateStr);
  await locator.waitFor({ timeout: 5000 });
  assert.ok(await locator.isVisible(), `Expected to see date "${dateStr}"`);
});

Then('I should see a {string} button', async function (this: CustomWorld, name: string) {
  const locator = this.page.getByRole('button', { name });
  await locator.waitFor({ timeout: 5000 });
  assert.ok(await locator.isVisible(), `Expected to see "${name}" button`);
});

Then('I should not see a {string} button', async function (this: CustomWorld, name: string) {
  const count = await this.page.getByRole('button', { name }).count();
  assert.strictEqual(count, 0, `Expected NOT to see "${name}" button`);
});

Then('the {string} cookie should be cleared', async function (this: CustomWorld, cookieName: string) {
  const cookies = await this.context.cookies();
  const cookie = cookies.find((c) => c.name === cookieName);
  assert.ok(!cookie || cookie.value === '', `Expected cookie "${cookieName}" to be cleared`);
});

// ── Then steps — Text / Heading ─────────────────────────────────

Then('I should see the text {string}', async function (this: CustomWorld, text: string) {
  const locator = this.page.getByText(text);
  await locator.waitFor({ timeout: 5000 });
  assert.ok(await locator.isVisible(), `Expected to see text "${text}"`);
});

Then('I should see the heading {string}', async function (this: CustomWorld, heading: string) {
  const locator = this.page.getByRole('heading', { name: heading });
  await locator.waitFor({ timeout: 5000 });
  assert.ok(await locator.isVisible(), `Expected to see heading "${heading}"`);
});

// ── Then steps — NavBar ─────────────────────────────────────────

Then('the NavBar should display the app name {string} linking to {string}', async function (this: CustomWorld, appName: string, href: string) {
  const link = this.page.locator(`nav a[href="${href}"]`).filter({ hasText: appName });
  await link.waitFor({ timeout: 5000 });
  assert.ok(await link.isVisible(), `Expected NavBar app name "${appName}" linking to "${href}"`);
});

Then('the NavBar should display a {string} link to {string}', async function (this: CustomWorld, linkText: string, href: string) {
  const link = this.page.locator(`nav a[href="${href}"]`).filter({ hasText: linkText });
  await link.waitFor({ timeout: 5000 });
  assert.ok(await link.isVisible(), `Expected NavBar "${linkText}" link to "${href}"`);
});

Then('the NavBar should display an {string} link to {string}', async function (this: CustomWorld, linkText: string, href: string) {
  // Same as above but with "an" article
  const link = this.page.locator(`nav a[href="${href}"]`).filter({ hasText: linkText });
  await link.waitFor({ timeout: 5000 });
  assert.ok(await link.isVisible(), `Expected NavBar "${linkText}" link to "${href}"`);
});

Then('the NavBar should display a {string} button', async function (this: CustomWorld, buttonText: string) {
  const button = this.page.locator('nav').getByRole('button', { name: buttonText });
  await button.waitFor({ timeout: 5000 });
  assert.ok(await button.isVisible(), `Expected NavBar "${buttonText}" button`);
});

Then('the NavBar should not display a {string} link', async function (this: CustomWorld, linkText: string) {
  const count = await this.page.locator('nav').getByRole('link', { name: linkText }).count();
  assert.strictEqual(count, 0, `Expected NavBar NOT to display "${linkText}" link`);
});

Then('the NavBar should not display an {string} link', async function (this: CustomWorld, linkText: string) {
  const count = await this.page.locator('nav').getByRole('link', { name: linkText }).count();
  assert.strictEqual(count, 0, `Expected NavBar NOT to display "${linkText}" link`);
});

Then('the NavBar should not display a {string} button', async function (this: CustomWorld, buttonText: string) {
  const count = await this.page.locator('nav').getByRole('button', { name: buttonText }).count();
  assert.strictEqual(count, 0, `Expected NavBar NOT to display "${buttonText}" button`);
});

// ── Then steps — Landing page links ─────────────────────────────

Then('I should see a {string} link to {string}', async function (this: CustomWorld, linkText: string, href: string) {
  const link = this.page.locator(`a[href="${href}"]`).filter({ hasText: linkText }).first();
  await link.waitFor({ timeout: 5000 });
  assert.ok(await link.isVisible(), `Expected to see "${linkText}" link to "${href}"`);
});

Then('I should not see a {string} link', async function (this: CustomWorld, linkText: string) {
  const count = await this.page.getByRole('link', { name: linkText }).count();
  assert.strictEqual(count, 0, `Expected NOT to see "${linkText}" link`);
});

Then('I should see a {string} link', async function (this: CustomWorld, linkText: string) {
  const link = this.page.getByRole('link', { name: linkText });
  await link.waitFor({ timeout: 5000 });
  assert.ok(await link.isVisible(), `Expected to see "${linkText}" link`);
});


