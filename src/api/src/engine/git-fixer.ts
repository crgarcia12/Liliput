/**
 * Git fixer — LLM-driven recovery wrapper around git operations.
 *
 * When a git command fails (auth, conflict, non-fast-forward, network, …)
 * we don't just blindly retry. We spawn a `fixer` agent turn in the same
 * Copilot SDK session that gave us the workspace context, hand it the
 * exact failed command + stderr, and let it diagnose and mitigate using
 * full bash + git access. Then we re-attempt the original op.
 *
 * If the fixer completed the operation itself (e.g. ran `git push`
 * directly), the re-attempt would normally fail with "Everything
 * up-to-date" or "nothing to commit". The optional `recoveryCheck`
 * callback lets the caller detect that state and treat it as success.
 *
 * This file owns the prompt — it's deliberately permissive (the LLM is
 * expected to run git/bash) but constrained on remote URL changes,
 * branch switches, and infra/k8s/.github edits.
 */

import {
  runAgentTurn,
  type AgentSession,
  type LogFn,
  type ToolEventFn,
} from './agent-loop.js';

const FIXER_TIMEOUT_MS = parseInt(
  process.env['AGENT_FIXER_TIMEOUT_MS'] ?? '600000', // 10 min — bash + git, ample headroom
  10,
);

const ERROR_OUTPUT_LIMIT = 4000;

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  // Tail-preserve — the actual error is almost always at the end.
  return '…' + s.substring(s.length - n);
}

interface FixerPromptCtx {
  command: string;
  errorMessage: string;
  errorOutput?: string;
  cwd: string;
  branch: string;
  repo: string;
  attempt: number;
  maxAttempts: number;
}

function buildPrompt(ctx: FixerPromptCtx): string {
  const errBlob = ctx.errorOutput
    ? truncate(ctx.errorOutput, ERROR_OUTPUT_LIMIT)
    : ctx.errorMessage;

  return [
    'You are the Liliput git-fixer agent. A git command just failed and you need to diagnose and recover.',
    '',
    `## Failed command (recovery attempt ${ctx.attempt}/${ctx.maxAttempts})`,
    '',
    '```',
    ctx.command,
    '```',
    '',
    '## Error output (tail-truncated)',
    '',
    '```',
    errBlob,
    '```',
    '',
    '## Context',
    '',
    `  - Repo: ${ctx.repo}`,
    `  - Branch: ${ctx.branch}`,
    `  - Working directory: ${ctx.cwd}`,
    '',
    '## Your tools (use them)',
    '',
    '  Unlike the normal coding turn, in THIS turn you ARE allowed to run git and bash.',
    '  - Inspect repo state: `git status`, `git log --oneline -10`, `git remote -v`,',
    '    `git diff`, `git branch -vv`, `git config -l --local`',
    '  - Recover: `git pull --rebase origin <branch>`, `git fetch origin`,',
    '    `git stash`, `git stash pop`, `git reset --soft HEAD~1`, `git rebase --abort`',
    '  - Edit files (e.g. resolve conflict markers, fix .gitignore, fix commit message)',
    '  - Complete the operation yourself if appropriate — e.g. after a rebase you may',
    '    run `git push --force-with-lease` or `git push --set-upstream origin <branch>`',
    '',
    '## What happens after your turn',
    '',
    `Liliput will re-attempt the original failed command. If you already completed the`,
    `operation yourself, that re-attempt will be a no-op ("nothing to commit",`,
    `"Everything up-to-date") and Liliput will treat it as success.`,
    '',
    '## Hard constraints',
    '',
    `  - Stay on branch \`${ctx.branch}\`. DO NOT switch branches and DO NOT push to a different one.`,
    '  - DO NOT change the git remote URL.',
    '  - DO NOT discard or overwrite uncommitted changes that look like agent-authored work',
    '    (those changes ARE the whole point of this pipeline). Use `git stash` if you need them out',
    '    of the way temporarily — never `git checkout -- .` / `git reset --hard` on uncommitted work.',
    '  - DO NOT modify files under `infra/`, `k8s/`, or `.github/` — those belong to Liliput itself.',
    '  - Make the smallest change that resolves the failure.',
    '',
    'Reply with a 1-2 sentence summary of what you diagnosed and what you did.',
  ].join('\n');
}

export interface RunGitOpWithFixerOptions<T> {
  /** The shared Copilot SDK session for this task. Required for fixer to have repo context. */
  agentSession: AgentSession;
  /** The git op to attempt — we run this once per attempt. */
  op: () => Promise<T>;
  /** Human-readable description of the op (used in logs and the fixer prompt). */
  describe: string;
  /** Working directory of the repo. */
  cwd: string;
  /** Branch we're operating on. */
  branch: string;
  /** "owner/repo" — for the fixer's context. */
  repo: string;
  /**
   * Called after each fixer turn. If it returns `{ recovered: true, result }`,
   * the wrapper short-circuits with that result (treats as success). Useful
   * when the fixer completes the operation itself, e.g. by pushing directly,
   * which would make the next op() call throw with a benign no-op error.
   */
  recoveryCheck?: () => Promise<
    { recovered: true; result: T } | { recovered: false }
  >;
  /** Hard cap on attempts (op + fixer + op + fixer + …). Default 3. */
  maxAttempts?: number;
  /** Log destination for the wrapper itself + the fixer turn. */
  onLog?: (level: 'info' | 'warn' | 'error', message: string, command?: string, output?: string) => void;
  /** Tool-event destination — usually a logPhase wrapper. */
  onToolEvent?: ToolEventFn;
  /** Called when we spawn a fixer turn so the caller can register a UI agent. */
  onFixerTurnStart?: (attempt: number) => void;
  /** Called when a fixer turn completes (whether it recovered or not). */
  onFixerTurnEnd?: (attempt: number, summary: string, recovered: boolean) => void;
}

/**
 * Wrap a git operation with LLM-driven recovery on failure. On error we
 * spawn a fixer turn in the existing Copilot SDK session, then re-attempt.
 * Repeats up to `maxAttempts` times before giving up.
 */
export async function runGitOpWithFixer<T>(
  opts: RunGitOpWithFixerOptions<T>,
): Promise<T> {
  const max = opts.maxAttempts ?? 3;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return await opts.op();
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      lastError = e;
      const lastLine = e.message.split('\n').pop()?.trim() ?? e.message;
      opts.onLog?.(
        'warn',
        `${opts.describe} failed (attempt ${attempt}/${max}): ${lastLine}`,
        opts.describe,
        e.message,
      );

      if (attempt === max) break;

      opts.onLog?.('info', 'Spawning git-fixer agent to diagnose and recover…');
      opts.onFixerTurnStart?.(attempt);

      const fixerLog: LogFn = (level, msg, cmd, out) =>
        opts.onLog?.(level, msg, cmd, out);

      let recovered = false;
      let summary = '(no summary)';
      try {
        const result = await runAgentTurn(opts.agentSession, {
          taskTitle: '(git-fixer)',
          taskDescription: `Fix failed git command: ${opts.describe}`,
          isInitial: false,
          promptOverride: buildPrompt({
            command: opts.describe,
            errorMessage: lastLine,
            errorOutput: e.message,
            cwd: opts.cwd,
            branch: opts.branch,
            repo: opts.repo,
            attempt,
            maxAttempts: max,
          }),
          timeoutMs: FIXER_TIMEOUT_MS,
          onLog: fixerLog,
          ...(opts.onToolEvent ? { onToolEvent: opts.onToolEvent } : {}),
        });
        summary = result.summary;
        opts.onLog?.(
          'info',
          `git-fixer turn complete (${result.toolCallCount} tool call${result.toolCallCount === 1 ? '' : 's'}): ${truncate(result.summary, 240)}`,
        );
      } catch (fixErr) {
        const m = fixErr instanceof Error ? fixErr.message : String(fixErr);
        opts.onLog?.('warn', `git-fixer turn failed: ${m}`);
      }

      if (opts.recoveryCheck) {
        try {
          const check = await opts.recoveryCheck();
          if (check.recovered) {
            recovered = true;
            opts.onLog?.(
              'info',
              `git-fixer recovered: ${opts.describe} already complete (verified post-fixer state).`,
            );
            opts.onFixerTurnEnd?.(attempt, summary, true);
            return check.result;
          }
        } catch (checkErr) {
          const m = checkErr instanceof Error ? checkErr.message : String(checkErr);
          opts.onLog?.('warn', `Recovery check after fixer failed: ${m}`);
        }
      }
      opts.onFixerTurnEnd?.(attempt, summary, recovered);
    }
  }

  throw lastError ?? new Error(`${opts.describe} failed`);
}
