import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeAcceptanceFeature } from '../../src/engine/acceptance-feature-writer.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'liliput-accept-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const SPEC_WITH_GHERKIN = `# Specification: Login

## Overview
...

## Acceptance Scenarios (Gherkin)
\`\`\`gherkin
Feature: User Login

  Scenario: Successful login
    Given a registered user
    When they submit valid credentials
    Then they receive a session token
\`\`\`
`;

describe('writeAcceptanceFeature', () => {
  it('writes the gherkin block to tests/features/acceptance.feature', async () => {
    const r = await writeAcceptanceFeature(tmp, SPEC_WITH_GHERKIN);
    expect(r.written).toBe(true);
    const out = await fs.readFile(r.path, 'utf8');
    expect(out).toContain('Feature: User Login');
    expect(out).toContain('Scenario: Successful login');
    // Should be plain Gherkin, no fence
    expect(out).not.toContain('```');
  });

  it('creates the parent directory if missing', async () => {
    const r = await writeAcceptanceFeature(tmp, SPEC_WITH_GHERKIN);
    expect(r.written).toBe(true);
    const stat = await fs.stat(path.join(tmp, 'tests', 'features'));
    expect(stat.isDirectory()).toBe(true);
  });

  it('skips with no-spec when spec is empty', async () => {
    expect((await writeAcceptanceFeature(tmp, '')).skippedReason).toBe(
      'no-spec',
    );
    expect((await writeAcceptanceFeature(tmp, undefined)).skippedReason).toBe(
      'no-spec',
    );
  });

  it('skips with no-gherkin-block when spec lacks a gherkin fence', async () => {
    const spec = '# Specification: X\n\n## Overview\nNo gherkin here.';
    const r = await writeAcceptanceFeature(tmp, spec);
    expect(r.written).toBe(false);
    expect(r.skippedReason).toBe('no-gherkin-block');
  });

  it('does not overwrite an existing file', async () => {
    await fs.mkdir(path.join(tmp, 'tests', 'features'), { recursive: true });
    const target = path.join(tmp, 'tests', 'features', 'acceptance.feature');
    await fs.writeFile(target, 'Feature: existing\n', 'utf8');
    const r = await writeAcceptanceFeature(tmp, SPEC_WITH_GHERKIN);
    expect(r.written).toBe(false);
    expect(r.skippedReason).toBe('already-exists');
    expect(await fs.readFile(target, 'utf8')).toBe('Feature: existing\n');
  });

  it('honours a custom relPath', async () => {
    const r = await writeAcceptanceFeature(tmp, SPEC_WITH_GHERKIN, {
      relPath: 'tests/features/01-login.feature',
    });
    expect(r.written).toBe(true);
    expect(r.path.replace(/\\/g, '/')).toContain(
      'tests/features/01-login.feature',
    );
  });

  it('always returns the resolved path even when skipping', async () => {
    const r = await writeAcceptanceFeature(tmp, '');
    expect(r.path.replace(/\\/g, '/')).toContain(
      'tests/features/acceptance.feature',
    );
  });
});
