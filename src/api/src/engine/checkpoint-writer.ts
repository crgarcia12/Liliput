/**
 * Checkpoint Writer — debounced auto commit + push during long agent turns.
 *
 * Why this exists: a Liliputian agent turn can run for tens of minutes (heavy
 * reasoning + many tool calls). If the API pod dies mid-turn (OOMKilled, AKS
 * eviction, deploy roll, restart), all uncommitted edits living in the
 * workspace PVC are lost — and even if the PVC survived, our reconciler
 * marks the task `failed` and purges orphaned workspaces. The branch on
 * origin (which Liliput pushed once at workstream creation) is the only
 * durable copy of agent progress.
 *
 * Strategy: subscribe to `tool-complete` events for file-mutating tools
 * (edit / create / write / multi_str_replace / etc). On each, restart a
 * debounce timer. When the timer fires, run `git add -A && git commit
 * && git push` on the branch — best-effort, errors are warnings only.
 *
 * The commit message is intentionally generic (`wip: liliput checkpoint
 * <iso>`) — the Builder phase later collapses all WIP commits into one
 * clean `feat:` commit before opening the PR (see git-client.softResetTo
 * + commitAllIfChanges + pushForceWithLease).
 *
 * Lifecycle: created with start(), stopped with flush() — flush() runs one
 * final synchronous commit so we don't lose anything between the last tool
 * event and the end of the agent turn.
 */

import * as git from './git-client.js';
import type { ToolEvent } from './agent-loop.js';
import { logger } from '../logger.js';

/** File-mutating tools we recognise from the Copilot SDK + skills. */
const FILE_MUTATING_TOOLS = new Set<string>([
  'edit',
  'create',
  'write',
  'multi_str_replace',
  'multi-str-replace',
  'str_replace',
  'str-replace',
  'apply_patch',
  'apply-patch',
  'str_replace_based_edit_tool',
  'str_replace_editor',
]);

/** True when the bash command is one we care about for checkpointing. */
function isMutatingBashCommand(summary: string): boolean {
  // Heuristic: any bash invocation that runs npm install / pnpm install /
  // file-creating shell ops should snapshot too. Cheap match — false
  // positives are fine (commit will be a no-op).
  const lc = summary.toLowerCase();
  return /\b(?:npm|pnpm|yarn|pip|cargo|go|dotnet|mvn|gradle|make)\s+(?:install|i|add|build|test|migrate)\b/.test(
    lc,
  )
    || /\b(?:mkdir|touch|cp|mv|rm)\b/.test(lc)
    || /\b>\s/.test(summary); // redirection
}

export interface CheckpointWriterOptions {
  /** Repo handle (cwd, branch). */
  handle: git.RepoHandle;
  /** Logger callback for chat / activity rows (debug-level only). */
  onLog?: (level: 'info' | 'warn', message: string) => void;
  /**
   * Debounce window: wait this long after the last mutating event before
   * committing. Default 60s — long enough that a cluster of 10 edits in a
   * row produces one checkpoint, short enough that a crash within the
   * window is bounded.
   */
  debounceMs?: number;
  /**
   * Hard upper bound between commits even if events keep arriving — so a
   * stream of edits doesn't push checkpoints out indefinitely.
   * Default 5 minutes.
   */
  maxIntervalMs?: number;
}

export class CheckpointWriter {
  private readonly handle: git.RepoHandle;
  private readonly onLog: (level: 'info' | 'warn', message: string) => void;
  private readonly debounceMs: number;
  private readonly maxIntervalMs: number;

  private timer: NodeJS.Timeout | undefined;
  private lastCheckpointAt = 0;
  private firstPendingEventAt = 0;
  private inflight = false;
  private pendingWhileInflight = false;
  private stopped = false;

  constructor(opts: CheckpointWriterOptions) {
    this.handle = opts.handle;
    this.onLog = opts.onLog ?? (() => undefined);
    this.debounceMs = opts.debounceMs ?? 60_000;
    this.maxIntervalMs = opts.maxIntervalMs ?? 300_000;
  }

  /** Subscribe to tool events from the agent loop. Pass into onToolEvent. */
  observe(event: ToolEvent): void {
    if (this.stopped) return;
    if (event.kind !== 'tool-complete') return;
    if (!this.isMutatingEvent(event)) return;

    if (this.firstPendingEventAt === 0) this.firstPendingEventAt = Date.now();

    // If max interval is exceeded, fire immediately rather than waiting for
    // another debounce window to elapse.
    if (this.lastCheckpointAt > 0 && Date.now() - this.lastCheckpointAt > this.maxIntervalMs) {
      this.scheduleNow();
      return;
    }
    if (this.firstPendingEventAt > 0 && Date.now() - this.firstPendingEventAt > this.maxIntervalMs) {
      this.scheduleNow();
      return;
    }

    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.commitAndPush();
    }, this.debounceMs);
  }

  /**
   * Final synchronous flush. Must be called when the agent turn ends so we
   * never lose work waiting for a debounce window to elapse.
   */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.stopped = true;
    await this.commitAndPush();
  }

  private isMutatingEvent(event: ToolEvent): boolean {
    if (event.tool && FILE_MUTATING_TOOLS.has(event.tool.toLowerCase())) return true;
    // bash tool fires with `tool: 'bash'` and the command in summary/details
    if (event.tool?.toLowerCase() === 'bash' && isMutatingBashCommand(event.summary)) return true;
    return false;
  }

  private scheduleNow(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.commitAndPush();
    }, 0);
  }

  private async commitAndPush(): Promise<void> {
    if (this.inflight) {
      this.pendingWhileInflight = true;
      return;
    }
    this.inflight = true;
    try {
      const message = `wip: liliput checkpoint ${new Date().toISOString()}`;
      const sha = await git.commitAllIfChanges(this.handle, message);
      if (!sha) {
        // Nothing to commit — common, treat as silent success. Still resets
        // the bookkeeping so we don't keep retrying the same no-op.
        this.firstPendingEventAt = 0;
        return;
      }
      try {
        await git.push(this.handle);
        this.lastCheckpointAt = Date.now();
        this.firstPendingEventAt = 0;
        this.onLog('info', `📦 Checkpoint ${sha.substring(0, 7)} pushed to ${this.handle.branch}`);
      } catch (err) {
        // Push failed — local commit is still a safety net. Don't reset
        // firstPendingEventAt so we retry on the next event.
        const m = err instanceof Error ? err.message : String(err);
        logger.warn({ branch: this.handle.branch, err: m }, 'Checkpoint push failed (commit kept locally)');
        this.onLog('warn', `Checkpoint commit ${sha.substring(0, 7)} kept locally — push failed: ${m.split('\n').pop()?.trim() ?? ''}`);
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      logger.warn({ branch: this.handle.branch, err: m }, 'Checkpoint commit failed');
      this.onLog('warn', `Checkpoint failed: ${m.split('\n').pop()?.trim() ?? ''}`);
    } finally {
      this.inflight = false;
      if (this.pendingWhileInflight) {
        this.pendingWhileInflight = false;
        // Coalesce the queued event into one immediate retry.
        this.scheduleNow();
      }
    }
  }
}
