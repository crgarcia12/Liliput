import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { isPureRebuildCommand } from '../../src/engine/agent-engine.js';

const agentEngineSource = readFileSync(
  new URL('../../src/engine/agent-engine.ts', import.meta.url),
  'utf8',
);

function sourceBetween(start: string, end: string): string {
  const startIndex = agentEngineSource.indexOf(start);
  const endIndex = agentEngineSource.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return agentEngineSource.slice(startIndex, endIndex);
}

describe('isPureRebuildCommand', () => {
  it.each([
    'rebuild',
    'Rebuild',
    'rebuild.',
    'rebuild!',
    'redeploy',
    're-build',
    're-deploy',
    'deploy',
    'build',
    'rebuild now',
    'redeploy now',
    'deploy now',
    'build again',
    'rebuild again',
    'rebuild and deploy',
    'rebuild and redeploy',
    'build and deploy',
    'go ahead and rebuild',
    'go ahead and rebuild and deploy',
    'please rebuild',
    'please redeploy',
    'just rebuild',
    'can you rebuild',
    'can you please redeploy',
    'rebuild it',
    'rebuild the app',
    'rebuild the preview',
    'redeploy the image',
    'rebuild please',
    'i want you to rebuild',
    'i want to rebuild',
    'push',
    'ship to dev',
  ])('returns true for %j', (msg) => {
    expect(isPureRebuildCommand(msg)).toBe(true);
  });

  it.each([
    '',
    '   ',
    'rebuild the login form to use OAuth',
    'redeploy after fixing the bug in auth.ts',
    'add a rebuild button',
    'why is rebuild failing',
    'the deploy keeps failing',
    'fix the build error',
    'add tests for the deploy script',
    // Long messages should not match even if they contain the keywords
    'rebuild ' + 'x'.repeat(200),
  ])('returns false for %j', (msg) => {
    expect(isPureRebuildCommand(msg)).toBe(false);
  });
});

describe('preview routing after redeploy', () => {
  // Validates: specs/liliput/frd-managed-end-to-end-delivery.md,
  // acceptance criteria for a real rebuild rollout and healthy preview evidence.
  it.each([
    ['iteration', 'async function runIteration(', 'async function runRebuildOnly('],
    ['rebuild', 'async function runRebuildOnly(', 'export function revalidateCampaignTask('],
  ])('should publish the gateway route before validating a %s preview', (_name, start, end) => {
    const source = sourceBetween(start, end);
    const deployIndex = source.indexOf('await deployWithFixer(');
    const routeIndex = source.indexOf('await publishDevRoute(');
    const validateIndex = source.indexOf('await validateAndHealLoop(');

    expect(deployIndex).toBeGreaterThanOrEqual(0);
    expect(routeIndex).toBeGreaterThan(deployIndex);
    expect(validateIndex).toBeGreaterThan(routeIndex);
  });
});
