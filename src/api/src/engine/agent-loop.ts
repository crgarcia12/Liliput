/**
 * SDK-driven editing loop.
 *
 * The previous implementation built a giant prompt locally (repo tree + key
 * file previews) and asked the model for a JSON `EditPlan`. That capped the
 * agent's view of the repo at 200 paths × 5 file previews and made the
 * EditPlan parser the single source of fragility.
 *
 * This implementation hands the keys to the Copilot SDK:
 *   - `workingDirectory`   → tools (read, write, edit, grep, glob, bash) operate
 *                            directly on the cloned target repo.
 *   - `enableConfigDiscovery` → loads target-repo `.mcp.json` + `.github/skills/`
 *                            on top of the always-loaded `AGENTS.md` and
 *                            `.github/copilot-instructions.md`.
 *   - `approveAll`         → auto-approves every read/write/bash without
 *                            prompting the human (full autopilot).
 *   - `onEvent`            → every tool call, skill invocation, sub-agent
 *                            start/stop and reasoning block is streamed back
 *                            to the caller for live UI display.
 *
 * The agent decides which files to read and writes them directly with the
 * built-in `write`/`edit` tools. We compute the changed-file list afterwards
 * via `git status --porcelain`.
 */

import { approveAll } from '@github/copilot-sdk';
import type { CopilotSession, SessionEvent } from '@github/copilot-sdk';
import { getCopilotClient, isSdkConnectionClosed, resetCopilotClient, IdleTimeoutError } from './copilot-client.js';
import { deriveReasoningEffort, type ReasoningEffort } from '../../../shared/types/index.js';
import { setForceEffort } from './force-effort.js';
import { buildDeployContract, type DeployContractContext } from './liliput-deploy-contract.js';
import {
  buildManagedDeliveryContract,
  type ManagedDeliveryContractInput,
} from './managed-delivery-contract.js';
import { logger } from '../logger.js';

const DEFAULT_MODEL = process.env['COPILOT_MODEL'] ?? 'claude-sonnet-4.5';
// No wall-clock timeout: the SDK streams an event for every tool call, so a
// turn that's actively making progress should never be killed. Wedged turns
// are caught either by the user (Stop button / new chat message → preempt)
// or by the idle watchdog below. We pass a paranoid 24h backstop here purely
// to satisfy the SDK signature — any turn that hits that is genuinely lost.
const TIMEOUT_MS = parseInt(process.env['AGENT_LOOP_TIMEOUT_MS'] ?? '86400000', 10);

// Idle watchdog: if the SDK fires no event for this long, abort the turn so
// the iteration layer can resurrect and retry. 8 minutes is comfortably
// longer than any single legitimate tool call (long npm installs, big
// docker builds, slow tests) but short enough that genuine wedges are
// caught quickly.
const IDLE_THRESHOLD_MS = parseInt(process.env['AGENT_IDLE_THRESHOLD_MS'] ?? '480000', 10);
const IDLE_CHECK_INTERVAL_MS = 30_000;

// Safety caps for the activity log. Set high enough that normal assistant
// messages, reasoning blocks, and tool results are never truncated — they
// exist only to prevent a pathological payload (e.g. a multi-MB `bash` dump)
// from blowing up the socket frame, DB row, or browser DOM.
const ARGS_PREVIEW = 50_000;
const RESULT_PREVIEW = 50_000;
const REASONING_PREVIEW = 50_000;

export interface ToolEvent {
  /** Stable id from the SDK, ties tool-start ↔ tool-complete. */
  callId: string;
  kind:
    | 'tool-start'
    | 'tool-complete'
    | 'skill-invoked'
    | 'subagent-start'
    | 'subagent-complete'
    | 'reasoning'
    | 'message'
    | 'error';
  /** Tool / skill / sub-agent name, when applicable. */
  tool?: string;
  /** One-line summary suitable for an activity log row. */
  summary: string;
  /** Optional structured detail (truncated stdout, file path, etc). */
  details?: string;
  timestamp: string;
}

export type LogFn = (
  level: 'info' | 'warn' | 'error',
  message: string,
  command?: string,
  output?: string,
) => void;
export type ToolEventFn = (event: ToolEvent) => void;

/** Token-usage delta from a single LLM API call within a turn.
 *  Mirrors the SDK's `assistant.usage` event shape. */
export interface UsageEvent {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Copilot "nano-AIU" cost when the SDK provides it. */
  nanoAiu?: number;
  durationMs?: number;
}
export type UsageFn = (event: UsageEvent) => void;

interface TurnCallbacks {
  log: LogFn;
  toolEvent: ToolEventFn;
  usage: UsageFn;
  toolCount: number;
}

/**
 * A long-lived agent session bound to a single workspace.
 *
 * Conversation history accumulates across calls to {@link runAgentTurn},
 * so follow-up turns inherit context from earlier ones — same model
 * memory the user gets in `copilot` CLI between prompts.
 */
export interface AgentSession {
  workspaceRoot: string;
  /** Model id used to create this SDK session (e.g. "gpt-5", "claude-sonnet-4.5"). */
  model: string;
  /** Reasoning effort currently active on this session (after createSession + setModel). */
  reasoningEffort?: ReasoningEffort;
  /** @internal */
  _session: CopilotSession;
  /** @internal mutable so callers can swap log/event callbacks per turn. */
  _callbacks: TurnCallbacks;
  /** @internal immutable task context reused by purpose-built fixer prompts. */
  _deliveryContext?: ManagedDeliveryContractInput;
}

export interface RunAgentTurnOptions {
  taskTitle: string;
  taskDescription: string;
  spec?: string;
  repository?: string;
  baseBranch?: string;
  taskBranch?: string;
  baseCommitSha?: string;
  workspaceRoot?: string;
  /** Optional follow-up instruction from the user (chat message). */
  followUp?: string;
  /** True for the very first turn (we include task title/spec); false for iterations. */
  isInitial: boolean;
  /**
   * If set, this string is sent verbatim as the prompt — bypassing both the
   * initial template and the follow-up wrapper. Use for purpose-built turns
   * (e.g. ops-fixer) where the wrapper text would be misleading.
   */
  promptOverride?: string;
  /**
   * Liliput runtime context (path-prefix, port, devUrl). When provided, the
   * Liliput Deploy Contract is injected on every turn. This intentionally does
   * not rely on conversation memory, which may be lost after session recovery.
   */
  liliputContext?: DeployContractContext;
  /**
   * Optional per-turn timeout override (milliseconds). Default = TIMEOUT_MS.
   * Useful for ops turns that need longer than 15 minutes for build+fix loops.
   */
  timeoutMs?: number;
  /**
   * Optional recap of prior conversation. Used after a session resurrection
   * (the SDK lost its memory due to pod restart) to restore continuity. The
   * agent gets a `## Recap of previous session` block before the new
   * instruction so it knows what was already discussed/attempted.
   */
  recap?: string;
  /**
   * Optional Reviewer-Agent feedback to inject into THIS turn's prompt. The
   * reviewer runs after each pipeline run and may flag important issues the
   * coder missed; this block routes that feedback into the next coder turn
   * so it can be addressed. The feedback is rendered above the user's
   * instruction so the coder sees it as additional context.
   */
  reviewerFeedback?: string;
  /**
   * Optional planning context produced by the pipeline preflight stages
   * (Rewriter + Architect + Critic). When set, this block is rendered above
   * the user's instruction so the coder starts from the rewritten request,
   * the implementation plan, and any critic feedback. Non-fatal: when the
   * preflight stages are skipped or fail, this is simply omitted.
   */
  planningContext?: string;
  onLog?: LogFn;
  onToolEvent?: ToolEventFn;
  onUsage?: UsageFn;
}

export interface RunAgentResult {
  /** Final assistant message — typically a 2-3 sentence summary. */
  summary: string;
  /** Number of tool calls made during this turn. */
  toolCallCount: number;
}

export function setAgentDeliveryContext(
  handle: AgentSession,
  context: ManagedDeliveryContractInput,
): void {
  handle._deliveryContext = {
    ...context,
    workspaceRoot: context.workspaceRoot ?? handle.workspaceRoot,
  };
}

export function buildManagedPromptOverride(
  context: ManagedDeliveryContractInput,
  promptOverride: string,
): string {
  return [
    buildManagedDeliveryContract(context),
    '',
    '---',
    '',
    promptOverride,
  ].join('\n');
}

function summariseArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (parts.length >= 3) break;
    if (typeof v === 'string') {
      parts.push(`${k}="${truncate(v, 60)}"`);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      parts.push(`${k}=${v}`);
    }
  }
  return parts.join(' ');
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.substring(0, n) + '…';
}

function summariseResult(content: unknown): { summary: string; details?: string } {
  if (!Array.isArray(content)) return { summary: '' };
  for (const c of content) {
    const block = c as { type?: string; text?: string };
    if (block?.type === 'text' && typeof block.text === 'string') {
      const t = block.text.trim();
      return {
        summary: truncate(t, RESULT_PREVIEW),
      };
    }
  }
  return { summary: '' };
}

function buildPlanningBlock(planningContext?: string): string {
  if (!planningContext || !planningContext.trim()) return '';
  return [planningContext.trim(), '', '---', ''].join('\n');
}

function buildVerdictContract(): string {
  return [
    '## Verdict and evidence',
    '',
    'Always end your reply with exactly one verdict line:',
    '    VERDICT: done — <one-line implementation-ready summary>',
    '    VERDICT: blocked — <reason you genuinely cannot continue>',
    '    VERDICT: continue — <what remains incomplete>',
    '',
    '`done` means the repository implementation is complete and locally verified for',
    'Liliput to package and deploy. It does NOT claim that deployment is already healthy;',
    'Liliput performs deployment and live validation after this turn. Use `blocked` only',
    'for a real external blocker. Use `continue` when required code or verification is',
    'still unfinished.',
    '',
    'When (and ONLY when) you emit `VERDICT: done`, include an `evidence` fenced block',
    'above it with actual relevant command output. Do not paraphrase or invent output:',
    '',
    '    ```evidence',
    '    $ <test command that exists in this repository>',
    '    <last lines including the pass/fail summary>',
    '',
    '    $ <build/type-check command that exists in this repository>',
    '    <last lines showing success>',
    '',
    '    $ <any acceptance-specific verification command>',
    '    <actual output>',
    '    ```',
    '',
    'If required checks fail or were not run, do not emit `done`.',
  ].join('\n');
}

function deliveryContractForTurn(opts: RunAgentTurnOptions): string {
  return buildManagedDeliveryContract({
    taskTitle: opts.taskTitle,
    taskDescription: opts.taskDescription,
    spec: opts.spec,
    repository: opts.repository,
    baseBranch: opts.baseBranch,
    taskBranch: opts.taskBranch,
    baseCommitSha: opts.baseCommitSha,
    workspaceRoot: opts.workspaceRoot,
  });
}

function buildReviewerFeedbackBlock(feedback?: string): string {
  if (!feedback?.trim()) return '';
  return [feedback.trim(), '', '---', ''].join('\n');
}

export function buildInitialPrompt(opts: RunAgentTurnOptions): string {
  const deployContract = opts.liliputContext
    ? buildDeployContract(opts.liliputContext)
    : '';
  return [
    deliveryContractForTurn(opts),
    '',
    '---',
    '',
    deployContract,
    deployContract ? '\n---\n' : '',
    buildPlanningBlock(opts.planningContext),
    buildReviewerFeedbackBlock(opts.reviewerFeedback),
    'You are the implementation agent for this task. Work directly in the repository',
    'using your tools. You have full autonomy to read files, edit files, install required',
    'dependencies, run commands, and iterate until the implementation-ready boundary is met.',
    '',
    '## Execution workflow',
    '',
    '1. **Ground yourself** — Inspect README files, manifests, source, tests, git status,',
    '   current branch, and origin before editing. Confirm this is the target above.',
    '2. **Plan and execute** — Think through every affected layer, then implement in this',
    '   same turn. Do not stop after producing a plan.',
    '3. **Test first where reasonable** — Create or update executable tests for the',
    '   acceptance criteria and confirm they fail for the expected reason before the fix.',
    '   If the approved spec contains Gherkin scenarios, keep feature files and executable',
    '   step definitions aligned with the production behavior.',
    '4. **Implement end to end** — Make the smallest complete production change. Handle',
    '   relevant errors and edge cases; do not substitute documentation or scaffolding for',
    '   the requested capability.',
    '5. **Verify** — Run the repository\'s relevant build, type-check, lint, unit,',
    '   integration, and end-to-end commands. Exercise the critical user flow locally when',
    '   the repository supports it.',
    '6. **Inspect the final diff** — Ensure every changed file belongs to this task and',
    '   remove generated dependencies, caches, build output, secrets, and unrelated edits.',
    '',
    'Do not merely describe code or output a patch in chat: edit and verify the files.',
    '',
    '## Runtime environment',
    '',
    'Liliput packages, deploys, and live-validates the repository after this turn. Make',
    'sure the application has a viable Docker/runtime path, listens on `0.0.0.0`, reads',
    'ports and base paths from configuration where applicable, and does not hardcode',
    'localhost-only URLs.',
    opts.liliputContext?.pathPrefix
      ? `The app must work under reverse-proxy prefix \`${opts.liliputContext.pathPrefix}\`.`
      : '',
    '',
    'If an important CLI is unavailable, emit `TOOL-WISH: <tool> — <reason>` and continue',
    'with the best available path. A tool wish is not a blocker.',
    '',
    buildVerdictContract(),
    '',
    'Finish with a concise summary of actual changes and verification. Do not quote or',
    'restate the original user prompt.',
  ]
    .filter((s) => s !== '')
    .join('\n');
}

export function buildFollowUpPrompt(opts: RunAgentTurnOptions): string {
  const deployContract = opts.liliputContext
    ? buildDeployContract(opts.liliputContext)
    : '';
  return [
    deliveryContractForTurn(opts),
    '',
    '---',
    '',
    deployContract,
    deployContract ? '\n---\n' : '',
    opts.recap ? '## Recap of previous session' : '',
    opts.recap ?? '',
    opts.recap ? '' : '',
    buildPlanningBlock(opts.planningContext),
    buildReviewerFeedbackBlock(opts.reviewerFeedback),
    'Continue in the existing workspace. Conversation memory may be incomplete, so inspect',
    'the current files, git status, branch, origin, and diff before deciding what remains.',
    'Preserve correct prior work and satisfy the new instruction without losing the original',
    'task or approved specification above.',
    '',
    'Run relevant existing verification and fix regressions caused by the change. Do not',
    'create no-op comments, blank lines, marker files, or meaningless commits to force a',
    'rebuild; Liliput can rebuild an unchanged commit directly.',
    '',
    'Edit files rather than describing a patch. Keep the diff task-focused and free of',
    'generated dependencies, build output, caches, environment files, and secrets.',
    '',
    buildVerdictContract(),
    '',
    '## New instruction',
    '',
    opts.followUp ??
      'Review the current state and continue until the approved task is implementation-ready.',
  ]
    .filter((s) => s !== '')
    .join('\n');
}

function makeEventHandler(callbacks: TurnCallbacks): (event: SessionEvent) => void {
  // Tool name isn't included on tool.execution_complete by the SDK — only on
  // tool.execution_start. Track the mapping so downstream consumers (the
  // checkpoint writer in particular) can filter by tool on completion.
  const callIdToToolName = new Map<string, string>();
  return (event: SessionEvent) => {
    const ts = event.timestamp ?? new Date().toISOString();
    const { log, toolEvent } = callbacks;

    switch (event.type) {
      case 'tool.execution_start': {
        callbacks.toolCount += 1;
        const data = event.data;
        callIdToToolName.set(data.toolCallId, data.toolName);
        const argSummary = summariseArgs(data.arguments);
        const summary = `▶ ${data.toolName}${argSummary ? ` ${argSummary}` : ''}`;
        log('info', summary);
        toolEvent({
          callId: data.toolCallId,
          kind: 'tool-start',
          tool: data.toolName,
          summary: truncate(summary, ARGS_PREVIEW),
          timestamp: ts,
        });
        break;
      }
      case 'tool.execution_complete': {
        const data = event.data;
        const { summary: resSummary, details } = summariseResult(data.result?.content);
        const ok = data.success;
        const summary = `${ok ? '✓' : '✗'} ${resSummary || '(done)'}`;
        // Persist completion to logs so it appears after-the-fact (not just live wire events).
        log(ok ? 'info' : 'warn', summary, undefined, details);
        if (!ok) log('warn', `Tool ${data.toolCallId} failed: ${data.error?.message ?? ''}`);
        const toolName = callIdToToolName.get(data.toolCallId);
        callIdToToolName.delete(data.toolCallId);
        toolEvent({
          callId: data.toolCallId,
          kind: 'tool-complete',
          tool: toolName,
          summary: truncate(summary, ARGS_PREVIEW),
          details,
          timestamp: ts,
        });
        break;
      }
      case 'skill.invoked': {
        const data = event.data;
        const summary = `🧩 skill: ${data.name}${data.description ? ` — ${data.description}` : ''}`;
        log('info', summary);
        toolEvent({
          callId: event.id,
          kind: 'skill-invoked',
          tool: data.name,
          summary: truncate(summary, ARGS_PREVIEW),
          timestamp: ts,
        });
        break;
      }
      case 'subagent.started': {
        const data = event.data;
        const summary = `↪ sub-agent ${data.agentDisplayName} started`;
        log('info', summary);
        toolEvent({
          callId: data.toolCallId,
          kind: 'subagent-start',
          tool: data.agentName,
          summary,
          details: data.agentDescription,
          timestamp: ts,
        });
        break;
      }
      case 'subagent.completed': {
        const data = event.data;
        const dur = data.durationMs ? ` (${Math.round(data.durationMs / 1000)}s)` : '';
        const summary = `✓ sub-agent ${data.agentDisplayName} done${dur}`;
        log('info', summary);
        toolEvent({
          callId: data.toolCallId,
          kind: 'subagent-complete',
          tool: data.agentName,
          summary,
          timestamp: ts,
        });
        break;
      }
      case 'assistant.reasoning': {
        const content = event.data.content?.trim() ?? '';
        if (!content) break;
        const full = truncate(content, REASONING_PREVIEW);
        log('info', `🧠 ${full}`);
        toolEvent({
          callId: event.data.reasoningId,
          kind: 'reasoning',
          summary: `🧠 ${full}`,
          timestamp: ts,
        });
        break;
      }
      case 'assistant.message': {
        const content = event.data.content?.trim() ?? '';
        if (!content) break;
        const full = truncate(content, RESULT_PREVIEW);
        log('info', `💬 ${full}`);
        toolEvent({
          callId: event.data.messageId,
          kind: 'message',
          summary: `💬 ${full}`,
          timestamp: ts,
        });
        break;
      }
      case 'session.error': {
        const data = event.data;
        const summary = `⚠ ${data.errorType}: ${data.message}`;
        log('error', summary);
        toolEvent({
          callId: event.id,
          kind: 'error',
          summary,
          details: data.stack,
          timestamp: ts,
        });
        break;
      }
      case 'assistant.usage': {
        // SDK reports per-LLM-call token usage. We forward to the usage
        // callback so the engine can aggregate onto the owning Turn.
        const d = event.data as {
          model: string;
          inputTokens?: number;
          outputTokens?: number;
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
          duration?: number;
          copilotUsage?: { totalNanoAiu?: number };
        };
        callbacks.usage({
          model: d.model,
          ...(d.inputTokens != null ? { inputTokens: d.inputTokens } : {}),
          ...(d.outputTokens != null ? { outputTokens: d.outputTokens } : {}),
          ...(d.cacheReadTokens != null ? { cacheReadTokens: d.cacheReadTokens } : {}),
          ...(d.cacheWriteTokens != null ? { cacheWriteTokens: d.cacheWriteTokens } : {}),
          ...(d.copilotUsage?.totalNanoAiu != null
            ? { nanoAiu: d.copilotUsage.totalNanoAiu }
            : {}),
          ...(d.duration != null ? { durationMs: d.duration } : {}),
        });
        break;
      }
      default:
        // Many other events exist (deltas, lifecycle); ignore for now.
        break;
    }
  };
}

const noLog: LogFn = () => {};
const noEvent: ToolEventFn = () => {};
const noUsage: UsageFn = () => {};

/**
 * Creates a fresh SDK session bound to the given workspace.
 * The session is left connected so subsequent {@link runAgentTurn} calls
 * accumulate conversation history.
 */
export async function createAgentSession(
  workspaceRoot: string,
  modelOverride?: string,
  reasoningEffortOverride?: ReasoningEffort,
): Promise<AgentSession> {
  const client = await getCopilotClient();
  // Mutable callbacks ref so per-turn callers can swap their log destination
  // without recreating the session (and losing conversation memory).
  const callbacks: TurnCallbacks = {
    log: noLog,
    toolEvent: noEvent,
    usage: noUsage,
    toolCount: 0,
  };
  const model = modelOverride && modelOverride.trim() ? modelOverride.trim() : DEFAULT_MODEL;
  const reasoningEffort = reasoningEffortOverride ?? deriveReasoningEffort(model);
  setForceEffort(reasoningEffort);
  logger.info(
    {
      workspaceRoot,
      modelOverride,
      reasoningEffortOverride,
      resolvedModel: model,
      resolvedEffort: reasoningEffort,
    },
    '[effort-trace] createAgentSession: about to call client.createSession',
  );
  const session = await client.createSession({
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    workingDirectory: workspaceRoot,
    enableConfigDiscovery: true, // auto-load .mcp.json + skills from target repo
    onPermissionRequest: approveAll,
    onEvent: makeEventHandler(callbacks),
  });
  logger.info(
    { resolvedModel: model, resolvedEffort: reasoningEffort },
    '[effort-trace] createAgentSession: client.createSession returned',
  );
  // Belt-and-suspenders: some models (e.g. claude-opus-4.7-xhigh) reject the
  // SDK's per-request default reasoning_effort="medium" even when we passed
  // the correct value to createSession. Re-issue it via the documented
  // setModel switcher so the per-turn CAPI call carries the right value.
  if (reasoningEffort) {
    try {
      logger.info(
        { model, reasoningEffort },
        '[effort-trace] createAgentSession: calling session.setModel for belt-and-suspenders',
      );
      await session.setModel(model, { reasoningEffort });
      logger.info(
        { model, reasoningEffort },
        '[effort-trace] createAgentSession: session.setModel returned (note: SDK may silently no-op if validator rejects)',
      );
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), model, reasoningEffort },
        'agent-loop: setModel(reasoningEffort) failed — continuing with createSession value',
      );
    }
  }
  return { workspaceRoot, _session: session, _callbacks: callbacks, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

/**
 * Apply a runtime model and/or reasoning-effort change to an existing session.
 *
 * When ONLY the model changes, we use `setModel()` to keep the cached SDK
 * session (and its conversation memory) alive.
 *
 * When the **reasoning effort** changes we DISPOSE the old session and
 * create a fresh one. The agent CLI's session-level reasoning_effort is
 * baked in at session create time; `setModel()` does not actually re-apply
 * it on subsequent CAPI requests, so we end up sending stale values
 * (e.g. "medium" when the model only accepts "high"). Losing chat memory
 * is the lesser evil compared to the SDK 400-ing on every turn.
 *
 * No-op if neither value differs from what the session already has.
 */
export async function applyModelChange(
  handle: AgentSession,
  nextModel: string | undefined,
  nextReasoningEffort?: ReasoningEffort,
): Promise<void> {
  const desiredModel = nextModel && nextModel.trim() ? nextModel.trim() : DEFAULT_MODEL;
  const desiredEffort = nextReasoningEffort ?? deriveReasoningEffort(desiredModel);
  if (desiredModel === handle.model && desiredEffort === handle.reasoningEffort) {
    return;
  }
  setForceEffort(desiredEffort);
  const effortChanged = desiredEffort !== handle.reasoningEffort;
  if (effortChanged) {
    // Reasoning-effort change: dispose old session, create a new one. The
    // agent CLI's per-request reasoning_effort is fixed at session create
    // time and cannot be reliably re-targeted via setModel.
    logger.info(
      {
        previousModel: handle.model,
        previousEffort: handle.reasoningEffort,
        desiredModel,
        desiredEffort,
      },
      'agent-loop: reasoning_effort changed — recreating SDK session (chat memory will reset)',
    );
    try {
      await handle._session.disconnect();
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'agent-loop: error disconnecting old session — proceeding to create new',
      );
    }
    const client = await getCopilotClient();
    logger.info(
      { desiredModel, desiredEffort },
      '[effort-trace] applyModelChange: recreating session with new effort',
    );
    const session = await client.createSession({
      model: desiredModel,
      ...(desiredEffort ? { reasoningEffort: desiredEffort } : {}),
      workingDirectory: handle.workspaceRoot,
      enableConfigDiscovery: true,
      onPermissionRequest: approveAll,
      onEvent: makeEventHandler(handle._callbacks),
    });
    if (desiredEffort) {
      try {
        await session.setModel(desiredModel, { reasoningEffort: desiredEffort });
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), desiredModel, desiredEffort },
          'agent-loop: post-recreate setModel failed — continuing with createSession value',
        );
      }
    }
    handle._session = session;
    handle.model = desiredModel;
    if (desiredEffort) {
      handle.reasoningEffort = desiredEffort;
    } else {
      delete handle.reasoningEffort;
    }
    return;
  }
  // Model-only change → keep the session alive via setModel.
  try {
    await handle._session.setModel(desiredModel, {});
    handle.model = desiredModel;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), desiredModel },
      'agent-loop: applyModelChange (model-only) failed — session keeps previous values',
    );
  }
}

/**
 * Runs one agent turn against the workspace. Conversation memory is preserved
 * across calls — this is exactly the multi-turn loop you get with
 * `copilot` CLI between prompts, but persistent in the cluster.
 */
export async function runAgentTurn(
  handle: AgentSession,
  opts: RunAgentTurnOptions,
): Promise<RunAgentResult> {
  const log = opts.onLog ?? noLog;
  const onEvent = opts.onToolEvent ?? noEvent;
  const onUsage = opts.onUsage ?? noUsage;

  // Idle watchdog: every SDK event (tool call, reasoning, message, log line)
  // resets `lastEventAt`. A 30s interval checks for idle; if the gap exceeds
  // IDLE_THRESHOLD_MS we abort the session and throw IdleTimeoutError so
  // iterateTask can resurrect + retry.
  let lastEventAt = Date.now();
  const wrappedLog: LogFn = (level, message, command, output) => {
    lastEventAt = Date.now();
    log(level, message, command, output);
  };
  const wrappedEvent: ToolEventFn = (event) => {
    lastEventAt = Date.now();
    onEvent(event);
  };
  const wrappedUsage: UsageFn = (event) => {
    lastEventAt = Date.now();
    onUsage(event);
  };

  // Swap the live callbacks so the session-level event handler routes events
  // to this turn's destinations.
  handle._callbacks.log = wrappedLog;
  handle._callbacks.toolEvent = wrappedEvent;
  handle._callbacks.usage = wrappedUsage;
  const before = handle._callbacks.toolCount;

  if (!opts.promptOverride) {
    setAgentDeliveryContext(handle, {
      taskTitle: opts.taskTitle,
      taskDescription: opts.taskDescription,
      spec: opts.spec,
      repository: opts.repository,
      baseBranch: opts.baseBranch,
      taskBranch: opts.taskBranch,
      baseCommitSha: opts.baseCommitSha,
      workspaceRoot: opts.workspaceRoot ?? handle.workspaceRoot,
    });
  }
  const effectiveContext = handle._deliveryContext ?? {
    taskTitle: opts.taskTitle,
    taskDescription: opts.taskDescription,
    spec: opts.spec,
    repository: opts.repository,
    baseBranch: opts.baseBranch,
    taskBranch: opts.taskBranch,
    baseCommitSha: opts.baseCommitSha,
    workspaceRoot: opts.workspaceRoot ?? handle.workspaceRoot,
  };
  const promptOptions: RunAgentTurnOptions = {
    ...opts,
    ...effectiveContext,
  };
  const prompt = opts.promptOverride
    ? buildManagedPromptOverride(effectiveContext, opts.promptOverride)
    : promptOptions.isInitial
      ? buildInitialPrompt(promptOptions)
      : buildFollowUpPrompt(promptOptions);

  // Re-assert force-override before every turn — another task may have
  // overwritten the file between the session creation and now.
  setForceEffort(handle.reasoningEffort);

  log('info', opts.isInitial ? 'Asking agent to plan and apply edits…' : 'Sending follow-up to agent…');

  // Watchdog uses a Promise.race so the rejection is guaranteed even when
  // the SDK's sendAndWait hangs (CLI subprocess wedged, abort() best-effort).
  let idleAbort: IdleTimeoutError | undefined;
  let rejectIdle: ((err: IdleTimeoutError) => void) | undefined;
  const idlePromise = new Promise<never>((_, reject) => {
    rejectIdle = reject;
  });
  const watchdog = setInterval(() => {
    const idle = Date.now() - lastEventAt;
    if (idle > IDLE_THRESHOLD_MS) {
      if (idleAbort) return; // already firing
      idleAbort = new IdleTimeoutError(idle);
      logger.warn(
        { idleMs: idle, thresholdMs: IDLE_THRESHOLD_MS },
        'Idle watchdog: no SDK event — aborting turn so iteration layer can retry',
      );
      // Best-effort abort to free SDK resources; even if it does not unblock
      // sendAndWait, the Promise.race below ensures we propagate the throw.
      void handle._session.abort().catch(() => undefined);
      clearInterval(watchdog);
      rejectIdle?.(idleAbort);
    }
  }, IDLE_CHECK_INTERVAL_MS);

  let finalMessage = '';
  try {
    logger.info(
      {
        cachedModel: handle.model,
        cachedEffort: handle.reasoningEffort,
        promptBytes: prompt.length,
      },
      '[effort-trace] runAgentTurn: about to sendAndWait (per-turn CAPI request will use cached model/effort)',
    );
    const sendPromise = handle._session.sendAndWait({ prompt }, opts.timeoutMs ?? TIMEOUT_MS);
    const result = await Promise.race([sendPromise, idlePromise]);
    finalMessage = result?.data?.content?.trim() ?? '';
  } catch (err) {
    // If the abort was driven by our watchdog, surface that as the typed
    // recoverable error rather than the SDK's generic abort message.
    if (idleAbort) {
      logger.error(
        { idleMs: idleAbort.idleMs },
        'SDK session turn failed: idle-watchdog abort',
      );
      // The SDK CLI subprocess may itself be wedged — recycle it so the
      // resurrection turn starts from a fresh process.
      void resetCopilotClient();
      throw idleAbort;
    }
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'SDK session turn failed');
    if (isSdkConnectionClosed(err)) {
      // The SDK's CLI subprocess died. Discard the singleton so the next
      // call spawns a fresh one — otherwise every subsequent session will
      // hit "Connection is closed" forever (the dead pipe never recovers).
      void resetCopilotClient();
    }
    throw err;
  } finally {
    clearInterval(watchdog);
  }

  const tools = handle._callbacks.toolCount - before;
  log('info', `Turn finished after ${tools} tool calls. Summary: ${truncate(finalMessage, 200)}`);

  return {
    summary: finalMessage || '(no summary)',
    toolCallCount: tools,
  };
}

/**
 * Cancels the in-flight `sendAndWait` for this session. The session itself
 * remains valid — the next `runAgentTurn` call can continue the conversation
 * (the SDK preserves message history across abort).
 *
 * Used to preempt a running agent turn when the user sends a new chat message
 * mid-flight, so the agent can stop what it's doing and address the new
 * instruction.
 */
export async function abortAgentTurn(handle: AgentSession): Promise<void> {
  try {
    await handle._session.abort();
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'SDK session abort failed',
    );
  }
}

/** Disconnects the session, releasing in-memory handlers. Workspace files survive. */
export async function disposeAgentSession(handle: AgentSession): Promise<void> {
  try {
    await handle._session.disconnect();
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'SDK session disconnect failed',
    );
  }
}

// ─── Backwards-compat wrapper ─────────────────────────────────────
// Some callers may still import { runAgent } expecting a one-shot.
// We keep a thin wrapper that creates → runs → disconnects.
export interface RunAgentOptions {
  workspaceRoot: string;
  taskTitle: string;
  taskDescription: string;
  spec?: string;
  onLog?: LogFn;
  onToolEvent?: ToolEventFn;
  onUsage?: UsageFn;
}

export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const session = await createAgentSession(opts.workspaceRoot);
  try {
    return await runAgentTurn(session, {
      taskTitle: opts.taskTitle,
      taskDescription: opts.taskDescription,
      spec: opts.spec,
      isInitial: true,
      onLog: opts.onLog,
      onToolEvent: opts.onToolEvent,
      onUsage: opts.onUsage,
    });
  } finally {
    await disposeAgentSession(session);
  }
}
