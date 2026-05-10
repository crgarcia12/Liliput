import { When, Then } from '@cucumber/cucumber';
import { strict as assert } from 'assert';
import { CustomWorld } from '../support/world';

When('I send a GET request to {string}', async function (this: CustomWorld, path: string) {
  await this.apiRequest('GET', path);
});

Then('the health response status should be {int}', function (this: CustomWorld, expected: number) {
  assert.equal(this.response?.status, expected);
});

Then('the health response service should be {string}', function (this: CustomWorld, expected: string) {
  assert.equal(this.response?.body?.service, expected);
});

Then('the health response should include a version string', function (this: CustomWorld) {
  const v = this.response?.body?.version;
  assert.equal(typeof v, 'string', `expected version to be a string, got ${typeof v}`);
  assert.ok(v.length > 0, 'expected non-empty version string');
});
