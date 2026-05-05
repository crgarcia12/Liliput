import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGherkinChecks } from '../../src/engine/gherkin-runner.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'liliput-gherkin-'));
}

describe('gherkin-runner', () => {
  it('skips when no .feature file is present', async () => {
    const dir = tmpDir();
    try {
      const r = await runGherkinChecks(dir, 'http://localhost');
      expect(r.status).toBe('skipped');
      expect(r.reason).toContain('no .feature');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips when cucumber-js is not installed', async () => {
    const dir = tmpDir();
    try {
      mkdirSync(join(dir, 'tests', 'features'), { recursive: true });
      writeFileSync(
        join(dir, 'tests', 'features', 'sample.feature'),
        'Feature: x\n  Scenario: y\n    Given z\n',
      );
      const r = await runGherkinChecks(dir, 'http://localhost');
      expect(r.status).toBe('skipped');
      expect(r.reason).toContain('cucumber-js not installed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
