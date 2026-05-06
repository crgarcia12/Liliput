/**
 * Force-override channel for the SDK bundle patch.
 *
 * The SDK's `setModel(model, { reasoningEffort })` is silently no-op'd by an
 * internal validator for some model families (e.g. claude-opus-4.7-high),
 * leaving `clientOptions.defaultReasoningEffort` stuck at "medium" and
 * causing CAPI 400s like
 *   `reasoning_effort "medium" is not supported by model claude-opus-4.7-high`.
 *
 * Our build-time SDK patch (`patch-sdk-effort-tracer.cjs`) reads
 * /tmp/liliput-current-effort inside `getCompletionOptions` and force-
 * overrides the value of `o` (the about-to-be-sent reasoning_effort) if the
 * file contains a non-empty value. The parent process writes this file
 * before every SDK call that may issue a CAPI request. Both processes run
 * in the same container so /tmp is shared.
 *
 * Concurrency: Liliput processes turns serially per workstream today; the
 * file race only matters if a future change runs parallel turns sharing the
 * same SDK CLI subprocess.
 */

import { writeFileSync } from 'node:fs';
import { logger } from '../logger.js';
import type { ReasoningEffort } from '../../../shared/types/index.js';

export const FORCE_EFFORT_FILE = '/tmp/liliput-current-effort';

export function setForceEffort(effort: ReasoningEffort | undefined): void {
  try {
    writeFileSync(FORCE_EFFORT_FILE, effort ? `${effort}\n` : '');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), effort },
      'force-effort: failed to write override file (SDK patch will fall back to in-process value)',
    );
  }
}
