import { Given, When, Then, DataTable } from '@cucumber/cucumber';
import { CustomWorld } from '../support/world';
import assert from 'assert';

// ── Background ──────────────────────────────────────────────────

Given('the application is running', async function (this: CustomWorld) {
  // no-op — assume the app is running
});

Given('no users exist in the system', async function (this: CustomWorld) {
  // no-op for fresh-server semantics
});

// ── Given steps ─────────────────────────────────────────────────

Given('a user exists with username {string} and password {string}', async function (this: CustomWorld, username: string, password: string) {
  this.storedPasswords[username] = password;
  await this.apiRequest('POST', '/api/auth/register', { username, password });
});

Given('the user {string} is logged in', async function (this: CustomWorld, username: string) {
  const password = this.storedPasswords[username];
  assert.ok(password, `No stored password for user "${username}"`);
  await this.apiRequest('POST', '/api/auth/login', { username, password });
  // Also inject cookies into the browser context for UI scenarios
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

Given('I am not logged in', async function (this: CustomWorld) {
  this.cookies = [];
  if (this.context) {
    await this.context.clearCookies();
  }
});

Given('I am on the {string} page', async function (this: CustomWorld, pagePath: string) {
  await this.page.goto(`${this.webBaseUrl}${pagePath}`);
});

// ── When steps — API ────────────────────────────────────────────

When('I send a POST request to {string} with body:', async function (this: CustomWorld, path: string, dataTable: DataTable) {
  const rows = dataTable.hashes();
  const body = rows[0]; // first data row is the body
  await this.apiRequest('POST', path, body);
});

When('I send a POST request to {string}', async function (this: CustomWorld, path: string) {
  await this.apiRequest('POST', path);
});

// ── When steps — UI ─────────────────────────────────────────────

When('I fill in {string} with {string}', async function (this: CustomWorld, label: string, value: string) {
  await this.page.getByLabel(label).fill(value);
});

When('I click the {string} button', async function (this: CustomWorld, name: string) {
  await this.page.getByRole('button', { name }).click();
});

When('I navigate to {string}', async function (this: CustomWorld, path: string) {
  await this.page.goto(`${this.webBaseUrl}${path}`);
});

// ── Then steps — API response ───────────────────────────────────

Then('the response status should be {int}', async function (this: CustomWorld, expectedStatus: number) {
  assert.ok(this.response, 'No response recorded');
  assert.strictEqual(this.response.status, expectedStatus);
});

Then('the response body should contain {string} with value {string}', async function (this: CustomWorld, key: string, expectedValue: string) {
  assert.ok(this.response, 'No response recorded');
  assert.ok(this.response.body, 'Response body is empty');
  assert.strictEqual(String(this.response.body[key]), expectedValue);
});

// ── Then steps — Cookie assertions ──────────────────────────────

Then('the response should set a cookie {string} with HttpOnly flag', async function (this: CustomWorld, cookieName: string) {
  assert.ok(this.response, 'No response recorded');
  const setCookies = this.response.headers.getSetCookie?.() || [];
  const cookie = setCookies.find((c: string) => c.startsWith(`${cookieName}=`));
  assert.ok(cookie, `Cookie "${cookieName}" not found in Set-Cookie`);
  assert.ok(cookie.toLowerCase().includes('httponly'), `Cookie "${cookieName}" missing HttpOnly flag`);
});

Then('the response should set a cookie {string} with Secure flag', async function (this: CustomWorld, cookieName: string) {
  assert.ok(this.response, 'No response recorded');
  const setCookies = this.response.headers.getSetCookie?.() || [];
  const cookie = setCookies.find((c: string) => c.startsWith(`${cookieName}=`));
  assert.ok(cookie, `Cookie "${cookieName}" not found in Set-Cookie`);
  assert.ok(cookie.toLowerCase().includes('secure'), `Cookie "${cookieName}" missing Secure flag`);
});

Then('the response should set a cookie {string} with SameSite {string}', async function (this: CustomWorld, cookieName: string, sameSiteValue: string) {
  assert.ok(this.response, 'No response recorded');
  const setCookies = this.response.headers.getSetCookie?.() || [];
  const cookie = setCookies.find((c: string) => c.startsWith(`${cookieName}=`));
  assert.ok(cookie, `Cookie "${cookieName}" not found in Set-Cookie`);
  assert.ok(cookie.toLowerCase().includes(`samesite=${sameSiteValue.toLowerCase()}`), `Cookie "${cookieName}" missing SameSite=${sameSiteValue}`);
});

Then('the response should set a cookie {string} with Path {string}', async function (this: CustomWorld, cookieName: string, pathValue: string) {
  assert.ok(this.response, 'No response recorded');
  const setCookies = this.response.headers.getSetCookie?.() || [];
  const cookie = setCookies.find((c: string) => c.startsWith(`${cookieName}=`));
  assert.ok(cookie, `Cookie "${cookieName}" not found in Set-Cookie`);
  assert.ok(cookie.toLowerCase().includes(`path=${pathValue}`), `Cookie "${cookieName}" missing Path=${pathValue}`);
});

Then('the response should set a cookie {string} with Max-Age {int}', async function (this: CustomWorld, cookieName: string, maxAge: number) {
  assert.ok(this.response, 'No response recorded');
  const setCookies = this.response.headers.getSetCookie?.() || [];
  const cookie = setCookies.find((c: string) => c.startsWith(`${cookieName}=`));
  assert.ok(cookie, `Cookie "${cookieName}" not found in Set-Cookie`);
  assert.ok(cookie.toLowerCase().includes(`max-age=${maxAge}`), `Cookie "${cookieName}" missing Max-Age=${maxAge}`);
});

Then('the response should set a cookie {string} with value {string}', async function (this: CustomWorld, cookieName: string, expectedValue: string) {
  assert.ok(this.response, 'No response recorded');
  const setCookies = this.response.headers.getSetCookie?.() || [];
  const cookie = setCookies.find((c: string) => c.startsWith(`${cookieName}=`));
  assert.ok(cookie, `Cookie "${cookieName}" not found in Set-Cookie`);
  const value = cookie.split(';')[0].split('=').slice(1).join('=');
  assert.strictEqual(value, expectedValue);
});

// ── Then steps — Security ───────────────────────────────────────

Then('the stored password for {string} should be a bcrypt hash', async function (this: CustomWorld, username: string) {
  const res = await fetch(`${this.apiBaseUrl}/api/test/user-hash/${username}`);
  const data = await res.json();
  assert.ok(data.passwordHash, 'No password hash returned');
  assert.ok(
    data.passwordHash.startsWith('$2a$') || data.passwordHash.startsWith('$2b$'),
    `Expected bcrypt hash but got "${data.passwordHash.substring(0, 10)}..."`,
  );
});

Then('the stored password for {string} should not equal {string}', async function (this: CustomWorld, username: string, rawPassword: string) {
  const res = await fetch(`${this.apiBaseUrl}/api/test/user-hash/${username}`);
  const data = await res.json();
  assert.ok(data.passwordHash, 'No password hash returned');
  assert.notStrictEqual(data.passwordHash, rawPassword, 'Password hash should not equal raw password');
});

Then('the {string} cookie should contain a valid JWT', async function (this: CustomWorld, cookieName: string) {
  assert.ok(this.response, 'No response recorded');
  const setCookies = this.response.headers.getSetCookie?.() || [];
  const cookie = setCookies.find((c: string) => c.startsWith(`${cookieName}=`));
  assert.ok(cookie, `Cookie "${cookieName}" not found`);
  const token = cookie.split(';')[0].split('=').slice(1).join('=');
  // A valid JWT has 3 base64-encoded parts separated by dots
  const parts = token.split('.');
  assert.strictEqual(parts.length, 3, 'JWT should have 3 parts');
});

// ── Then steps — UI ─────────────────────────────────────────────

Then('I should be redirected to {string}', async function (this: CustomWorld, expectedPath: string) {
  await this.page.waitForURL(`**${expectedPath}*`, { timeout: 5000 });
  const url = new URL(this.page.url());
  const pathWithQuery = url.pathname + url.search;
  assert.ok(pathWithQuery.includes(expectedPath), `Expected URL to contain "${expectedPath}" but got "${pathWithQuery}"`);
});

Then('I should see the message {string}', async function (this: CustomWorld, text: string) {
  const locator = this.page.getByText(text);
  await locator.waitFor({ timeout: 5000 });
  assert.ok(await locator.isVisible(), `Expected to see message "${text}"`);
});
