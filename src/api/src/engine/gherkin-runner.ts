/**
 * Optional gherkin/cucumber runner for the validate loop.
 *
 * After the live preview probe says "HTTP healthy", we want a stronger
 * signal: do the agent's BDD scenarios actually pass against the running
 * preview? If the agent followed the TDD-first prompt, the workspace
 * should contain `tests/features/*.feature` and a `cucumber-js` setup.
 *
 * This module fails closed once feature files exist:
 *  - If cucumber isn't installed locally, we report "failed".
 *  - If no `.feature` files exist, we report "skipped".
 *  - If cucumber exits 0 after executing scenarios, we report "passed".
 *  - If cucumber exits 0 but reports zero scenarios, we report "failed".
 *  - If cucumber exits non-zero, we capture the tail of its output as
 *    failure context (fed to the fixer as the new error).
 *
 * Timeout cap: 90 seconds. BDD scenarios that hang on a broken preview
 * shouldn't block the loop indefinitely.
 *
 * The runner sets `BASE_URL` and `LILIPUT_PREVIEW_URL` env vars so step
 * definitions can target the live preview without hardcoding.
 */

import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../logger.js';

export interface GherkinResult {
  status: 'passed' | 'failed' | 'skipped';
  reason: string;
  output: string;
  durationMs: number;
}

const TIMEOUT_MS = parseInt(process.env['GHERKIN_RUNNER_TIMEOUT_MS'] ?? '90000', 10);
const OUTPUT_TAIL_BYTES = 4000;

/** Recursively collect feature files without following symlinked directories. */
export function discoverGherkinFeatureFiles(
  root: string,
  exclude: ReadonlySet<string> = new Set(['node_modules', '.git', 'dist', 'build', '.next']),
): string[] {
  if (!existsSync(root)) return [];
  const matches: string[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const currentPath = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(currentPath);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (exclude.has(name)) continue;
      const full = join(currentPath, name);
      let s;
      try {
        s = lstatSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        stack.push(full);
      } else if (name.endsWith('.feature')) {
        matches.push(full);
      }
    }
  }
  return matches.sort((left, right) => left.localeCompare(right));
}

export function reportsZeroCucumberScenarios(output: string): boolean {
  return /(?:^|\s)0 scenarios?(?:\s|\(|$)/im.test(output);
}

/**
 * Run cucumber against the preview URL. Returns a structured result without
 * throwing — the caller logs and decides what to do.
 */
export async function runGherkinChecks(
  cwd: string,
  previewUrl: string,
): Promise<GherkinResult> {
  const start = Date.now();

  // Discover every feature file and pass the paths explicitly. Cucumber's
  // default search does not include this repository's tests/features layout.
  const featureFiles = discoverGherkinFeatureFiles(cwd);
  if (featureFiles.length === 0) {
    return {
      status: 'skipped',
      reason: 'no .feature files found in workspace',
      output: '',
      durationMs: Date.now() - start,
    };
  }

  // Quick gate: is cucumber-js a local dep? We check node_modules/.bin so we
  // don't trigger an install.
  const cucumberBin = join(cwd, 'node_modules', '.bin', process.platform === 'win32' ? 'cucumber-js.cmd' : 'cucumber-js');
  if (!existsSync(cucumberBin)) {
    return {
      status: 'failed',
      reason: 'cucumber-js not installed in workspace node_modules',
      output: '',
      durationMs: Date.now() - start,
    };
  }

  return new Promise<GherkinResult>((resolve) => {
    const env = {
      ...process.env,
      BASE_URL: previewUrl,
      LILIPUT_PREVIEW_URL: previewUrl,
      CI: '1',
    };
    let output = '';
    let timedOut = false;
    const child = spawn(cucumberBin, ['--format', 'progress', ...featureFiles], {
      cwd,
      env,
      shell: false,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, TIMEOUT_MS);

    const append = (chunk: Buffer | string) => {
      output += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (output.length > OUTPUT_TAIL_BYTES * 4) {
        output = output.slice(-OUTPUT_TAIL_BYTES * 4);
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        status: 'failed',
        reason: `cucumber spawn failed: ${err.message}`,
        output,
        durationMs: Date.now() - start,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const tail = output.length > OUTPUT_TAIL_BYTES ? output.slice(-OUTPUT_TAIL_BYTES) : output;
      if (timedOut) {
        resolve({
          status: 'failed',
          reason: `cucumber timed out after ${TIMEOUT_MS}ms`,
          output: tail,
          durationMs: Date.now() - start,
        });
        return;
      }
      if (code === 0 && reportsZeroCucumberScenarios(tail)) {
        resolve({
          status: 'failed',
          reason: 'cucumber discovered feature files but executed zero scenarios',
          output: tail,
          durationMs: Date.now() - start,
        });
        return;
      }
      if (code === 0) {
        resolve({
          status: 'passed',
          reason: 'all scenarios passed',
          output: tail,
          durationMs: Date.now() - start,
        });
        return;
      }
      resolve({
        status: 'failed',
        reason: `cucumber exit code ${code ?? 'unknown'}`,
        output: tail,
        durationMs: Date.now() - start,
      });
    });
  }).catch((err) => {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'gherkin-runner: unexpected error',
    );
    return {
      status: 'failed' as const,
      reason: `runner crashed: ${err instanceof Error ? err.message : String(err)}`,
      output: '',
      durationMs: Date.now() - start,
    };
  });
}
