/**
 * Per-agent-role model config resolver.
 *
 * Encapsulates the precedence rules for picking the model + reasoning effort
 * for a given Copilot SDK call. Used everywhere the engine spawns or retunes
 * an SDK session.
 *
 * Resolution order (highest precedence first):
 *   1. Per-task pin           — task.model / task.reviewerModel etc. Today
 *                                only `coder` and `reviewer` have explicit
 *                                task-level fields; other roles fall through.
 *   2. User profile           — `user_agent_defaults` row for (ownerUserId,
 *                                role). Read LIVE on every resolve so profile
 *                                edits take effect on the next turn.
 *   3. Env override           — `COPILOT_<ROLE>_MODEL` if defined.
 *   4. Generic env            — `COPILOT_MODEL` if defined.
 *   5. Constant fallback      — 'claude-sonnet-4.5'.
 *
 * Reasoning effort follows the same chain, with one extra wrinkle: when the
 * resolved model id encodes its effort in the suffix (e.g. `*-xhigh`), the
 * suffix WINS regardless of the chain — that's what `deriveReasoningEffort`
 * enforces and what the SDK actually accepts.
 */

import type {
  AgentConfigRole,
  ReasoningEffort,
  Task,
} from '../../../shared/types/index.js';
import { deriveReasoningEffort } from '../../../shared/types/index.js';
import { getDefault } from '../stores/user-defaults-store.js';
import { logger } from '../logger.js';

const FALLBACK_MODEL = 'claude-sonnet-4.5';

export type ResolvedConfigSource = 'task' | 'user' | 'env' | 'default';

export interface ResolvedAgentConfig {
  model: string;
  /** Effective reasoning effort. May be undefined when no rule applies and the
   *  model id implies nothing (SDK will pick its own default). */
  reasoningEffort?: ReasoningEffort;
  source: ResolvedConfigSource;
  /** Diagnostic — what the user-pinned model was at resolve time, if any.
   *  Useful for activity-log "(profile: gpt-5-mini)" hints. */
  userPinnedModel?: string;
  userPinnedReasoningEffort?: ReasoningEffort;
}

/** Map role → env var name. Generic `COPILOT_MODEL` / `COPILOT_REASONING` are
 *  consulted as a fallback below regardless of role. */
const ROLE_ENV: Record<AgentConfigRole, { model: string; reasoning: string }> = {
  rewriter: { model: 'COPILOT_REWRITER_MODEL', reasoning: 'COPILOT_REWRITER_REASONING' },
  architect: { model: 'COPILOT_ARCHITECT_MODEL', reasoning: 'COPILOT_ARCHITECT_REASONING' },
  critic: { model: 'COPILOT_CRITIC_MODEL', reasoning: 'COPILOT_CRITIC_REASONING' },
  coder: { model: 'COPILOT_CODER_MODEL', reasoning: 'COPILOT_CODER_REASONING' },
  reviewer: { model: 'COPILOT_REVIEWER_MODEL', reasoning: 'COPILOT_REVIEWER_REASONING' },
};

function parseEffortEnv(value: string | undefined): ReasoningEffort | undefined {
  if (!value) return undefined;
  const v = value.toLowerCase().trim();
  if (v === 'low' || v === 'medium' || v === 'high' || v === 'xhigh') return v;
  return undefined;
}

export interface ResolveOptions {
  /** Per-task pin (already extracted from the Task by the caller). Set to
   *  undefined / empty to skip and fall through to the user profile. */
  taskModel?: string;
  taskReasoningEffort?: ReasoningEffort;
}

/** Resolve {model, reasoningEffort} for a given role. Pure function modulo a
 *  read of the user_agent_defaults store; safe to call on every turn-open. */
export function resolveAgentConfig(
  task: Pick<Task, 'ownerUserId'> | null | undefined,
  role: AgentConfigRole,
  opts: ResolveOptions = {},
): ResolvedAgentConfig {
  // 1. Task pin
  if (opts.taskModel && opts.taskModel.trim()) {
    const model = opts.taskModel.trim();
    const reasoningEffort = opts.taskReasoningEffort ?? deriveReasoningEffort(model);
    return {
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      source: 'task',
    };
  }

  // 2. User profile (live read)
  let userPin: { model: string | null; reasoningEffort: ReasoningEffort | null } | null = null;
  if (task?.ownerUserId) {
    try {
      const stored = getDefault(task.ownerUserId, role);
      if (stored) {
        userPin = { model: stored.model, reasoningEffort: stored.reasoningEffort };
      }
    } catch (err) {
      logger.warn(
        { err, userId: task.ownerUserId, role },
        'resolveAgentConfig: user_agent_defaults read failed — falling through to env',
      );
    }
  }
  if (userPin?.model) {
    const model = userPin.model;
    const explicit = userPin.reasoningEffort ?? undefined;
    const reasoningEffort = explicit ?? deriveReasoningEffort(model);
    return {
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      source: 'user',
      userPinnedModel: model,
      ...(explicit ? { userPinnedReasoningEffort: explicit } : {}),
    };
  }

  // 3. Role-specific env
  const roleModelEnv = process.env[ROLE_ENV[role].model];
  const roleEffortEnv = parseEffortEnv(process.env[ROLE_ENV[role].reasoning]);
  if (roleModelEnv && roleModelEnv.trim()) {
    const model = roleModelEnv.trim();
    const reasoningEffort = roleEffortEnv ?? deriveReasoningEffort(model);
    return {
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      source: 'env',
      ...(userPin?.model === null ? { userPinnedModel: '' } : {}),
    };
  }

  // 4. Generic env
  const genericModel = process.env['COPILOT_MODEL'];
  if (genericModel && genericModel.trim()) {
    const model = genericModel.trim();
    const reasoningEffort = parseEffortEnv(process.env['COPILOT_REASONING']) ?? deriveReasoningEffort(model);
    return {
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      source: 'env',
    };
  }

  // 5. Constant fallback
  const model = FALLBACK_MODEL;
  const reasoningEffort = deriveReasoningEffort(model);
  return {
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    source: 'default',
  };
}

/** Convenience: produce a `{model, reasoningEffort}` plain object suitable for
 *  spreading into existing SDK call sites that already accept those two. */
export function resolveAgentSdkParams(
  task: Pick<Task, 'ownerUserId'> | null | undefined,
  role: AgentConfigRole,
  opts: ResolveOptions = {},
): { model: string; reasoningEffort?: ReasoningEffort } {
  const r = resolveAgentConfig(task, role, opts);
  return r.reasoningEffort
    ? { model: r.model, reasoningEffort: r.reasoningEffort }
    : { model: r.model };
}
