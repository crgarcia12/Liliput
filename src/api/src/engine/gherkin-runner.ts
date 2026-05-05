/**
 * Optional gherkin/cucumber runner for the validate loop.
 *
 * After the live preview probe says "HTTP healthy", we want a stronger
 * signal: do the agent's BDD scenarios actually pass against the running
 * preview? If the agent followed the TDD-first prompt, the workspace
 * should contain `tests/features/*.feature` and a `cucumber-js` setup.
 *
 * This module is BEST-EFFORT:
 *  - If cucumber isn't installed locally, we report "skipped" — no install
 *    triggered (we don't want to pollute the agent's lockfile).
 *  - If no `.feature` files exist, we report "skipped".
 *  - If cucumber runs and exits 0, we report "passed".
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
import { existsSync, readdirSync, statSync } from 'node:fs';
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

/** Recursively walk up to `maxDepth` looking for files matching `predicate`. */
function findAny(
  root: string,
  predicate: (filename: string, fullPath: string) => boolean,
  maxDepth = 4,
  exclude: ReadonlySet<string> = new Set(['node_modules', '.git', 'dist', 'build', '.next']),
): string | null {
  if (!existsSync(root)) return null;
  const stack: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  while (stack.length) {
    const { path, depth } = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(path);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (exclude.has(name)) continue;
      const full = join(path, name);
      let s;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        if (depth < maxDepth) stack.push({ path: full, depth: depth + 1 });
      } else if (predicate(name, full)) {
        return full;
      }
    }
  }
  return null;
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

  // Quick gate: any *.feature in workspace?
  const featureFile = findAny(cwd, (n) => n.endsWith('.feature'));
  if (!featureFile) {
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
      status: 'skipped',
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
    const child = spawn(cucumberBin, [], { cwd, env, shell: false });
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
        status: 'skipped',
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
      status: 'skipped' as const,
      reason: `runner crashed: ${err instanceof Error ? err.message : String(err)}`,
      output: '',
      durationMs: Date.now() - start,
    };
  });
}
