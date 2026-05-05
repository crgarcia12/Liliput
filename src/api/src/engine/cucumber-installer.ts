/**
 * Best-effort installer for @cucumber/cucumber in the agent's workspace.
 *
 * Why: PR #33 added a gherkin-runner that runs cucumber against the live
 * preview after each healthy deploy — but it skips silently if cucumber-js
 * isn't installed. Many target repos won't have it, so the runner becomes
 * a no-op in practice. This installer makes sure cucumber is present
 * BEFORE the agent loop starts, on the same trigger that wrote the
 * acceptance.feature file.
 *
 * Rules:
 *  - Only runs when a `package.json` exists at the workspace root.
 *    (We don't want to scaffold a Node project inside non-JS repos.)
 *  - Skips if `@cucumber/cucumber` is already in dependencies or
 *    devDependencies (idempotent across iterations and resumes).
 *  - Skips if `node_modules/.bin/cucumber-js` already exists (someone
 *    pre-installed it but didn't pin it in package.json — leave it alone).
 *  - Best-effort: any failure is logged + reported via skippedReason,
 *    never throws. The agent can install it itself if this fails.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { logger } from '../logger.js';

const NPM_INSTALL_TIMEOUT_MS = Number(
  process.env.CUCUMBER_INSTALL_TIMEOUT_MS ?? 120000,
);

export interface InstallCucumberResult {
  installed: boolean;
  skippedReason?:
    | 'no-package-json'
    | 'already-in-package-json'
    | 'already-in-node-modules'
    | 'install-failed'
    | 'install-timeout';
  /** stdout+stderr tail when install was attempted (for logging). */
  output?: string;
  durationMs?: number;
}

export async function installCucumberIfMissing(
  cwd: string,
): Promise<InstallCucumberResult> {
  const pkgPath = path.join(cwd, 'package.json');
  let pkgRaw: string;
  try {
    pkgRaw = await fs.readFile(pkgPath, 'utf8');
  } catch {
    return { installed: false, skippedReason: 'no-package-json' };
  }

  try {
    const pkg = JSON.parse(pkgRaw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    if (
      pkg.dependencies?.['@cucumber/cucumber'] ||
      pkg.devDependencies?.['@cucumber/cucumber']
    ) {
      return { installed: false, skippedReason: 'already-in-package-json' };
    }
  } catch {
    // Malformed package.json — let the agent deal with it. Don't try to install.
    return { installed: false, skippedReason: 'no-package-json' };
  }

  // Already-installed-but-unpinned check
  const binNames = ['cucumber-js', 'cucumber-js.cmd'];
  for (const bin of binNames) {
    try {
      await fs.access(path.join(cwd, 'node_modules', '.bin', bin));
      return { installed: false, skippedReason: 'already-in-node-modules' };
    } catch {
      // not present, continue
    }
  }

  return await runNpmInstall(cwd);
}

function runNpmInstall(cwd: string): Promise<InstallCucumberResult> {
  return new Promise(resolve => {
    const start = Date.now();
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(
      npmCmd,
      ['install', '-D', '--no-audit', '--no-fund', '@cucumber/cucumber'],
      { cwd, shell: false, env: { ...process.env, CI: '1' } },
    );
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const MAX_TAIL_BYTES = 4000;
    const onData = (b: Buffer) => {
      chunks.push(b);
      totalBytes += b.length;
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // process may have exited already
      }
    }, NPM_INSTALL_TIMEOUT_MS);

    child.once('error', err => {
      clearTimeout(timer);
      logger.warn(
        { err: err.message, cwd },
        'cucumber install: spawn error',
      );
      resolve({
        installed: false,
        skippedReason: 'install-failed',
        output: err.message,
        durationMs: Date.now() - start,
      });
    });

    child.once('close', code => {
      clearTimeout(timer);
      const buf = Buffer.concat(chunks, totalBytes);
      const tail =
        buf.length > MAX_TAIL_BYTES
          ? buf.subarray(buf.length - MAX_TAIL_BYTES).toString('utf8')
          : buf.toString('utf8');
      const durationMs = Date.now() - start;
      if (code === 0) {
        resolve({ installed: true, output: tail, durationMs });
      } else if (code === null) {
        resolve({
          installed: false,
          skippedReason: 'install-timeout',
          output: tail,
          durationMs,
        });
      } else {
        resolve({
          installed: false,
          skippedReason: 'install-failed',
          output: tail,
          durationMs,
        });
      }
    });
  });
}
