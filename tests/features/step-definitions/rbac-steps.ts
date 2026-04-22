import { Given, When, Then } from '@cucumber/cucumber';
import { CustomWorld } from '../support/world';
import assert from 'assert';
import * as crypto from 'crypto';

// ── Background ──────────────────────────────────────────────────

Given('the user store is empty', async function (this: CustomWorld) {
  // no-op — each scenario starts with a fresh server state
});

// ── Given steps — Registration helpers ──────────────────────────

Given('a registered user {string} with password {string}', async function (this: CustomWorld, username: string, password: string) {
  this.storedPasswords[username] = password;
  await this.apiRequest('POST', '/api/auth/register', { username, password });
});

Given('a registered admin {string} with password {string}', async function (this: CustomWorld, username: string, password: string) {
  // Admin = first registered user
  this.storedPasswords[username] = password;
  await this.apiRequest('POST', '/api/auth/register', { username, password });
});

Given('I am logged in as {string} with password {string}', async function (this: CustomWorld, username: string, password: string) {
  await this.apiRequest('POST', '/api/auth/login', { username, password });
  // Also inject cookies into browser context for UI scenarios
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

Given('I have a tampered JWT for {string} with role {string}', async function (this: CustomWorld, username: string, role: string) {
  // Create a JWT signed with a wrong secret
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    username,
    role,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 86400,
  })).toString('base64url');
  const fakeSecret = 'tampered-wrong-secret-key';
  const signature = crypto
    .createHmac('sha256', fakeSecret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  this.tamperedJwt = `${header}.${payload}.${signature}`;
});

// ── When steps — Registration ───────────────────────────────────

When('I register with username {string} and password {string}', async function (this: CustomWorld, username: string, password: string) {
  this.storedPasswords[username] = password;
  await this.apiRequest('POST', '/api/auth/register', { username, password });
});

// ── When steps — GET requests ───────────────────────────────────

When('I send a GET request to {string}', async function (this: CustomWorld, path: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (this.cookies.length) headers['Cookie'] = this.cookies.join('; ');
  const res = await fetch(`${this.apiBaseUrl}${path}`, { method: 'GET', headers });
  const setCookies = res.headers.getSetCookie?.() || [];
  if (setCookies.length) this.cookies = setCookies;
  const responseBody = await res.json().catch(() => null);
  this.response = { status: res.status, body: responseBody, headers: res.headers };
});

When('I send a GET request to {string} without a JWT', async function (this: CustomWorld, path: string) {
  // Ensure no cookies are sent
  const res = await fetch(`${this.apiBaseUrl}${path}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  const responseBody = await res.json().catch(() => null);
  this.response = { status: res.status, body: responseBody, headers: res.headers };
});

When('I send a GET request to {string} with the tampered JWT', async function (this: CustomWorld, path: string) {
  assert.ok(this.tamperedJwt, 'No tampered JWT has been created');
  const res = await fetch(`${this.apiBaseUrl}${path}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `token=${this.tamperedJwt}`,
    },
  });
  const responseBody = await res.json().catch(() => null);
  this.response = { status: res.status, body: responseBody, headers: res.headers };
});

// ── Then steps — JSON response assertions ───────────────────────

Then('the response JSON should include role {string}', async function (this: CustomWorld, expectedRole: string) {
  assert.ok(this.response, 'No response recorded');
  assert.ok(this.response.body, 'Response body is empty');
  assert.strictEqual(this.response.body.role, expectedRole);
});

Then('the JWT payload should include role {string}', async function (this: CustomWorld, expectedRole: string) {
  assert.ok(this.response, 'No response recorded');
  // Extract JWT from Set-Cookie or response body
  const setCookies = this.response.headers.getSetCookie?.() || [];
  const tokenCookie = setCookies.find((c: string) => c.startsWith('token='));
  assert.ok(tokenCookie, 'No token cookie found in response');
  const token = tokenCookie.split(';')[0].split('=').slice(1).join('=');
  const parts = token.split('.');
  assert.strictEqual(parts.length, 3, 'JWT should have 3 parts');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  assert.strictEqual(payload.role, expectedRole);
});

Then('the response should be a JSON array with {int} entries', async function (this: CustomWorld, expectedCount: number) {
  assert.ok(this.response, 'No response recorded');
  assert.ok(Array.isArray(this.response.body), 'Response body should be an array');
  assert.strictEqual(this.response.body.length, expectedCount);
});

Then('each entry should have {string}, {string}, and {string} fields', async function (this: CustomWorld, field1: string, field2: string, field3: string) {
  assert.ok(this.response, 'No response recorded');
  assert.ok(Array.isArray(this.response.body), 'Response body should be an array');
  for (const entry of this.response.body) {
    assert.ok(field1 in entry, `Entry missing "${field1}" field`);
    assert.ok(field2 in entry, `Entry missing "${field2}" field`);
    assert.ok(field3 in entry, `Entry missing "${field3}" field`);
  }
});

Then('the response JSON should include error {string}', async function (this: CustomWorld, expectedError: string) {
  assert.ok(this.response, 'No response recorded');
  assert.ok(this.response.body, 'Response body is empty');
  assert.strictEqual(this.response.body.error, expectedError);
});

Then('no entry should have a {string} field', async function (this: CustomWorld, fieldName: string) {
  assert.ok(this.response, 'No response recorded');
  assert.ok(Array.isArray(this.response.body), 'Response body should be an array');
  for (const entry of this.response.body) {
    assert.ok(!(fieldName in entry), `Entry should not have "${fieldName}" field`);
  }
});

Then('no entry should have an {string} field', async function (this: CustomWorld, fieldName: string) {
  assert.ok(this.response, 'No response recorded');
  assert.ok(Array.isArray(this.response.body), 'Response body should be an array');
  for (const entry of this.response.body) {
    assert.ok(!(fieldName in entry), `Entry should not have "${fieldName}" field`);
  }
});

// ── Then steps — Admin UI ───────────────────────────────────────

Then('I should see a table with columns {string}, {string}, and {string}', async function (this: CustomWorld, col1: string, col2: string, col3: string) {
  for (const col of [col1, col2, col3]) {
    const header = this.page.locator('table th').filter({ hasText: col });
    await header.waitFor({ timeout: 5000 });
    assert.ok(await header.isVisible(), `Expected table column "${col}"`);
  }
});

Then('the table should contain a row with username {string} and role {string}', async function (this: CustomWorld, username: string, role: string) {
  const row = this.page.locator('table tr').filter({ hasText: username }).filter({ hasText: role });
  await row.waitFor({ timeout: 5000 });
  assert.ok(await row.isVisible(), `Expected table row with username "${username}" and role "${role}"`);
});

Then('I should see the text {string} before the table appears', async function (this: CustomWorld, text: string) {
  // Intercept admin users API to keep loading state observable
  await this.page.route('**/api/admin/users', async (route) => {
    await new Promise(r => setTimeout(r, 1000));
    await route.continue();
  });
  await this.page.reload({ waitUntil: 'domcontentloaded' });
  const locator = this.page.getByText(text);
  await locator.waitFor({ timeout: 3000 });
  assert.ok(await locator.isVisible(), `Expected to see text "${text}" before table appears`);
  await this.page.unroute('**/api/admin/users');
});

Then('I should see the role displayed as {string}', async function (this: CustomWorld, role: string) {
  const locator = this.page.getByTestId('role-badge');
  await locator.waitFor({ timeout: 5000 });
  const text = await locator.textContent();
  assert.ok(text?.trim() === role, `Expected role "${role}" displayed but got "${text?.trim()}"`);
});
