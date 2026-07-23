/**
 * Pipeline preflight stages — Rewriter + Architect + Critic.
 *
 * These three stages run BEFORE the coder turn on the main build path. They
 * give every request the visible multi-agent flow:
 *
 *   rewrite → plan → critique → implement → review
 *
 * Design tenets (mirrors `reviewer-loop.ts`):
 *  - BOUNDED — each stage is capped by a short timeout (well under the coder's
 *    budget) so the preflight never dominates the hot path.
 *  - NON-FATAL — any failure is logged and falls back to a safe default
 *    (rewrite → original text, plan → skipped, critique → no feedback). The
 *    main pipeline must never break because a preflight stage hiccupped.
 *  - EPHEMERAL — one fresh, read-only SDK session per stage; disposed after.
 *  - ALWAYS-ON — not gated by `reviewerEnabled`; the critic defaults to the
 *    task's own model when no reviewer model is configured.
 */

import { approveAll } from '@github/copilot-sdk';
import {
  deriveReasoningEffort,
  type ReasoningEffort,
} from '../../../shared/types/index.js';
import { getCopilotClient, isSdkConnectionClosed, resetCopilotClient } from './copilot-client.js';
import { setForceEffort } from './force-effort.js';
import { reviewEvent } from './reviewer-loop.js';
import type { UsageFn } from './agent-loop.js';
import { registerTaskAborter } from './task-interrupt-registry.js';
import { logger } from '../logger.js';

/** Short timeouts — preflight must not dominate the build. Overridable via env. */
const REWRITE_TIMEOUT_MS = parseInt(process.env['PIPELINE_REWRITE_TIMEOUT_MS'] ?? '20000', 10);
const PLAN_TIMEOUT_MS = parseInt(process.env['PIPELINE_PLAN_TIMEOUT_MS'] ?? '45000', 10);
const DEFAULT_MODEL = process.env['COPILOT_MODEL'] ?? 'claude-sonnet-4.5';

export interface StageConfig {
  /** Model to use. Falls back to the server default. */
  model?: string;
  reasoningEffort?: ReasoningEffort;
  /** Repo the task targets (e.g. "owner/repo") — context for the prompts. */
  repository?: string;
  taskId?: string;
  onUsage?: UsageFn;
}

function forwardUsageEvent(
  event: { type: string; data?: unknown },
  onUsage: UsageFn | undefined,
): void {
  if (!onUsage || event.type !== 'assistant.usage') return;
  const data = event.data as {
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    duration?: number;
    copilotUsage?: { totalNanoAiu?: number };
  };
  onUsage({
    model: data.model,
    ...(data.inputTokens != null ? { inputTokens: data.inputTokens } : {}),
    ...(data.outputTokens != null ? { outputTokens: data.outputTokens } : {}),
    ...(data.cacheReadTokens != null
      ? { cacheReadTokens: data.cacheReadTokens }
      : {}),
    ...(data.cacheWriteTokens != null
      ? { cacheWriteTokens: data.cacheWriteTokens }
      : {}),
    ...(data.copilotUsage?.totalNanoAiu != null
      ? { nanoAiu: data.copilotUsage.totalNanoAiu }
      : {}),
    ...(data.duration != null ? { durationMs: data.duration } : {}),
  });
}

function resolveModel(cfg: StageConfig): { model: string; effort: ReasoningEffort | undefined } {
  const model = cfg.model && cfg.model.trim() ? cfg.model.trim() : DEFAULT_MODEL;
  const effort = cfg.reasoningEffort ?? deriveReasoningEffort(model);
  return { model, effort };
}

/** Run a single bounded, read-only SDK turn. Returns the assistant reply, or
 *  null when the call failed / timed out / was disabled. Never throws. */
async function runBoundedTurn(
  prompt: string,
  cfg: StageConfig,
  timeoutMs: number,
  label: string,
): Promise<string | null> {
  const { model, effort } = resolveModel(cfg);
  setForceEffort(effort);

  let client;
  try {
    client = await getCopilotClient();
  } catch (err) {
    logger.warn(
      { label, err: err instanceof Error ? err.message : String(err) },
      'pipeline-stages: getCopilotClient failed — skipping stage',
    );
    return null;
  }

  let session;
  try {
    session = await client.createSession({
      model,
      ...(effort ? { reasoningEffort: effort } : {}),
      enableConfigDiscovery: false,
      onPermissionRequest: approveAll,
      onEvent: (event) => {
        forwardUsageEvent(event, cfg.onUsage);
      },
    });
  } catch (err) {
    logger.warn(
      { label, model, err: err instanceof Error ? err.message : String(err) },
      'pipeline-stages: createSession failed — skipping stage',
    );
    if (isSdkConnectionClosed(err)) void resetCopilotClient();
    return null;
  }

  const unregisterAborter = cfg.taskId
    ? registerTaskAborter(cfg.taskId, () => session.abort())
    : () => undefined;
  let reply = '';
  try {
    const result = await session.sendAndWait({ prompt }, timeoutMs);
    reply = result?.data?.content?.trim() ?? '';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ label, err: msg }, 'pipeline-stages: sendAndWait failed — skipping stage');
    if (isSdkConnectionClosed(err)) void resetCopilotClient();
  } finally {
    unregisterAborter();
    try {
      await session.disconnect();
    } catch {
      // best-effort cleanup
    }
  }

  return reply || null;
}

export interface RewriteResult {
  /** The rephrased request fed forward to the planner + coder. Falls back to
   *  the original text when the stage was skipped or failed. */
  rewritten: string;
  /** True when the rewriter actually produced a (different) rephrasing. */
  ran: boolean;
}

/**
 * Rewriter stage — rephrase the user's request into a crisper, LLM-friendly
 * instruction without changing its meaning or scope. Non-fatal: returns the
 * original text on any failure.
 */
export async function rewriteRequest(
  taskTitle: string,
  request: string,
  cfg: StageConfig,
): Promise<RewriteResult> {
  const original = request.trim();
  if (!original) return { rewritten: request, ran: false };

  const prompt = [
    'You are the **Rewriter Agent** for Liliput. Rephrase the user request below',
    'into a single, crisp, unambiguous instruction optimised for a downstream',
    'coding LLM. Resolve vague pronouns, make implicit requirements explicit, and',
    'keep it concise.',
    '',
    '🛑 Rules:',
    '  - Preserve the original MEANING and SCOPE exactly. Do NOT add new features,',
    '    assumptions, or constraints the user did not state.',
    '  - Do NOT answer the request or write code. Only rewrite it.',
    '  - Output ONLY the rewritten request as plain text — no preamble, no quotes,',
    '    no markdown headers, no explanation.',
    '',
    `Task title: ${taskTitle}`,
    '',
    'Original request:',
    original,
  ].join('\n');

  const reply = await runBoundedTurn(prompt, cfg, REWRITE_TIMEOUT_MS, 'rewrite');
  const rewritten = (reply ?? '').trim();
  if (!rewritten) return { rewritten: request, ran: false };
  return { rewritten, ran: true };
}

export interface PlanResult {
  /** The implementation plan markdown, or null when the stage was skipped/failed. */
  plan: string | null;
  ran: boolean;
}

/**
 * Architect stage — draft a short, ordered implementation plan for the request.
 * Non-fatal: returns `{ plan: null }` on any failure (the coder proceeds
 * without a plan, exactly as it does today).
 */
export async function generatePlan(
  taskTitle: string,
  request: string,
  cfg: StageConfig,
  spec?: string,
): Promise<PlanResult> {
  const prompt = [
    'You are the **Architect Agent** for Liliput. Produce a SHORT implementation',
    'plan for the request below — the plan a senior engineer would jot down before',
    'touching the code.',
    '',
    '🛑 Rules:',
    '  - Do NOT write code. Output a plan only.',
    '  - 3 to 7 ordered steps. Each step one line, action-oriented.',
    '  - Call out the key files/areas to change and any test/verification step.',
    '  - Output GitHub-Flavored Markdown: a `## Plan` heading followed by a',
    '    numbered list. No preamble before the heading.',
    '',
    `Target repository: ${cfg.repository ?? '(none specified)'}`,
    `Task title: ${taskTitle}`,
    '',
    'Request:',
    request.trim(),
    ...(spec ? ['', 'Approved specification:', '```markdown', spec, '```'] : []),
  ].join('\n');

  const reply = await runBoundedTurn(prompt, cfg, PLAN_TIMEOUT_MS, 'plan');
  const plan = (reply ?? '').trim();
  if (!plan) return { plan: null, ran: false };
  return { plan, ran: true };
}

export interface CritiqueResult {
  /** Critic feedback bullets, or null when the critic had nothing to add. */
  feedback: string | null;
  ran: boolean;
}

/**
 * Critic stage — rubber-duck the plan before implementation. Reuses the
 * reviewer-loop machinery (bounded, read-only, NO-FEEDBACK/FEEDBACK protocol)
 * via a dedicated `plan` review context. Single-pass: the critique is fed
 * forward into the coder, never looped back to the planner.
 */
export async function critiquePlan(
  taskTitle: string,
  request: string,
  plan: string,
  cfg: StageConfig,
): Promise<CritiqueResult> {
  try {
    const result = await reviewEvent(
      {
        kind: 'plan',
        ...(cfg.repository ? { repository: cfg.repository } : {}),
        taskTitle,
        taskDescription: request,
        plan,
      },
      {
        ...(cfg.model ? { model: cfg.model } : {}),
        ...(cfg.reasoningEffort ? { reasoningEffort: cfg.reasoningEffort } : {}),
        ...(cfg.taskId ? { taskId: cfg.taskId } : {}),
        ...(cfg.onUsage ? { onUsage: cfg.onUsage } : {}),
      },
    );
    return { feedback: result.feedback, ran: result.ran };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'pipeline-stages: critiquePlan threw (swallowed)',
    );
    return { feedback: null, ran: false };
  }
}

/**
 * Compose the planning-context block that gets injected into the coder turn.
 * Bundles the rewritten request, the plan, and any critic feedback into a
 * single markdown block. Returns '' when there is nothing useful to inject.
 */
export function composePlanningContext(parts: {
  rewritten?: string;
  plan?: string | null;
  critique?: string | null;
}): string {
  const sections: string[] = [];
  if (parts.rewritten && parts.rewritten.trim()) {
    sections.push('### ✍️ Rewritten request (Rewriter Liliputian)', '', parts.rewritten.trim());
  }
  if (parts.plan && parts.plan.trim()) {
    sections.push('', '### 🗺️ Implementation plan (Architect Liliputian)', '', parts.plan.trim());
  }
  if (parts.critique && parts.critique.trim()) {
    sections.push(
      '',
      '### 🦆 Plan critique (Critic Liliputian)',
      '',
      'Address these points as you implement:',
      '',
      parts.critique.trim(),
    );
  }
  if (sections.length === 0) return '';
  return ['## Pre-implementation planning', '', ...sections].join('\n');
}
