/**
 * Stuck-detection + escalation strategy for the validate-and-heal loop.
 *
 * Today the loop calls the same ops-fixer with the same prompt every time
 * the deploy probe fails. If the fixer is stuck on a class of error
 * (`HTTP 404` repeating, `ImagePullBackOff` repeating, …), running the
 * same prompt 30 times produces identical no-op results.
 *
 * This module classifies each probe failure into a coarse "signature" and
 * tracks per-task signature history. When the same signature appears N
 * times in a row we declare the task STUCK and rotate through a list of
 * escalation strategies. The chosen strategy is rendered as an extra
 * prompt block that the caller appends to the ops-fixer prompt.
 *
 * Design goals:
 *  - Pure functions — no I/O, no globals besides the in-memory map.
 *  - Cheap — runs once per validate attempt.
 *  - Deterministic given history — same input → same escalation choice.
 *  - Safe — strategies are advisory hints; they never override the
 *    fixer's tool access or guardrails.
 */

export type ErrorSignature =
  | 'http-4xx'
  | 'http-5xx'
  | 'http-unreachable'
  | 'redirect-out-of-base'
  | 'pod-crashloop'
  | 'pod-imagepullbackoff'
  | 'pod-pending'
  | 'pod-not-ready'
  | 'no-pods'
  | 'unknown';

/**
 * Classify a validateDevPreview summary into a coarse error class. Order
 * matters: the most-specific patterns are checked first.
 */
export function classifyFailure(summary: string): ErrorSignature {
  const s = summary.toLowerCase();
  if (s.includes('imagepullbackoff') || s.includes('errimagepull')) {
    return 'pod-imagepullbackoff';
  }
  if (s.includes('crashloopbackoff')) return 'pod-crashloop';
  if (s.includes('no pods in namespace')) return 'no-pods';
  if (s.includes('pending')) return 'pod-pending';
  if (s.includes('redirected out of its base path')) return 'redirect-out-of-base';
  if (s.includes('notready') || s.includes('not ready')) return 'pod-not-ready';
  if (/http\s*5\d{2}\b/.test(s)) return 'http-5xx';
  if (/http\s*4\d{2}\b/.test(s)) return 'http-4xx';
  if (s.includes('failed:') && s.includes('http probe')) return 'http-unreachable';
  return 'unknown';
}

/**
 * Threshold: same signature repeated this many times triggers escalation.
 * Set low (3) so the agent doesn't burn 5+ identical retries before we
 * pivot strategy.
 */
export const STUCK_THRESHOLD = parseInt(
  process.env['VALIDATE_STUCK_THRESHOLD'] ?? '3',
  10,
);

/** History entry for one task's recent failures. */
interface History {
  signatures: ErrorSignature[];
  /** How many escalations have we issued so far for this task? */
  escalationCount: number;
}

const taskHistory = new Map<string, History>();

/** Reset history for a task. Call when a task starts or completes. */
export function resetStuckHistory(taskId: string): void {
  taskHistory.delete(taskId);
}

export interface StuckDecision {
  signature: ErrorSignature;
  /** How many consecutive attempts hit this same signature. */
  streak: number;
  /** True if streak >= STUCK_THRESHOLD. */
  stuck: boolean;
  /** If stuck: the escalation hint to inject into the next fixer prompt. */
  escalationBlock: string | null;
  /** Which strategy index was chosen (rotates). Useful for logs. */
  strategyIndex: number | null;
}

/**
 * Record one probe failure for taskId, return whether we are stuck and
 * (if so) which escalation hint to inject. Mutates internal history.
 */
export function recordAndDecide(
  taskId: string,
  summary: string,
): StuckDecision {
  const sig = classifyFailure(summary);
  const h = taskHistory.get(taskId) ?? { signatures: [], escalationCount: 0 };
  h.signatures.push(sig);
  // Keep only the tail — we never need more than the last STUCK_THRESHOLD * 2.
  const cap = Math.max(STUCK_THRESHOLD * 2, 8);
  if (h.signatures.length > cap) h.signatures.splice(0, h.signatures.length - cap);

  // Streak = how many trailing entries match the latest one.
  let streak = 0;
  for (let i = h.signatures.length - 1; i >= 0; i--) {
    if (h.signatures[i] === sig) streak++;
    else break;
  }
  const stuck = streak >= STUCK_THRESHOLD;
  let escalationBlock: string | null = null;
  let strategyIndex: number | null = null;
  if (stuck) {
    strategyIndex = h.escalationCount % ESCALATION_STRATEGIES.length;
    const strat = ESCALATION_STRATEGIES[strategyIndex]!;
    escalationBlock = renderEscalation(sig, streak, strat);
    h.escalationCount++;
  }
  taskHistory.set(taskId, h);
  return { signature: sig, streak, stuck, escalationBlock, strategyIndex };
}

interface Strategy {
  name: string;
  /** Short label included in the prompt block header. */
  label: string;
  /** Body of the escalation block. */
  body: string;
}

/**
 * Three coarse escalation strategies. The loop rotates through them in
 * order so we don't hammer the same idea repeatedly.
 *
 *  1. STEP-BACK: ask the agent to re-read the spec and the deploy contract
 *     before editing — common cause of stuck loops is misunderstanding
 *     the proxy semantics or BASE_PATH wiring.
 *  2. REVERT: ask the agent to consider reverting recent commits and
 *     trying a different approach. Sometimes the only way out of a
 *     local-minimum is to back up.
 *  3. INSPECT-LIVE: ask the agent to use kubectl/curl to deeply inspect
 *     the live cluster before making more code edits. Often the right
 *     fix is operational, not file-edit.
 */
const ESCALATION_STRATEGIES: readonly Strategy[] = [
  {
    name: 'step-back',
    label: 'STEP BACK & RE-READ THE CONTRACT',
    body: [
      "You've been stuck on the same failure class for several attempts. Before editing more files:",
      '  1. Re-read LILIPUT_DEPLOY_CONTRACT.md at the repo root. The proxy strips your base path before forwarding, but RELATIVE links in HTML/JS resolved on the client will still include it. Misalignment here is the #1 cause of the failure you keep hitting.',
      '  2. Re-read the spec/task description and acceptance criteria. Are you fixing the right symptom?',
      '  3. THEN make ONE small targeted change. Do not re-edit files you already touched on previous attempts unless your previous edit was provably wrong.',
    ].join('\n'),
  },
  {
    name: 'revert',
    label: 'REVERT & TRY A DIFFERENT APPROACH',
    body: [
      "You've made multiple attempts at this and the failure class hasn't changed. Consider this is a local minimum. Options:",
      '  1. Run `git log --oneline -10` and inspect the last ~5 commits you made. Identify which one(s) introduced or failed to fix the current symptom.',
      '  2. Consider reverting the most recent attempts (`git revert <sha>` or `git reset --hard <sha-before-stuck-loop>`) and trying a fundamentally different approach.',
      '  3. If the framework/runtime defaults are fighting you, consider switching to a simpler setup (e.g. plain static files instead of Vite SSR) — the goal is a working preview, not the most sophisticated stack.',
    ].join('\n'),
  },
  {
    name: 'inspect-live',
    label: 'INSPECT THE LIVE CLUSTER FIRST',
    body: [
      'Stop editing files for one turn. The fix may be operational rather than code-level. Run these AND show me their output before deciding what to do:',
      '  - `kubectl describe pod -n <ns> -l app=app` — see init failures, resource limits, mounted secrets',
      '  - `kubectl logs -n <ns> deploy/app --tail=300` — see what the app is actually saying',
      '  - `kubectl logs -n <ns> deploy/app --previous --tail=200` — last crash if any',
      '  - `kubectl get svc -n <ns> app -o yaml` — confirm targetPort matches container port',
      '  - `kubectl exec -n <ns> deploy/app -- curl -sv http://localhost:<containerPort>/` — does the app even serve locally inside the container?',
      '  - `kubectl exec -n <ns> deploy/app -- env | sort` — confirm env vars and BASE_PATH wiring',
      'Only after seeing this output decide what to change.',
    ].join('\n'),
  },
] as const;

function renderEscalation(
  sig: ErrorSignature,
  streak: number,
  strat: Strategy,
): string {
  return [
    `## ⚠️ STUCK — ESCALATION (${strat.label})`,
    '',
    `You have hit \`${sig}\` ${streak} attempts in a row. The fixer is going in circles.`,
    'Switch strategy. Specifically:',
    '',
    strat.body,
    '',
    'Then summarise (in 1-2 sentences) which strategy you applied and why.',
  ].join('\n');
}

/** Internal — for tests. */
export const _internal = {
  ESCALATION_STRATEGIES,
};
