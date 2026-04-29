/**
 * Ops fixer — an LLM-driven recovery agent for the build/deploy phases.
 *
 * Lifecycle of one fix turn:
 *   1. A scripted op (e.g. `acrBuild`, `deployApp`) just failed with an error.
 *   2. We send a focused follow-up to the existing Copilot SDK session
 *      describing the failure and asking the agent to inspect the workspace
 *      and either edit files (Dockerfile, app code, …) OR run the recovery
 *      action itself (`az acr build`, `kubectl apply`, …) — whichever is the
 *      right fix. The agent has full bash / git / az / kubectl access.
 *   3. After the fixer returns, Liliput re-runs the scripted op. If the agent
 *      already completed the operation itself, the recovery-check pattern in
 *      the caller short-circuits to success cleanly.
 *
 * After the fixer turn, the caller:
 *   - inspects `git status` (changed files),
 *   - re-runs the scripted op,
 *   - on continued failure, may invoke the fixer again (capped attempts).
 */

import { runAgentTurn, type AgentSession, type LogFn, type ToolEventFn, type RunAgentResult } from './agent-loop.js';

const FIXER_TIMEOUT_MS = parseInt(
  process.env['AGENT_FIXER_TIMEOUT_MS'] ?? '600000', // 10 min — file-only edits, plenty of time
  10,
);

export type FixerPhase = 'build' | 'deploy';

export interface OpsFixerOptions {
  session: AgentSession;
  phase: FixerPhase;
  attempt: number;
  /** Concise human-readable summary of the failure (one line preferred). */
  errorMessage: string;
  /** Raw error output (stderr / API error body). Truncated by the fixer prompt. */
  errorOutput?: string;
  /** Helpful context the agent needs to reason about the failure. */
  context: {
    repo: string;
    dockerfile: string;
    /** Container port the app listens on. */
    port: number;
    /** ACR registry name (for build phase). */
    acrName?: string;
    /** Image reference being built/deployed. */
    imageRef?: string;
    /** Target k8s namespace (for deploy phase). */
    namespace?: string;
    /** Path-prefix the app is served under, e.g. /dev/owner/repo/branch. */
    pathPrefix?: string;
  };
  onLog?: LogFn;
  onToolEvent?: ToolEventFn;
}

const ERROR_OUTPUT_LIMIT = 4000;

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  // Keep the tail — it's where the actual error message tends to live.
  return '…' + s.substring(s.length - n);
}

function buildPrompt(opts: OpsFixerOptions): string {
  const { phase, attempt, errorMessage, errorOutput, context } = opts;
  const errBlob = errorOutput ? truncate(errorOutput, ERROR_OUTPUT_LIMIT) : '(no additional output)';

  const phaseHeader =
    phase === 'build'
      ? [
          `## Phase: container image BUILD failed (attempt ${attempt})`,
          '',
          `Liliput tried to run \`az acr build\` to produce \`${context.imageRef ?? '(unknown)'}\` from \`${context.dockerfile}\` and it failed.`,
          'Your job: inspect the workspace, then EITHER edit files (Dockerfile, app source, manifests, …) so the next scripted build succeeds, OR run `az acr build` / similar yourself to push the image directly. Both are fine — Liliput will detect the recovered state and continue.',
          '',
          'Likely causes to investigate:',
          '  - missing/incorrect base image',
          '  - missing build-time dependencies',
          '  - wrong working dir, missing files in the build context',
          '  - app references a port other than the one Liliput expects',
          `  - the app does not actually listen on port ${context.port}`,
          '  - the Dockerfile references a build stage that does not exist',
        ].join('\n')
      : [
          `## Phase: kubernetes DEPLOY failed (attempt ${attempt})`,
          '',
          `Liliput tried to deploy \`${context.imageRef ?? '(unknown)'}\` to namespace \`${context.namespace ?? '(unknown)'}\` and the pod did not become Ready.`,
          'Your job: inspect the workspace and the live cluster, then EITHER edit files (Dockerfile, app source, k8s manifests, …) so the next scripted deploy succeeds, OR run `kubectl` / `az` commands yourself to fix it directly. Both are fine — Liliput will detect the recovered state and continue.',
          '',
          'Likely causes to investigate:',
          `  - app does not bind to 0.0.0.0:${context.port} (binds to localhost only?)`,
          `  - app expects a different PORT env var than ${context.port}`,
          `  - app crashes on startup (missing config, missing env, bad command)`,
          `  - app expects to be served at /, but Liliput serves it under \`${context.pathPrefix ?? '(none)'}\` — set BASE_PATH/NEXT_PUBLIC_BASE_PATH-aware code as needed`,
          '  - container CMD/ENTRYPOINT is wrong',
        ].join('\n');

  const guardrails = [
    '## You have full power — use it',
    '',
    '  - You have access to: bash, git, az, kubectl, docker, curl, gh, plus all read/write/edit tools.',
    '  - You may edit any file in the repo, including infra/, k8s/, Dockerfile, .github/ — if that is genuinely the right fix.',
    '  - You may run remote commands yourself: `az acr build …`, `kubectl apply …`, `kubectl rollout …`, etc.',
    '    If you successfully build/deploy yourself, that is great — Liliput will detect the recovered state and continue.',
    '  - You may also commit and push yourself if useful (e.g. to trigger a downstream workflow). Liliput is idempotent here.',
    '',
    '## Soft guidance',
    '',
    '  - Make the smallest change that fixes the failure. Do not remove existing functionality unrelated to the bug.',
    '  - Stay inside the cloned target repo for file edits. Stay on the current git branch.',
    '  - Read files before editing. Show your reasoning briefly.',
    '  - When you finish, reply with a 1-2 sentence summary of what you did and why.',
  ].join('\n');

  return [
    'You are the Liliput ops-fixer agent. A scripted operation just failed and you must fix the underlying cause in the source repo.',
    '',
    phaseHeader,
    '',
    '## Failure summary',
    '',
    errorMessage,
    '',
    '## Error output (tail-truncated)',
    '',
    '```',
    errBlob,
    '```',
    '',
    `## Context`,
    '',
    `  - Target repo: ${context.repo}`,
    `  - Dockerfile: ${context.dockerfile}`,
    `  - Expected container port: ${context.port}`,
    context.namespace ? `  - K8s namespace: ${context.namespace}` : '',
    context.pathPrefix ? `  - URL prefix: ${context.pathPrefix}` : '',
    context.imageRef ? `  - Image ref: ${context.imageRef}` : '',
    '',
    guardrails,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Run a single fixer turn. Returns the model's summary + tool-call count.
 * The caller is responsible for re-running the scripted op afterwards
 * and for committing/pushing any file changes the fixer made.
 */
export async function runOpsFixer(opts: OpsFixerOptions): Promise<RunAgentResult> {
  const prompt = buildPrompt(opts);
  return runAgentTurn(opts.session, {
    taskTitle: '(ops-fixer)',
    taskDescription: opts.errorMessage,
    isInitial: false,
    promptOverride: prompt,
    timeoutMs: FIXER_TIMEOUT_MS,
    ...(opts.onLog ? { onLog: opts.onLog } : {}),
    ...(opts.onToolEvent ? { onToolEvent: opts.onToolEvent } : {}),
  });
}
