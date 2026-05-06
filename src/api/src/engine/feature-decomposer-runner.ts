/**
 * Run the feature decomposer through the Copilot SDK.
 *
 * Inputs:
 *   - workstreamId, title, spec  (passed to buildDecompositionPrompt)
 * Output:
 *   - Decomposition (parsed) on success
 *   - null on any failure (empty response, parse error, SDK error, timeout)
 *
 * Failure mode is intentionally lenient: the caller treats a null result as
 * "do not split this workstream — fall back to single-feature behavior".
 * Decomposition is best-effort scaffolding, not a hard requirement.
 *
 * Wiring (when the engine should INVOKE this) lives in the workstream
 * creation path. This module is the runner only.
 */
import { approveAll } from '@github/copilot-sdk';
import { getCopilotClient } from './copilot-client.js';
import { logger } from '../logger.js';
import {
  buildDecompositionPrompt,
  parseDecomposition,
  type DecomposeInput,
  type Decomposition,
} from './feature-decomposer.js';
import { deriveReasoningEffort, type ReasoningEffort } from '../../../shared/types/index.js';

const DEFAULT_MODEL = process.env['COPILOT_MODEL'] ?? 'claude-sonnet-4';
const DEFAULT_TIMEOUT_MS = parseInt(
  process.env['DECOMPOSER_TIMEOUT_MS'] ?? '120000',
  10,
);

export interface DecomposerRunner {
  (input: DecomposeInput, modelOverride?: string, reasoningEffortOverride?: ReasoningEffort): Promise<Decomposition | null>;
}

/**
 * Default runner: invokes the Copilot SDK with the decomposition prompt and
 * parses the response. Returns null on any error so the caller can fall
 * back gracefully.
 *
 * `modelOverride` lets the caller force a specific Copilot model (used by
 * the per-task model picker). Falls back to the env default when missing.
 */
export async function runFeatureDecomposer(
  input: DecomposeInput,
  modelOverride?: string,
  reasoningEffortOverride?: ReasoningEffort,
): Promise<Decomposition | null> {
  const prompt = buildDecompositionPrompt(input);
  const model = modelOverride && modelOverride.trim() ? modelOverride.trim() : DEFAULT_MODEL;
  const reasoningEffort = reasoningEffortOverride ?? deriveReasoningEffort(model);
  try {
    const client = await getCopilotClient();
    const session = await client.createSession({
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      onPermissionRequest: approveAll,
    });
    if (reasoningEffort) {
      try {
        await session.setModel(model, { reasoningEffort });
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), model, reasoningEffort },
          'decomposer: setModel(reasoningEffort) failed — continuing',
        );
      }
    }
    try {
      const result = await session.sendAndWait({ prompt }, DEFAULT_TIMEOUT_MS);
      const content = result?.data?.content?.trim();
      if (!content) {
        logger.warn(
          { workstreamId: input.workstreamId },
          'decomposer: empty LLM response — falling back to single feature',
        );
        return null;
      }
      try {
        const decomp = parseDecomposition(input.workstreamId, content);
        if (!decomp) {
          logger.warn(
            { workstreamId: input.workstreamId, chars: content.length },
            'decomposer: response contained no Feature/Integration headings',
          );
          return null;
        }
        logger.info(
          {
            workstreamId: input.workstreamId,
            features: decomp.features.length,
            hasIntegration: !!decomp.integration,
          },
          'decomposer: parsed decomposition',
        );
        return decomp;
      } catch (parseErr) {
        const msg =
          parseErr instanceof Error ? parseErr.message : String(parseErr);
        logger.warn(
          { workstreamId: input.workstreamId, err: msg },
          'decomposer: parse error — falling back to single feature',
        );
        return null;
      }
    } finally {
      await session.disconnect().catch((err: unknown) => {
        const m = err instanceof Error ? err.message : String(err);
        logger.warn({ err: m }, 'decomposer: error disconnecting Copilot session');
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { workstreamId: input.workstreamId, err: msg },
      'decomposer: SDK error — falling back to single feature',
    );
    return null;
  }
}
