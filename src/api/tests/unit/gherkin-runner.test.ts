import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverGherkinFeatureFiles,
  reportsZeroCucumberScenarios,
  runGherkinChecks,
} from '../../src/engine/gherkin-runner.js';

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

  it('fails when cucumber-js is not installed', async () => {
    const dir = tmpDir();
    try {
      mkdirSync(join(dir, 'tests', 'features'), { recursive: true });
      writeFileSync(
        join(dir, 'tests', 'features', 'sample.feature'),
        'Feature: x\n  Scenario: y\n    Given z\n',
      );
      const r = await runGherkinChecks(dir, 'http://localhost');
      expect(r.status).toBe('failed');
      expect(r.reason).toContain('cucumber-js not installed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('discovers every feature path in the tests/features layout', () => {
    const dir = tmpDir();
    try {
      mkdirSync(join(dir, 'tests', 'features', 'nested'), { recursive: true });
      writeFileSync(join(dir, 'tests', 'features', 'first.feature'), 'Feature: first\n');
      writeFileSync(
        join(dir, 'tests', 'features', 'nested', 'second.feature'),
        'Feature: second\n',
      );
      writeFileSync(join(dir, 'tests', 'features', 'steps.ts'), 'export {};\n');

      expect(
        discoverGherkinFeatureFiles(dir).map((feature) => feature.slice(dir.length + 1)),
      ).toEqual([
        join('tests', 'features', 'first.feature'),
        join('tests', 'features', 'nested', 'second.feature'),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects a successful cucumber process that executed zero scenarios', () => {
    expect(reportsZeroCucumberScenarios('0 scenarios\n0 steps\n')).toBe(true);
    expect(reportsZeroCucumberScenarios('1 scenario (1 passed)\n3 steps')).toBe(false);
  });
});
