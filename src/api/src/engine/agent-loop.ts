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
import { getCopilotClient } from './copilot-client.js';
import { logger } from '../logger.js';

const MODEL = process.env['COPILOT_MODEL'] ?? 'claude-sonnet-4';
// Default: 15 minutes for a single turn. Bigger repos with multi-file changes
// can take 8-10+ minutes once the agent is reading files itself.
const TIMEOUT_MS = parseInt(process.env['AGENT_LOOP_TIMEOUT_MS'] ?? '900000', 10);

// Truncation limits to keep the activity log readable.
const ARGS_PREVIEW = 200;
const RESULT_PREVIEW = 800;
const REASONING_PREVIEW = 400;

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

export type LogFn = (level: 'info' | 'warn' | 'error', message: string) => void;
export type ToolEventFn = (event: ToolEvent) => void;

interface TurnCallbacks {
  log: LogFn;
  toolEvent: ToolEventFn;
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
  /** @internal */
  _session: CopilotSession;
  /** @internal mutable so callers can swap log/event callbacks per turn. */
  _callbacks: TurnCallbacks;
}

export interface RunAgentTurnOptions {
  taskTitle: string;
  taskDescription: string;
  spec?: string;
  /** Optional follow-up instruction from the user (chat message). */
  followUp?: string;
  /** True for the very first turn (we include task title/spec); false for iterations. */
  isInitial: boolean;
  onLog?: LogFn;
  onToolEvent?: ToolEventFn;
}

export interface RunAgentResult {
  /** Final assistant message — typically a 2-3 sentence summary. */
  summary: string;
  /** Number of tool calls made during this turn. */
  toolCallCount: number;
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
      const firstLine = t.split('\n')[0] ?? '';
      return {
        summary: truncate(firstLine, 120),
        details: t.length > 120 ? truncate(t, RESULT_PREVIEW) : undefined,
      };
    }
  }
  return { summary: '' };
}

function buildInitialPrompt(opts: RunAgentTurnOptions): string {
  return [
    'You are an autonomous coding agent operating directly on a git checkout.',
    'The current working directory is the repository root and is already on a feature branch.',
    'You have full access to read, write, edit, grep, glob, and bash. Use them.',
    '',
    'Workflow:',
    '  1. Explore the codebase first (read README, package.json / pyproject / etc, key entry points).',
    '  2. Plan the minimal set of edits needed to satisfy the spec.',
    '  3. Apply the edits with write/edit tools — do NOT print code blocks for the human.',
    '  4. If the project has tests and your change touches tested code, add or update tests.',
    '  5. Do NOT run `git commit` / `git push` — Liliput handles git operations after you finish.',
    '  6. Stay idiomatic to the repo: match its existing style, file layout, and conventions.',
    '',
    'When you are done, reply with a 2-3 sentence summary of what you changed and why.',
    '',
    `## Task: ${opts.taskTitle}`,
    '',
    opts.taskDescription,
    '',
    opts.spec ? `## Approved specification\n${opts.spec}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildFollowUpPrompt(message: string): string {
  return [
    'Follow-up instruction from the user. The previous turn already produced a',
    'commit and a draft PR; new edits will be appended to the same branch.',
    'Continue editing the same workspace. Do not commit or push — Liliput handles git.',
    '',
    'When done, reply with a 1-2 sentence summary of what changed in this turn.',
    '',
    '## New instruction',
    '',
    message,
  ].join('\n');
}

function makeEventHandler(callbacks: TurnCallbacks): (event: SessionEvent) => void {
  return (event: SessionEvent) => {
    const ts = event.timestamp ?? new Date().toISOString();
    const { log, toolEvent } = callbacks;

    switch (event.type) {
      case 'tool.execution_start': {
        callbacks.toolCount += 1;
        const data = event.data;
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
        if (!ok) log('warn', `Tool ${data.toolCallId} failed: ${data.error?.message ?? ''}`);
        toolEvent({
          callId: data.toolCallId,
          kind: 'tool-complete',
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
        toolEvent({
          callId: event.data.reasoningId,
          kind: 'reasoning',
          summary: `🧠 ${truncate(content.split('\n')[0] ?? '', 120)}`,
          details: truncate(content, REASONING_PREVIEW),
          timestamp: ts,
        });
        break;
      }
      case 'assistant.message': {
        const content = event.data.content?.trim() ?? '';
        if (!content) break;
        toolEvent({
          callId: event.data.messageId,
          kind: 'message',
          summary: `💬 ${truncate(content.split('\n')[0] ?? '', 120)}`,
          details: truncate(content, RESULT_PREVIEW),
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
      default:
        // Many other events exist (deltas, usage, lifecycle); ignore for now.
        break;
    }
  };
}

const noLog: LogFn = () => {};
const noEvent: ToolEventFn = () => {};

/**
 * Creates a fresh SDK session bound to the given workspace.
 * The session is left connected so subsequent {@link runAgentTurn} calls
 * accumulate conversation history.
 */
export async function createAgentSession(workspaceRoot: string): Promise<AgentSession> {
  const client = await getCopilotClient();
  // Mutable callbacks ref so per-turn callers can swap their log destination
  // without recreating the session (and losing conversation memory).
  const callbacks: TurnCallbacks = {
    log: noLog,
    toolEvent: noEvent,
    toolCount: 0,
  };
  const session = await client.createSession({
    model: MODEL,
    workingDirectory: workspaceRoot,
    enableConfigDiscovery: true, // auto-load .mcp.json + skills from target repo
    onPermissionRequest: approveAll,
    onEvent: makeEventHandler(callbacks),
  });
  return { workspaceRoot, _session: session, _callbacks: callbacks };
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

  // Swap the live callbacks so the session-level event handler routes events
  // to this turn's destinations.
  handle._callbacks.log = log;
  handle._callbacks.toolEvent = onEvent;
  const before = handle._callbacks.toolCount;

  const prompt = opts.isInitial
    ? buildInitialPrompt(opts)
    : buildFollowUpPrompt(opts.followUp ?? '(no instruction)');

  log('info', opts.isInitial ? 'Asking agent to plan and apply edits…' : 'Sending follow-up to agent…');

  let finalMessage = '';
  try {
    const result = await handle._session.sendAndWait({ prompt }, TIMEOUT_MS);
    finalMessage = result?.data?.content?.trim() ?? '';
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'SDK session turn failed');
    throw err;
  }

  const tools = handle._callbacks.toolCount - before;
  log('info', `Turn finished after ${tools} tool calls. Summary: ${truncate(finalMessage, 200)}`);

  return {
    summary: finalMessage || '(no summary)',
    toolCallCount: tools,
  };
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
    });
  } finally {
    await disposeAgentSession(session);
  }
}
