/**
 * Autopilot — verdict parsing + budget cap for LLM-driven termination.
 *
 * The mega-prompt design (see plan.md) hands the build→test→deploy→e2e→fix
 * cycle to the SDK's own agentic loop. Liliput's role is to:
 *  - provide the master prompt (workspace + spec + Gherkin + tools),
 *  - parse the agent's `VERDICT:` line when it claims completion,
 *  - enforce a budget cap as a runaway guard (NOT as the primary stop),
 *  - server-side verify local implementation evidence separately from
 *    Liliput's deployment and release gates.
 *
 * This module is the verdict + budget half. The mega-prompt itself is
 * assembled in `agent-engine.ts` once we wire the new path in.
 */

export type VerdictStatus = 'done' | 'blocked' | 'continue';

export interface Verdict {
  status: VerdictStatus;
  /** Free-form one-liner from the agent. Always present. */
  reason: string;
  /** The raw line that matched, useful for logging. */
  raw: string;
}

// Match a line like:
//   VERDICT: done — implemented login + green tests
//   VERDICT: blocked: missing API key
//   VERDICT: continue (still iterating)
// Tolerant of `:` `-` `--` `—` separators and missing trailing reason.
const VERDICT_RE =
  /(?:^|\n)\s*verdict\s*[:\-]\s*(done|blocked|continue)\b\s*(?:[:\-—]+\s*(.+?))?(?=\n|$)/gi;

/**
 * Find the LAST verdict line in a chunk of agent output. The agent may emit
 * intermediate "I'm continuing" verdicts; only the final line is canonical.
 * Returns null if no verdict line is present.
 */
export function parseVerdict(text: string): Verdict | null {
  if (!text) return null;
  VERDICT_RE.lastIndex = 0;
  let last: Verdict | null = null;
  for (const m of text.matchAll(VERDICT_RE)) {
    const status = (m[1] ?? '').toLowerCase() as VerdictStatus;
    const reason = (m[2] ?? '').trim();
    last = {
      status,
      reason: reason || `(no reason given for ${status})`,
      raw: (m[0] ?? '').trim(),
    };
  }
  return last;
}

export interface BudgetOptions {
  /** Hard cap on SDK turns. Insurance only — agent should self-stop first. */
  maxTurns?: number;
  /** Hard cap on wall-clock duration in milliseconds. */
  maxWallMs?: number;
}

export interface BudgetSnapshot {
  turnsUsed: number;
  wallMs: number;
  turnsRemaining: number;
  wallRemainingMs: number;
  exhausted: boolean;
  reason: string | null;
}

const DEFAULT_MAX_TURNS = parseInt(
  process.env['AUTOPILOT_MAX_TURNS'] ?? '50',
  10,
);
const DEFAULT_MAX_WALL_MS = parseInt(
  process.env['AUTOPILOT_MAX_WALL_MS'] ?? String(4 * 60 * 60 * 1000), // 4h
  10,
);

/**
 * Tracks turn count + wall-clock time for an autopilot session. Constructor
 * snapshots the start time. Call `recordTurn()` after each SDK turn. Call
 * `check()` (or `assertHealthy()`) before starting the next turn.
 */
export class Budget {
  private turns = 0;
  private readonly startMs: number;
  private readonly maxTurns: number;
  private readonly maxWallMs: number;

  constructor(opts: BudgetOptions = {}) {
    this.startMs = Date.now();
    this.maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
    this.maxWallMs = opts.maxWallMs ?? DEFAULT_MAX_WALL_MS;
  }

  recordTurn(): void {
    this.turns++;
  }

  snapshot(): BudgetSnapshot {
    const wallMs = Date.now() - this.startMs;
    const turnsRemaining = Math.max(0, this.maxTurns - this.turns);
    const wallRemainingMs = Math.max(0, this.maxWallMs - wallMs);
    let reason: string | null = null;
    if (this.turns >= this.maxTurns) {
      reason = `budget-exceeded: ${this.turns}/${this.maxTurns} turns`;
    } else if (wallMs >= this.maxWallMs) {
      reason = `budget-exceeded: ${Math.round(wallMs / 1000)}s of ${Math.round(this.maxWallMs / 1000)}s wall`;
    }
    return {
      turnsUsed: this.turns,
      wallMs,
      turnsRemaining,
      wallRemainingMs,
      exhausted: reason !== null,
      reason,
    };
  }

  /** Returns true if budget is still healthy. */
  isHealthy(): boolean {
    return !this.snapshot().exhausted;
  }
}

/**
 * Server-side implementation gate. `VERDICT: done` means implementation-ready,
 * not deployment-verified. Deployment health is enforced by the pipeline after
 * the coder turn and must not be attributed to the coder.
 */
export interface VerdictGateInput {
  verdict: Verdict;
  objective: {
    /** Last `npm test` / `pytest` / etc exit code. 0 = green. */
    testsExitCode: number | null;
    /** Whether the deploy is healthy (kubectl rollout status returned 0). */
    deployHealthy: boolean;
    /** Whether all gherkin scenarios passed against preview URL. */
    gherkinAllPassed: boolean;
    /** Did we even RUN any of these checks? Helps distinguish "unknown" from "false". */
    checksRan: { tests: boolean; deploy: boolean; gherkin: boolean };
  };
}

/**
 * Reject an implementation-ready claim when an executed local verification
 * check is red:
 *
 *  - tests RAN and FAILED → reject
 *  - tests NEVER RAN → allow here because the input does not say whether a
 *    test command exists; prompt/reviewer/release guards handle that evidence
 *  - gherkin RAN and FAILED → reject
 *  - gherkin NEVER RAN → allow (specs without acceptance.feature are common)
 *
 * `deployHealthy` remains in the input for compatibility with persisted callers
 * but is intentionally not part of implementation readiness.
 */
export function gateVerdict(input: VerdictGateInput): string | null {
  const { verdict, objective } = input;
  if (verdict.status !== 'done') return null; // blocked/continue don't need gating

  const failures: string[] = [];
  if (objective.checksRan.tests && objective.testsExitCode !== 0) {
    failures.push(
      `tests are red (exit code ${objective.testsExitCode ?? 'unknown'})`,
    );
  }
  if (objective.checksRan.gherkin && !objective.gherkinAllPassed) {
    failures.push('gherkin scenarios did not all pass');
  }
  // Gherkin not running is allowed (some specs may have no acceptance.feature)

  if (failures.length === 0) return null;
  return `implementation verdict "done" REJECTED — local verification failed: ${failures.join('; ')}. Keep working.`;
}
