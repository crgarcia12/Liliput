/**
 * Writes the Gherkin acceptance scenarios from a generated spec.md into the
 * agent's cloned workspace as `tests/features/acceptance.feature`.
 *
 * The spec generator (PR #18) emits a `## Acceptance Scenarios (Gherkin)`
 * fenced block. The agent prompts (PR #20) tell the agent to write Cucumber
 * tests from that block. This writer makes sure the file actually exists in
 * the workspace before the agent starts — so the agent can `git add` it,
 * `cucumber-js` can find it, and the user has a starting point even if the
 * agent's first turn focuses elsewhere.
 *
 * Unlike the LILIPUT_DEPLOY_CONTRACT.md, this file IS meant to be committed
 * to the target repo (it's part of the test suite), so we do NOT add it to
 * .git/info/exclude.
 *
 * Idempotent: refuses to overwrite if a file already exists at the target
 * path (the agent — or the original repo — may have its own version).
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { extractGherkin } from './spec-generator.js';
import { logger } from '../logger.js';

const DEFAULT_REL_PATH = path.posix.join(
  'tests',
  'features',
  'acceptance.feature',
);

export interface WriteAcceptanceFeatureResult {
  /** Whether a file was actually created. */
  written: boolean;
  /** The absolute path where the file was (or would have been) written. */
  path: string;
  /** Why writing was skipped, if applicable. Useful for logging. */
  skippedReason?:
    | 'no-spec'
    | 'no-gherkin-block'
    | 'already-exists'
    | 'write-failed';
}

export interface WriteAcceptanceFeatureOptions {
  /** Override the default relative path. Useful for per-feature specs. */
  relPath?: string;
}

/**
 * Drop the spec's Gherkin block into the workspace as a `.feature` file.
 * Best-effort: any failure is logged at warn and reported via skippedReason —
 * this never throws to the caller. Workspace setup must continue regardless.
 */
export async function writeAcceptanceFeature(
  cwd: string,
  spec: string | null | undefined,
  opts: WriteAcceptanceFeatureOptions = {},
): Promise<WriteAcceptanceFeatureResult> {
  const relPath = opts.relPath ?? DEFAULT_REL_PATH;
  const absPath = path.join(cwd, relPath);

  if (!spec || !spec.trim()) {
    return { written: false, path: absPath, skippedReason: 'no-spec' };
  }
  const gherkin = extractGherkin(spec);
  if (!gherkin) {
    return {
      written: false,
      path: absPath,
      skippedReason: 'no-gherkin-block',
    };
  }
  // Idempotent: if a file already exists, leave it alone.
  try {
    await fs.access(absPath);
    return {
      written: false,
      path: absPath,
      skippedReason: 'already-exists',
    };
  } catch {
    // File does not exist — proceed to write.
  }
  try {
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    const body = gherkin.endsWith('\n') ? gherkin : gherkin + '\n';
    await fs.writeFile(absPath, body, 'utf8');
    return { written: true, path: absPath };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), cwd, relPath },
      'Failed to write acceptance.feature into workspace',
    );
    return {
      written: false,
      path: absPath,
      skippedReason: 'write-failed',
    };
  }
}
