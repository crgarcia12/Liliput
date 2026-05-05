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
import { buildDeployContract, type DeployContractContext } from './liliput-deploy-contract.js';
import { logger } from '../logger.js';

const DEFAULT_MODEL = process.env['COPILOT_MODEL'] ?? 'claude-sonnet-4';
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

export type LogFn = (
  level: 'info' | 'warn' | 'error',
  message: string,
  command?: string,
  output?: string,
) => void;
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
  /** Model id used to create this SDK session (e.g. "gpt-5", "claude-sonnet-4.5"). */
  model: string;
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
  /**
   * If set, this string is sent verbatim as the prompt — bypassing both the
   * initial template and the follow-up wrapper. Use for purpose-built turns
   * (e.g. ops-fixer) where the wrapper text would be misleading.
   */
  promptOverride?: string;
  /**
   * Liliput runtime context (path-prefix, port, devUrl). When provided, the
   * Liliput Deploy Contract is prepended to the initial prompt so the agent
   * understands the proxy contract from turn one. Follow-up turns rely on
   * conversation memory (the contract is already in-context from turn one)
   * plus the LILIPUT_DEPLOY_CONTRACT.md file dropped at workspace root.
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
  const contractBlock = opts.liliputContext
    ? [
        buildDeployContract(opts.liliputContext),
        '',
        '⚠️  The contract above is also available as `LILIPUT_DEPLOY_CONTRACT.md` at the workspace root — re-read it whenever you touch the Dockerfile, k8s manifests, or any code that affects how the app is served.',
        '',
        '---',
        '',
      ].join('\n')
    : '';
  return [
    contractBlock,
    'You are an autonomous coding agent operating directly on a git checkout.',
    'The current working directory is the repository root and is already on a feature branch.',
    '',
    'You have FULL access to the repository AND to the host environment:',
    '  - read / write / edit / grep / glob / bash tools — use them freely',
    '  - `git` — you may inspect, branch, stash, commit, push, fetch, etc.',
    '  - `kubectl` (cluster-admin), `az`, `docker`, `curl`, `gh` — available',
    '  - `npm` / `node` for JS projects; `python` / `pip` for Python; etc.',
    '  - any file in the repo is fair game (including infra/, k8s/, .github/) IF that is genuinely the right fix',
    '',
    'You are trusted to figure out the right action and do it. Do not ask for permission.',
    '',
    'Tests-first workflow (TDD):',
    '  1. Explore the codebase (read README, package.json / pyproject / etc, key entry points).',
    '  2. If the spec contains a `## Acceptance Scenarios (Gherkin)` section, scaffold',
    '     failing tests from those scenarios FIRST (e.g. tests/features/*.feature for',
    '     Cucumber, e2e/*.spec.ts for Playwright, *.test.ts for Vitest).',
    '  3. Plan the minimal set of edits needed to make those tests pass + satisfy the spec.',
    '  4. Apply edits with write/edit tools — do NOT print code blocks for the human.',
    '  5. Run the test suite locally if one exists (`npm test`, `pytest`, etc.) and iterate',
    '     until tests are green or you have a concrete blocker to report.',
    '  6. Stay idiomatic to the repo: match its existing style, file layout, and conventions.',
    '',
    'About git: Liliput will run `git add -A && git commit && git push` after you finish, so you',
    'do NOT need to commit/push yourself — but if you do, that is fine too. Liliput detects',
    'an already-committed / already-pushed state and short-circuits cleanly.',
    '',
    '## How rebuild & redeploy work (READ THIS — do not get confused)',
    '',
    'You DO have access to `docker`, `kubectl`, `gh`, and `az` in your shell, but you do',
    'NOT need to use them to rebuild and redeploy. Liliput owns that pipeline:',
    '',
    '  1. You edit files in the workspace.',
    '  2. When your turn ends, Liliput stages, commits, and pushes your edits.',
    '  3. Liliput then **automatically rebuilds the Docker image** from the new commit',
    '     and **rolls out a new dev preview** to the AKS namespace at your preview URL.',
    '  4. Liliput then probes the preview and runs cucumber tests against it.',
    '',
    'Therefore: if the user asks you to "rebuild" or "redeploy", you simply make whatever',
    'edit they want (or, if no edit is needed, make a tiny no-op change like adding a',
    'newline or a build-marker comment) and Liliput will rebuild + redeploy automatically.',
    '',
    'NEVER tell the user that "Liliput operators must trigger a build" or that you "cannot',
    'access the build pipeline". You are the build pipeline\'s trigger — every commit you',
    'cause is a deploy. If you make zero edits, no rebuild happens; that is the only',
    'restriction.',
    '',
    '## Tool wishes',
    'If you wish you had a CLI that is NOT installed (e.g. `jq`, `yq`, `ripgrep`, `helm`,',
    '`terraform`, `psql`, `redis-cli`), emit a single line in your reply of the form:',
    '    TOOL-WISH: <tool> — <one-line reason>',
    'The line must start with `TOOL-WISH:` (case-insensitive). Liliput captures these so',
    'the operator can bake popular requests into the next runtime image. Wishes do NOT',
    'block your work — keep going with what you have.',
    '',
    '## Verdict',
    'When you have decided whether you are finished, emit a single line of the form:',
    '    VERDICT: done — <one-line summary of what is shipped>',
    '    VERDICT: blocked — <reason you cannot continue>',
    '    VERDICT: continue — <what you are about to do next>',
    'Use `done` ONLY when tests pass, the deploy is healthy, and the acceptance scenarios',
    'are covered. Use `blocked` when you genuinely cannot make progress (missing creds,',
    'unreachable infra, ambiguous requirement). Use `continue` for in-progress turns.',
    'Liliput parses the LAST `VERDICT:` line of your reply, so always emit one when you',
    'finish a turn. The keyword is case-insensitive.',
    '',
    'When (and ONLY when) you emit `VERDICT: done`, you MUST also include an EVIDENCE',
    'block above the verdict line. Paste the actual command output — do not paraphrase:',
    '',
    '    ```evidence',
    '    $ npm test',
    '    <last ~20 lines including the "Tests <N> passed" summary>',
    '',
    '    $ curl -fsS -o /dev/null -w "%{http_code}\\n" "<LILIPUT_PREVIEW_URL>"',
    '    200',
    '',
    '    $ npx cucumber-js   # if a tests/features/*.feature file exists',
    '    <last ~10 lines showing scenarios passing>',
    '    ```',
    '',
    'If any of these commands fail or were not run, you do NOT have evidence — emit',
    '`VERDICT: continue` (or `blocked`) instead, and try again on the next turn.',
    'Liliput cross-checks your EVIDENCE against live probes; over-claiming will be',
    'rejected and posted back to chat for the user to see.',
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

function buildFollowUpPrompt(opts: RunAgentTurnOptions): string {
  const message = opts.followUp ?? '(no instruction)';
  const contractBlock = opts.liliputContext
    ? [
        buildDeployContract(opts.liliputContext),
        '',
        '⚠️  The contract above remains in effect. Re-read `LILIPUT_DEPLOY_CONTRACT.md` at the workspace root if you touch infra/Dockerfile/server-routing code.',
        '',
        '---',
        '',
      ].join('\n')
    : '';
  const recapBlock = opts.recap
    ? [
        '## Recap of previous session',
        '',
        'Your SDK session was reset (likely a pod restart) so you have no in-memory',
        'history of our previous conversation. Below is a transcript of the last',
        'messages exchanged before the reset. Treat this as your memory:',
        '',
        opts.recap,
        '',
        '---',
        '',
      ].join('\n')
    : '';
  return [
    contractBlock,
    recapBlock,
    'Follow-up instruction from the user. The previous turn already produced a',
    'commit and a draft PR; new edits will be appended to the same branch.',
    'Continue editing the same workspace. Do not commit or push — Liliput handles git.',
    '',
    '⚙️  Reminder: Liliput automatically rebuilds the Docker image and redeploys the',
    'dev preview after EVERY turn that produces edits. You do NOT need docker / kubectl',
    'access to trigger a rebuild — just edit a file. If the user asks you to "rebuild"',
    'or "redeploy" and no code change is needed, make a tiny no-op edit (add a newline',
    'or a comment) so Liliput has something to commit. Never tell the user that operators',
    'must trigger a build — you are the trigger.',
    '',
    'You still have full access: bash / git / kubectl / az / docker / curl / gh / npm.',
    'Use whatever tools are needed. Run tests if relevant.',
    '',
    'If you wish you had a CLI that is not installed, emit a line:',
    '    TOOL-WISH: <tool> — <reason>',
    '',
    'Always end your reply with a single `VERDICT:` line — `done`, `blocked`, or',
    '`continue` — followed by a short reason. Use `done` only when tests pass,',
    'the deploy is healthy, and acceptance scenarios are covered. When you emit',
    '`VERDICT: done`, also include an `evidence` fenced block above it pasting',
    'the actual `npm test`, `curl <preview>` (HTTP 200), and `npx cucumber-js`',
    'output. Liliput cross-checks against live probes — over-claiming gets',
    'rejected and shown to the user.',
    '',
    'When done, reply with a 1-2 sentence summary of what changed in this turn.',
    '',
    '## New instruction',
    '',
    message,
  ].filter(Boolean).join('\n');
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
        // Persist completion to logs so it appears after-the-fact (not just live wire events).
        log(ok ? 'info' : 'warn', summary, undefined, details);
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
        log('info', `🧠 ${truncate(content.split('\n')[0] ?? '', 120)}`, undefined, truncate(content, REASONING_PREVIEW));
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
        log('info', `💬 ${truncate(content.split('\n')[0] ?? '', 120)}`, undefined, truncate(content, RESULT_PREVIEW));
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
export async function createAgentSession(
  workspaceRoot: string,
  modelOverride?: string,
): Promise<AgentSession> {
  const client = await getCopilotClient();
  // Mutable callbacks ref so per-turn callers can swap their log destination
  // without recreating the session (and losing conversation memory).
  const callbacks: TurnCallbacks = {
    log: noLog,
    toolEvent: noEvent,
    toolCount: 0,
  };
  const model = modelOverride && modelOverride.trim() ? modelOverride.trim() : DEFAULT_MODEL;
  const session = await client.createSession({
    model,
    workingDirectory: workspaceRoot,
    enableConfigDiscovery: true, // auto-load .mcp.json + skills from target repo
    onPermissionRequest: approveAll,
    onEvent: makeEventHandler(callbacks),
  });
  return { workspaceRoot, _session: session, _callbacks: callbacks, model };
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

  const prompt = opts.promptOverride
    ? opts.promptOverride
    : opts.isInitial
      ? buildInitialPrompt(opts)
      : buildFollowUpPrompt(opts);

  log('info', opts.isInitial ? 'Asking agent to plan and apply edits…' : 'Sending follow-up to agent…');

  let finalMessage = '';
  try {
    const result = await handle._session.sendAndWait({ prompt }, opts.timeoutMs ?? TIMEOUT_MS);
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
