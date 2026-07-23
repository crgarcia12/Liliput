/**
 * Real agent engine — the brains behind Liliput.
 *
 * Lifecycle of one task:
 *   1. clone the target repo into /workspaces/<taskId>
 *   2. branch off as `liliput/task-<taskId>`
 *   3. invoke the LLM-driven edit loop (engine/agent-loop.ts)
 *   4. detect or generate a Dockerfile
 *   5. commit changes
 *   6. build the image via `az acr build`
 *   7. deploy to a per-(repo,branch) namespace in this AKS
 *   8. patch the gateway so it's reachable at /dev/<owner>/<repo>/<branch>/
 *   9. flip the task to "review" — user inspects, then ships or discards
 *
 * Streaming: each phase has its own pseudo-agent in the task store so the UI
 * can render progress per role (architect, coder, builder, deployer, …).
 */

import type { Server as SocketServer } from 'socket.io';
import { promises as fs } from 'fs';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import type {
  AgentRole,
  Task,
  PipelineStage,
  PipelineStageStatus,
  PipelineState,
} from '../../../shared/types/index.js';
import * as store from '../stores/task-store.js';
import * as turnStore from '../stores/turn-store.js';
import { logger } from '../logger.js';
import * as git from './git-client.js';
import { CheckpointWriter } from './checkpoint-writer.js';
import {
  createAgentSession,
  runAgentTurn,
  disposeAgentSession,
  abortAgentTurn,
  applyModelChange,
  type AgentSession,
} from './agent-loop.js';
import { resolveDockerfile } from './dockerfile-detector.js';
import { resolveAgentSdkParams } from './agent-config.js';
import { acrBuild } from './azure-builder.js';
import { isRecoverableSdkError, resetCopilotClient } from './copilot-client.js';
import { runOpsFixer } from './ops-fixer.js';
import { runGitOpWithFixer } from './git-fixer.js';
import { guardMainConflicts } from './conflict-guard.js';
import {
  ensureNamespace,
  deployApp,
  waitDeploymentReady,
  devEnvName,
  sanitiseK8sName,
  deleteNamespace,
  deleteDeployment,
  deleteService,
  listDevPods,
  getPodLogs,
  type DevPodInfo,
} from './k8s-deployer.js';
import { syncRoutes, type DevRoute } from './nginx-patcher.js';
import {
  buildPullRequestDescription,
  findPullRequestByHead,
  openPullRequest,
  markPullRequestReady,
  closePullRequest,
  updatePullRequestBody,
} from './github-pr.js';
import { linkPrToFeature } from './pm-issue-flow.js';
import * as featureStore from '../stores/feature-store.js';
import { pathPrefixFor, writeContractIntoWorkspace } from './liliput-deploy-contract.js';
import { writeAcceptanceFeature } from './acceptance-feature-writer.js';
import { installCucumberIfMissing } from './cucumber-installer.js';
import { gateVerdict } from './autopilot.js';
import { latestVerdictForTask } from '../stores/verdict-store.js';
import { recordAndDecide as recordStuck, resetStuckHistory } from './stuck-detector.js';
import { runGherkinChecks } from './gherkin-runner.js';
import { triggerPipelineReview, consumeReviewerFeedbackForCoder } from './reviewer-trigger.js';
import {
  rewriteRequest,
  generatePlan,
  critiquePlan,
  composePlanningContext,
  type StageConfig,
} from './pipeline-stages.js';

const ACR_NAME = process.env['ACR_NAME'] ?? '';
const PUBLIC_BASE_URL = process.env['LILIPUT_PUBLIC_URL'] ?? 'https://liliput.crgarcia.com.ar';
const DEFAULT_REPO = process.env['LILIPUT_DEFAULT_TARGET_REPO'];
/** How many times to invoke the ops-fixer agent for build/deploy failures. */
const MAX_BUILD_FIX_ATTEMPTS = parseInt(process.env['MAX_BUILD_FIX_ATTEMPTS'] ?? '2', 10);
const MAX_DEPLOY_FIX_ATTEMPTS = parseInt(process.env['MAX_DEPLOY_FIX_ATTEMPTS'] ?? '2', 10);
/**
 * Per-round conflict guard: after each iteration's push, reconcile the branch
 * with the base branch and Copilot-resolve any conflicts. On by default (kill
 * switch: LILIPUT_CONFLICT_GUARD_ENABLED=0).
 */
const CONFLICT_GUARD_ENABLED = process.env['LILIPUT_CONFLICT_GUARD_ENABLED'] !== '0';
/**
 * Cap for the post-deploy validate+heal loop. The user's mandate is "press
 * the button and walk away — keep trying until it works." This cap is a
 * cost-safety net, not a give-up philosophy. With stuck-detection rotating
 * strategy hints we want a generous budget (200) before bailing entirely.
 * Override via env if you need tighter control during cost spikes.
 */
const MAX_VALIDATE_ATTEMPTS = parseInt(process.env['MAX_VALIDATE_ATTEMPTS'] ?? '200', 10);
/** How long to wait between probes for the very first validation (lets app boot). */
const VALIDATE_INITIAL_SETTLE_MS = parseInt(process.env['VALIDATE_INITIAL_SETTLE_MS'] ?? '8000', 10);

/**
 * Autopilot gate decision. Reads the latest `VERDICT:` line the agent
 * emitted, runs it through `gateVerdict`, and:
 *
 *  - on healthy exit: logs that the verdict (if any) is accepted.
 *  - on cap-exhausted exit: if the agent had claimed `done`, post a chat
 *    message refuting the claim so the user can see the agent over-promised.
 *
 * No shadow anymore — this is enforcing. The "enforcement" is observational
 * for now (chat message + log) since the loop already exits at cap; future
 * PRs will let the gate force additional iterations or trigger a strategy
 * pivot.
 */
function applyVerdictGate(
  io: SocketServer,
  taskId: string,
  outcome: { deployHealthy: boolean; exitReason: 'healthy' | 'exhausted' },
): void {
  try {
    const v = latestVerdictForTask(taskId);
    if (!v) {
      logger.info(
        { taskId, exitReason: outcome.exitReason, deployHealthy: outcome.deployHealthy },
        'autopilot/gate: no verdict on file',
      );
      return;
    }
    const reject = gateVerdict({
      verdict: { status: v.status, reason: v.reason ?? '', raw: v.raw ?? '' },
      objective: {
        testsExitCode: null,
        deployHealthy: outcome.deployHealthy,
        gherkinAllPassed: false,
        checksRan: { tests: false, deploy: true, gherkin: false },
      },
    });
    logger.info(
      {
        taskId,
        verdict: v.status,
        verdictReason: v.reason,
        exitReason: outcome.exitReason,
        deployHealthy: outcome.deployHealthy,
        accepted: reject === null,
        rejectReason: reject,
      },
      'autopilot/gate decision',
    );
    // If the agent claimed done but we exhausted the loop unhealthy, surface
    // it to the user — the verdict was over-promising.
    if (
      outcome.exitReason === 'exhausted' &&
      v.status === 'done' &&
      reject !== null
    ) {
      const msg = store.addChatMessage(
        taskId,
        'liliput',
        `🚫 The agent claimed \`VERDICT: done\` but the deploy gate rejected it: ${reject}`,
      );
      if (msg) io.to(`task:${taskId}`).emit('chat:message', msg);
    }
  } catch (err) {
    logger.warn(
      { taskId, err: err instanceof Error ? err.message : String(err) },
      'autopilot/gate failed (non-fatal)',
    );
  }
}

interface DevEnvRecord {
  taskId: string;
  pathPrefix: string;
  upstreamHost: string;
  upstreamPort: number;
  namespace: string;
}
const devEnvs = new Map<string, DevEnvRecord>();

// ─── Dev-env lifecycle locking ─────────────────────────────────────────
//
// Stop / Start / Delete and the auto-resurrection from chat can interleave
// with each other and with the build/deploy pipeline. We serialise per-task
// lifecycle ops with an in-process mutex (chained Promise) and serialise
// gateway nginx route writes with a global mutex so concurrent ops never
// stamp on each other.
//
// Multi-pod safety: this is in-process only. The auto-resume path already
// refuses to run when LILIPUT_REPLICA_COUNT > 1 (see index.ts); same single-
// pod assumption applies here. Forward-compat: the tasks table has the
// owner_pod_id + lease_expires_at columns — when we go multi-pod, gate
// lifecycle ops on a SQLite compare-and-set against that lease.
const taskLifecycleLocks = new Map<string, Promise<unknown>>();
function withTaskLifecycleLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  const prior = taskLifecycleLocks.get(taskId) ?? Promise.resolve();
  const next = prior.then(fn, fn);
  taskLifecycleLocks.set(
    taskId,
    next.catch(() => undefined),
  );
  // Best-effort cleanup so the map doesn't grow unbounded.
  void next.finally(() => {
    if (taskLifecycleLocks.get(taskId) === next.catch(() => undefined)) {
      taskLifecycleLocks.delete(taskId);
    }
  });
  return next;
}

let routesSyncChain: Promise<unknown> = Promise.resolve();
function syncRoutesSerialized(): Promise<void> {
  // Recompute activeRoutes() INSIDE the lock so we never serialise a stale
  // snapshot taken before a prior write completed.
  const next = routesSyncChain.then(
    () => syncRoutes(activeRoutes()),
    () => syncRoutes(activeRoutes()),
  );
  routesSyncChain = next.catch(() => undefined);
  return next;
}

/**
 * Live per-task session state — kept in memory between iterations so the
 * agent's conversation memory survives across follow-up chat messages
 * (Copilot CLI–style multi-turn, but persistent in the cluster).
 */
interface LiveSession {
  agentSession: AgentSession;
  repoHandle: git.RepoHandle;
  repo: string;
  branch: string;
  imageName: string;
  pathPrefix: string;
  namespace: string;
  dockerfile: string;
  port: number;
  /**
   * Set true by `resurrectLiveSession` and consumed (cleared) by the first
   * `runIteration` after resurrection. Triggers a `Recap` block in the
   * follow-up prompt so the agent gets a transcript of what was discussed
   * before the pod restart.
   */
  freshlyResurrected?: boolean;
}
const liveSessions = new Map<string, LiveSession>();

function appendImplementationNote(
  existing: readonly string[] | undefined,
  summary: string | undefined,
): string[] {
  const note = summary?.trim();
  if (!note) return [...(existing ?? [])];
  return [...(existing ?? []), note];
}

function mergeImplementationFiles(
  existing: readonly string[] | undefined,
  additions: readonly string[],
): string[] {
  return Array.from(new Set([...(existing ?? []), ...additions]));
}

async function collectImplementationFiles(
  taskId: string,
  handle: git.RepoHandle,
  baseSha: string | undefined,
  fallback: readonly string[],
): Promise<string[]> {
  if (!baseSha) return mergeImplementationFiles(undefined, fallback);
  try {
    return await git.filesChangedSince(handle, baseSha);
  } catch (err) {
    logger.warn(
      { taskId, baseSha, err: err instanceof Error ? err.message : String(err) },
      'Could not collect complete PR file list; using observed changed files',
    );
    return mergeImplementationFiles(undefined, fallback);
  }
}

function taskPullRequestDescription(
  task: Pick<Task, 'description'>,
  options: {
    implementationNotes?: readonly string[];
    changedFiles?: readonly string[];
    commitSha?: string;
    previewUrl?: string;
    validationHealthy?: boolean;
  },
): string {
  return buildPullRequestDescription({
    ...options,
    originalPrompt: task.description,
  });
}

async function refreshPullRequestDescription(
  taskId: string,
  task: Pick<Task, 'description' | 'repository' | 'pullRequestNumber'>,
  options: {
    implementationNotes?: readonly string[];
    changedFiles?: readonly string[];
    commitSha?: string;
    previewUrl?: string;
    validationHealthy?: boolean;
  },
): Promise<void> {
  if (!task.repository || task.pullRequestNumber === undefined) return;
  try {
    await updatePullRequestBody(
      task.repository,
      task.pullRequestNumber,
      taskPullRequestDescription(task, options),
    );
  } catch (err) {
    logger.warn(
      {
        taskId,
        prNumber: task.pullRequestNumber,
        err: err instanceof Error ? err.message : String(err),
      },
      'Could not refresh PR description',
    );
  }
}

/**
 * Per-task state for an *in-flight* agent pipeline (i.e., between
 * createAgentSession and the final liveSessions stash, or during iterateTask).
 *
 * Lets the chat handler preempt a running LLM turn: when a user sends a chat
 * message while the agent is mid-turn, we push it into `pendingChatMessages`
 * and call `abortAgentTurn(agentSession)` so the SDK's sendAndWait returns
 * promptly. Then `drainPendingChatMessages` runs follow-up turns on the same
 * session (preserving conversation memory) so the agent addresses the user's
 * new instruction before the pipeline continues.
 */
interface InFlightAgent {
  agentSession: AgentSession;
  pendingChatMessages: string[];
  taskTitle: string;
  taskDescription: string;
  spec?: string;
}
const inFlightAgents = new Map<string, InFlightAgent>();

function registerInFlightAgent(taskId: string, entry: InFlightAgent): void {
  inFlightAgents.set(taskId, entry);
}

function clearInFlightAgent(taskId: string): void {
  inFlightAgents.delete(taskId);
}

/**
 * Called by the chat route when a user sends a message while an agent turn is
 * in flight. Queues the message and aborts the current turn so the agent
 * stops and addresses it on the next turn.
 *
 * Returns true if an in-flight agent was found and the message was queued.
 * Returns false if no agent is currently running (caller should fall back to
 * the post-review iterateTask path).
 */
export function enqueueChatForAgent(taskId: string, message: string): boolean {
  const inFlight = inFlightAgents.get(taskId);
  if (!inFlight) return false;
  inFlight.pendingChatMessages.push(message);
  void abortAgentTurn(inFlight.agentSession);
  return true;
}

/** True if an agent turn is currently in flight for this task. */
export function hasInFlightAgent(taskId: string): boolean {
  return inFlightAgents.has(taskId);
}

/**
 * Drains queued chat messages by running follow-up turns on the same session.
 * Called after each main agent turn so user interruptions are addressed before
 * the pipeline proceeds to the next phase.
 */
async function drainPendingChatMessages(
  io: SocketServer,
  taskId: string,
  agentId: string,
  liliputContext?: { pathPrefix: string; port?: number },
): Promise<void> {
  const inFlight = inFlightAgents.get(taskId);
  if (!inFlight) return;
  while (inFlight.pendingChatMessages.length > 0) {
    const msg = inFlight.pendingChatMessages.shift()!;
    logPhase(
      io,
      taskId,
      agentId,
      'info',
      `🛑 User interrupted — handling: ${msg.substring(0, 80)}`,
    );
    const followUp =
      `User sent a new message while you were working. Stop your previous task ` +
      `and address this instead:\n\n${msg}`;
    try {
      const hb = startHeartbeat(io, taskId, agentId);
      let result;
      try {
        result = await runAgentTurn(inFlight.agentSession, {
          taskTitle: inFlight.taskTitle,
          taskDescription: inFlight.taskDescription,
          spec: inFlight.spec,
          followUp,
          isInitial: false,
          ...(liliputContext ? { liliputContext } : {}),
          onLog: (level, m, cmd, out) => {
            hb.bump();
            logPhase(io, taskId, agentId, level, m, cmd, out);
          },
          onToolEvent: (event) => {
            hb.bump();
            recordToolEvent(io, taskId, agentId, event);
          },
          onUsage: (event) => recordUsageEvent(io, taskId, agentId, event),
        });
      } finally {
        hb.stop();
      }
      const sysMsg = store.addChatMessage(taskId, 'liliput', result.summary);
      if (sysMsg) io.to(`task:${taskId}`).emit('chat:message', sysMsg);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      logPhase(io, taskId, agentId, 'warn', `Follow-up turn failed: ${m}`);
    }
  }
}

function activeRoutes(): DevRoute[] {
  return Array.from(devEnvs.values()).map((e) => ({
    pathPrefix: e.pathPrefix,
    upstreamHost: e.upstreamHost,
    upstreamPort: e.upstreamPort,
  }));
}

/**
 * Rehydrate the in-memory devEnvs map from persisted tasks, then push the
 * combined route table to nginx.
 *
 * Without this, after a liliput-api restart `devEnvs` is empty. The next
 * deploy calls `syncRoutes(activeRoutes())` and overwrites the gateway with
 * only its own route — wiping every previously-deployed task's preview URL
 * (cluster pods stay alive, but the public `/dev/<owner>/<repo>/<branch>`
 * URL starts returning 404).
 *
 * Called once at server startup. Idempotent.
 */
export async function restoreDevRoutesFromStore(): Promise<{ restored: number }> {
  let restored = 0;
  for (const task of store.getTasks()) {
    if (!task.devNamespace || !task.devUrl) continue;
    // Skip envs the user explicitly stopped or deleted — restoring their
    // nginx routes would bring back public 502s pointing at a Service we
    // already removed. Missing devEnvState = legacy task = treat as active.
    if (task.devEnvState === 'stopped' || task.devEnvState === 'deleted') continue;
    // devUrl was constructed as `${PUBLIC_BASE_URL}${pathPrefix}/` — strip
    // both ends back to the bare prefix.
    let pathPrefix = task.devUrl;
    if (pathPrefix.startsWith(PUBLIC_BASE_URL)) {
      pathPrefix = pathPrefix.slice(PUBLIC_BASE_URL.length);
    } else {
      // Fallback: drop scheme+host so we still get the path portion.
      try {
        pathPrefix = new URL(task.devUrl).pathname;
      } catch {
        continue;
      }
    }
    pathPrefix = pathPrefix.replace(/\/+$/, '');
    if (!pathPrefix.startsWith('/dev/')) continue;
    const appName = 'app';
    devEnvs.set(task.id, {
      taskId: task.id,
      pathPrefix,
      upstreamHost: `${appName}.${task.devNamespace}.svc.cluster.local`,
      upstreamPort: 80,
      namespace: task.devNamespace,
    });
    restored++;
  }
  if (restored > 0) {
    try {
      await syncRoutes(activeRoutes());
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), restored },
        'restoreDevRoutesFromStore: syncRoutes failed',
      );
    }
  }
  return { restored };
}

// ─── Dev-env lifecycle (Stop / Start / Delete) ─────────────────────────
//
// User-facing buttons on /dev-environments + auto-resurrect from chat.
// All three are serialised per task via withTaskLifecycleLock and pushed
// through syncRoutesSerialized so concurrent ops never corrupt nginx or
// leave orphaned k8s resources.

const ACTIVE_BUILD_STATUSES = new Set(['building', 'deploying', 'shipping']);

/** Throws if the task is in the middle of a build/deploy/ship — those phases
 *  actively mutate the dev env and racing them with stop/delete corrupts state. */
function assertDevEnvMutable(task: Task): void {
  if (ACTIVE_BUILD_STATUSES.has(task.status)) {
    throw new Error(
      `Cannot change dev environment while task is "${task.status}". Wait for it to settle.`,
    );
  }
  if (hasInFlightAgent(task.id)) {
    throw new Error(
      'Cannot change dev environment while an agent turn is in flight.',
    );
  }
}

/** Reconstruct the public path-prefix from `task.devUrl`. Returns null if
 *  the URL doesn't look like a `/dev/...` preview URL. */
function pathPrefixFromTask(task: Task): string | null {
  if (!task.devUrl) return null;
  let p = task.devUrl;
  if (p.startsWith(PUBLIC_BASE_URL)) p = p.slice(PUBLIC_BASE_URL.length);
  else {
    try { p = new URL(p).pathname; } catch { return null; }
  }
  p = p.replace(/\/+$/, '');
  return p.startsWith('/dev/') ? p : null;
}

function emitDevEnvUpdate(io: SocketServer, task: Task): void {
  io.to(`task:${task.id}`).emit('task:status', { taskId: task.id, status: task.status });
  io.to(`task:${task.id}`).emit('task:dev-env', {
    taskId: task.id,
    devEnvState: task.devEnvState ?? 'active',
    devUrl: task.devUrl ?? null,
    devNamespace: task.devNamespace ?? null,
  });
}

/**
 * Stop a dev env: delete Deployment + Service, drop nginx route. Namespace
 * and image are preserved so `start` is a fast redeploy.
 */
export async function stopDevEnvForTask(io: SocketServer, taskId: string): Promise<Task> {
  return withTaskLifecycleLock(taskId, async () => {
    const task = store.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (!task.devNamespace) throw new Error('Task has no dev environment');
    const currentState = task.devEnvState ?? 'active';
    if (currentState !== 'active') {
      throw new Error(`Dev environment is already "${currentState}".`);
    }
    assertDevEnvMutable(task);

    chatStatus(io, taskId, '⏸ Stopping dev environment…');
    try {
      await deleteDeployment(task.devNamespace, 'app');
      await deleteService(task.devNamespace, 'app');
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      logger.warn({ taskId, err: m }, 'stopDevEnv: k8s delete partial failure');
    }
    devEnvs.delete(taskId);
    try { await syncRoutesSerialized(); } catch (err) {
      logger.warn(
        { taskId, err: err instanceof Error ? err.message : String(err) },
        'stopDevEnv: gateway sync failed',
      );
    }
    const updated = store.updateTask(taskId, { devEnvState: 'stopped' })!;
    chatStatus(io, taskId, '⏸ Dev environment stopped. Send a chat message or click Start to bring it back.');
    emitDevEnvUpdate(io, updated);
    return updated;
  });
}

/**
 * Start (or resurrect) a dev env from cached metadata. Awaits deployment
 * readiness so we don't flip state to `active` while pods are still pulling.
 */
export async function startDevEnvForTask(io: SocketServer, taskId: string): Promise<Task> {
  return withTaskLifecycleLock(taskId, async () => {
    const task = store.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    const currentState = task.devEnvState ?? 'active';
    if (currentState === 'active') return task;
    if (!task.imageRef) throw new Error('No cached image — chat will trigger a fresh build.');
    if (!task.devNamespace) throw new Error('Dev environment metadata is missing.');
    if (!task.devPort) throw new Error('Dev environment port is unknown — rebuild required.');
    const pathPrefix = pathPrefixFromTask(task);
    if (!pathPrefix) throw new Error('Dev environment URL is malformed — rebuild required.');
    assertDevEnvMutable(task);

    chatStatus(io, taskId, `♻ Recreating dev environment (${task.imageRef.split('/').pop()})…`);
    try {
      await ensureNamespace({ name: task.devNamespace, labels: { 'liliput.dev/task-id': taskId } });
      await deployApp({
        namespace: task.devNamespace,
        appName: 'app',
        image: task.imageRef,
        port: task.devPort,
        pathPrefix,
      });
      const ready = await waitDeploymentReady(task.devNamespace, 'app', 120_000);
      if (!ready) {
        logger.warn({ taskId }, 'startDevEnv: deployment not ready within 120s; continuing anyway');
      }
      devEnvs.set(taskId, {
        taskId,
        pathPrefix,
        upstreamHost: `app.${task.devNamespace}.svc.cluster.local`,
        upstreamPort: 80,
        namespace: task.devNamespace,
      });
      await syncRoutesSerialized();
      const updated = store.updateTask(taskId, { devEnvState: 'active' })!;
      chatStatus(io, taskId, `✅ Dev environment is back at ${task.devUrl}`);
      emitDevEnvUpdate(io, updated);
      return updated;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      logger.error({ taskId, err: m }, 'startDevEnv failed');
      chatStatus(io, taskId, `⚠️ Failed to start dev environment: ${m}`);
      throw err;
    }
  });
}

/**
 * Delete a dev env: tear down the namespace and drop the nginx route.
 * Preserves namespace name, image ref, port, and devUrl on the Task so
 * a future Start (or chat message) can resurrect from the cached image.
 */
export async function deleteDevEnvForTask(io: SocketServer, taskId: string): Promise<Task> {
  return withTaskLifecycleLock(taskId, async () => {
    const task = store.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (!task.devNamespace) throw new Error('Task has no dev environment');
    const currentState = task.devEnvState ?? 'active';
    if (currentState === 'deleted') return task;
    assertDevEnvMutable(task);

    chatStatus(io, taskId, '🗑 Deleting dev environment…');
    try {
      await deleteNamespace(task.devNamespace);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      logger.warn({ taskId, err: m }, 'deleteDevEnv: namespace delete failed');
    }
    devEnvs.delete(taskId);
    try { await syncRoutesSerialized(); } catch (err) {
      logger.warn(
        { taskId, err: err instanceof Error ? err.message : String(err) },
        'deleteDevEnv: gateway sync failed',
      );
    }
    const updated = store.updateTask(taskId, { devEnvState: 'deleted' })!;
    chatStatus(io, taskId, '🗑 Dev environment deleted. Send a chat message or click Start to recreate it from the cached image.');
    emitDevEnvUpdate(io, updated);
    return updated;
  });
}

/**
 * Re-trigger an agent turn for tasks that were mid-`building` when the
 * previous container died. Called once at startup, after the boot-time
 * reconciler has marked them `failed`. Each resume:
 *
 *   1. appends a system chat message + activity entry so the user sees
 *      the resurrection in the UI,
 *   2. calls `iterateTask` with a "you were interrupted" prompt — the
 *      engine then re-clones (or re-uses) the workspace, recreates the
 *      Copilot SDK session, and runs another agent turn. `canIterate`
 *      already accepts `failed` status, so no special handling needed.
 *
 * Concurrency is capped (env: LILIPUT_AUTO_RESUME_CONCURRENCY, default 3)
 * to avoid stampeding the API with N parallel `git clone`s right after
 * boot. We stagger starts with a small delay so logs stay readable.
 *
 * Multi-pod safety: this is intentionally a single-pod-only optimisation.
 * Two replicas would each see the same `failed` tasks and both try to
 * resume them, racing on the same workspace PVC. The lease columns
 * (`tasks.owner_pod_id`, `tasks.lease_expires_at`) are populated for
 * forward-compat but NOT enforced. Set `LILIPUT_AUTO_RESUME=false` to
 * disable until lease-based claiming lands.
 */
export async function autoResumeInterruptedTasks(
  io: SocketServer,
  taskIds: string[],
  opts: { concurrency: number; staggerMs?: number } = { concurrency: 3 },
): Promise<{ resumed: number; skipped: number }> {
  if (taskIds.length === 0) return { resumed: 0, skipped: 0 };
  const concurrency = Math.max(1, opts.concurrency);
  const staggerMs = opts.staggerMs ?? 500;
  const RESUME_PROMPT =
    'Your previous turn was interrupted by an API pod restart — any running shell, ' +
    'watcher, or in-flight tool call was killed. Look at the workspace state, re-check ' +
    "what was actually committed/saved, and continue from there. Don't re-do work " +
    "that's already on disk.";

  let resumed = 0;
  let skipped = 0;
  let cursor = 0;

  async function startOne(taskId: string): Promise<void> {
    const t = store.getTask(taskId);
    if (!t || !t.repository || !t.branch) {
      skipped++;
      return;
    }
    if (!canIterate(taskId)) {
      skipped++;
      logger.warn({ taskId }, 'autoResume: canIterate returned false — skipping');
      return;
    }
    const sysMsg = store.addChatMessage(
      taskId,
      'system',
      `🔁 API restarted — resuming this task automatically. The agent will pick up ` +
        `from \`${t.repository}@${t.branch}\`.`,
    );
    if (sysMsg) io.to(`task:${taskId}`).emit('chat:message', sysMsg);
    logger.info({ taskId }, 'autoResume: re-triggering iterateTask after restart');
    try {
      iterateTask(io, taskId, RESUME_PROMPT);
      resumed++;
    } catch (err) {
      skipped++;
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ taskId, err: msg }, 'autoResume: iterateTask threw synchronously');
    }
  }

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= taskIds.length) return;
      // Stagger starts so the API isn't slammed with N parallel clones.
      if (i > 0 && staggerMs > 0) await new Promise((r) => setTimeout(r, staggerMs));
      const id = taskIds[i];
      if (id) await startOne(id);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, taskIds.length) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return { resumed, skipped };
}

function spawnPhase(
  io: SocketServer,
  taskId: string,
  role: AgentRole,
  name: string,
): string | undefined {
  const agent = store.addAgent(taskId, name, role);
  if (!agent) return undefined;
  const ts = new Date().toISOString();
  io.to(`task:${taskId}`).emit('agent:spawned', {
    taskId,
    agentId: agent.id,
    name,
    role,
    timestamp: ts,
  });
  store.addActivityEntry(taskId, {
    kind: 'agent-spawned',
    agentId: agent.id,
    agentName: name,
    message: `${name} (${role}) spawned`,
    timestamp: ts,
  });
  store.updateAgent(taskId, agent.id, { status: 'working', startedAt: ts, toolCallCount: 0 });
  io.to(`task:${taskId}`).emit('agent:status', {
    taskId,
    agentId: agent.id,
    status: 'working',
  });
  store.addActivityEntry(taskId, {
    kind: 'agent-status',
    agentId: agent.id,
    message: `→ working`,
  });
  return agent.id;
}

function logPhase(
  io: SocketServer,
  taskId: string,
  agentId: string,
  level: 'info' | 'warn' | 'error',
  message: string,
  command?: string,
  output?: string,
): void {
  const ts = new Date().toISOString();
  store.addAgentLog(taskId, agentId, level, message, command, output);
  io.to(`task:${taskId}`).emit('agent:log', {
    taskId,
    agentId,
    level,
    message,
    command,
    output,
    timestamp: ts,
  });
  store.addActivityEntry(taskId, {
    kind: 'agent-log',
    agentId,
    level,
    message,
    timestamp: ts,
    ...(command ? { command } : {}),
    ...(output ? { output } : {}),
  });
}

function completePhase(io: SocketServer, taskId: string, agentId: string): void {
  store.updateAgent(taskId, agentId, {
    status: 'completed',
    progress: 100,
    currentAction: undefined,
  });
  io.to(`task:${taskId}`).emit('agent:completed', { taskId, agentId });
  store.addActivityEntry(taskId, {
    kind: 'agent-completed',
    agentId,
    message: '✓ completed',
  });
}

function failPhase(
  io: SocketServer,
  taskId: string,
  agentId: string,
  error: string,
): void {
  store.updateAgent(taskId, agentId, { status: 'failed' });
  io.to(`task:${taskId}`).emit('agent:failed', { taskId, agentId, error });
  store.addActivityEntry(taskId, {
    kind: 'agent-failed',
    agentId,
    level: 'error',
    message: `✗ failed: ${error}`,
  });
}

function setTaskStatus(
  io: SocketServer,
  taskId: string,
  status: Task['status'],
  extra: Partial<Task> = {},
): void {
  store.updateTask(taskId, { status, ...extra });
  io.to(`task:${taskId}`).emit('task:status', { taskId, status, ...extra });
  const errorMessage = (extra as { errorMessage?: string }).errorMessage;
  const devUrl = (extra as { devUrl?: string }).devUrl;
  store.addActivityEntry(taskId, {
    kind: 'task-status',
    level: status === 'failed' ? 'error' : 'info',
    message:
      `Task → ${status}` +
      (errorMessage ? `: ${errorMessage}` : '') +
      (devUrl ? ` (${devUrl})` : ''),
  });
}

/**
 * Emit a short progress message into the task chat. Used during long-running
 * iteration phases so the user sees something happening between "🔁 Iterating…"
 * and the final "✅ Iteration applied!" instead of silence.
 */
function chatStatus(io: SocketServer, taskId: string, text: string): void {
  const msg = store.addChatMessage(taskId, 'liliput', text);
  if (msg) io.to(`task:${taskId}`).emit('chat:message', msg);
}

// ─── Multi-agent pipeline state ───────────────────────────────

const PIPELINE_KEYS: PipelineStage[] = [
  'rewrite',
  'plan',
  'critique',
  'implement',
  'build',
  'deploy',
  'validate',
  'review',
];

function emptyPipelineStages(): Record<PipelineStage, PipelineStageStatus> {
  return {
    rewrite: 'pending',
    plan: 'pending',
    critique: 'pending',
    implement: 'pending',
    build: 'pending',
    deploy: 'pending',
    validate: 'pending',
    review: 'pending',
  };
}

function emitPipeline(io: SocketServer, taskId: string, state: PipelineState): void {
  io.to(`task:${taskId}`).emit('pipeline:stage', {
    taskId,
    runId: state.runId,
    activeStage: state.activeStage,
    stages: state.stages,
    timestamp: state.updatedAt,
  });
}

/** Start a fresh pipeline run — resets all stages to pending and emits. */
function initPipeline(io: SocketServer, taskId: string): PipelineState {
  const ts = new Date().toISOString();
  const state: PipelineState = {
    runId: randomUUID(),
    stages: emptyPipelineStages(),
    startedAt: ts,
    updatedAt: ts,
  };
  store.updateTask(taskId, { pipeline: state });
  emitPipeline(io, taskId, state);
  return state;
}

/** Transition a pipeline stage to a new status, persist, and emit. Never throws. */
function setPipelineStage(
  io: SocketServer,
  taskId: string,
  stage: PipelineStage,
  status: PipelineStageStatus,
  extra: { rewrittenPrompt?: string; plan?: string } = {},
): void {
  try {
    const task = store.getTask(taskId);
    const ts = new Date().toISOString();
    const base: PipelineState =
      task?.pipeline ?? {
        runId: randomUUID(),
        stages: emptyPipelineStages(),
        startedAt: ts,
        updatedAt: ts,
      };
    const stages = { ...emptyPipelineStages(), ...base.stages, [stage]: status };
    const activeStage =
      status === 'active'
        ? stage
        : base.activeStage === stage
          ? undefined
          : base.activeStage;
    const next: PipelineState = {
      ...base,
      stages,
      ...(activeStage ? { activeStage } : { activeStage: undefined }),
      ...(extra.rewrittenPrompt !== undefined ? { rewrittenPrompt: extra.rewrittenPrompt } : {}),
      ...(extra.plan !== undefined ? { plan: extra.plan } : {}),
      updatedAt: ts,
    };
    store.updateTask(taskId, { pipeline: next });
    emitPipeline(io, taskId, next);
  } catch (err) {
    logger.warn(
      { taskId, stage, status, err: err instanceof Error ? err.message : String(err) },
      'setPipelineStage failed (non-fatal)',
    );
  }
}

void PIPELINE_KEYS;

/**
 * Run the three preflight stages — Rewrite → Plan → Critique — and return the
 * composed planning context to inject into the coder turn. Every stage is
 * bounded and non-fatal: failures degrade gracefully (rewrite → original,
 * plan → skipped, critique → no feedback) and never break the build.
 */
async function runPreflightStages(
  io: SocketServer,
  taskId: string,
  task: Task,
  repo: string,
  opts?: { requestTitle?: string; requestText?: string },
): Promise<{ planningContext: string; effectiveRequest: string }> {
  // Resolve each preflight role independently. Today task-level fields only
  // exist for `coder`/`reviewer`; rewriter/architect/critic inherit through
  // the resolver (user profile → env → server default). The coder's per-task
  // pin is the only legacy task field forwarded — used for architect, since
  // the planner traditionally inherited the coder's model when nothing else
  // was set. Profile entries override that fallback.
  const inherit = {
    ...(task.model ? { taskModel: task.model } : {}),
    ...(task.reasoningEffort ? { taskReasoningEffort: task.reasoningEffort } : {}),
  };
  const rewriterSdk = resolveAgentSdkParams(task, 'rewriter');
  const architectSdk = resolveAgentSdkParams(task, 'architect', inherit);
  const criticSdk = resolveAgentSdkParams(task, 'critic');
  const rewriterCfg: StageConfig = {
    model: rewriterSdk.model,
    ...(rewriterSdk.reasoningEffort ? { reasoningEffort: rewriterSdk.reasoningEffort } : {}),
    repository: repo,
  };
  const architectCfg: StageConfig = {
    model: architectSdk.model,
    ...(architectSdk.reasoningEffort ? { reasoningEffort: architectSdk.reasoningEffort } : {}),
    repository: repo,
  };
  const criticCfg: StageConfig = {
    model: criticSdk.model,
    ...(criticSdk.reasoningEffort ? { reasoningEffort: criticSdk.reasoningEffort } : {}),
    repository: repo,
  };

  // For follow-up iterations the "request" is the chat message, not the
  // original task description. Callers pass it via `opts`; otherwise we fall
  // back to the task's own title/description (initial pipeline).
  const requestTitle = opts?.requestTitle ?? task.title;
  const requestText = opts?.requestText ?? task.description;

  // ── Rewrite ──
  let effectiveRequest = requestText;
  let rewrittenPrompt: string | undefined;
  const rewriter = spawnPhase(io, taskId, 'rewriter', 'Rewriter Liliputian');
  setPipelineStage(io, taskId, 'rewrite', 'active');
  try {
    const rw = await rewriteRequest(requestTitle, requestText, rewriterCfg);
    if (rw.ran && rw.rewritten.trim() && rw.rewritten.trim() !== requestText.trim()) {
      effectiveRequest = rw.rewritten;
      rewrittenPrompt = rw.rewritten;
      if (rewriter) logPhase(io, taskId, rewriter, 'info', `Rewrote request for clarity:\n${rw.rewritten}`);
    } else if (rewriter) {
      logPhase(io, taskId, rewriter, 'info', 'Request is already clear — no rewrite needed.');
    }
  } catch (err) {
    if (rewriter)
      logPhase(io, taskId, rewriter, 'warn', `Rewrite skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (rewriter) completePhase(io, taskId, rewriter);
  setPipelineStage(io, taskId, 'rewrite', 'done', rewrittenPrompt ? { rewrittenPrompt } : {});

  // ── Plan ──
  const architect = spawnPhase(io, taskId, 'architect', 'Architect Liliputian');
  setPipelineStage(io, taskId, 'plan', 'active');
  let planMd: string | null = null;
  try {
    const pr = await generatePlan(task.title, effectiveRequest, architectCfg, task.spec);
    planMd = pr.plan;
  } catch (err) {
    if (architect)
      logPhase(io, taskId, architect, 'warn', `Plan skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (architect) {
    if (planMd) logPhase(io, taskId, architect, 'info', `Drafted plan:\n${planMd}`);
    else logPhase(io, taskId, architect, 'info', 'No plan generated — proceeding without one.');
    completePhase(io, taskId, architect);
  }
  setPipelineStage(io, taskId, 'plan', planMd ? 'done' : 'skipped', planMd ? { plan: planMd } : {});

  // ── Critique ──
  let critiqueFeedback: string | null = null;
  if (planMd) {
    const critic = spawnPhase(io, taskId, 'critic', 'Critic Liliputian');
    setPipelineStage(io, taskId, 'critique', 'active');
    try {
      const cr = await critiquePlan(task.title, effectiveRequest, planMd, criticCfg);
      critiqueFeedback = cr.feedback;
      if (critic) {
        if (critiqueFeedback) logPhase(io, taskId, critic, 'info', `Critique of the plan:\n${critiqueFeedback}`);
        else
          logPhase(
            io,
            taskId,
            critic,
            'info',
            cr.ran ? 'Plan looks solid — no blocking concerns.' : 'Critic unavailable — skipping.',
          );
      }
    } catch (err) {
      if (critic)
        logPhase(io, taskId, critic, 'warn', `Critique skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (critic) completePhase(io, taskId, critic);
    setPipelineStage(io, taskId, 'critique', 'done');
  } else {
    setPipelineStage(io, taskId, 'critique', 'skipped');
  }

  const planningContext = composePlanningContext({
    ...(rewrittenPrompt ? { rewritten: rewrittenPrompt } : {}),
    plan: planMd,
    critique: critiqueFeedback,
  });
  return { planningContext, effectiveRequest };
}

/**
 * Single funnel for every SDK tool-event. Replaces the ad-hoc `io.emit(
 * 'agent:tool-event', …)` pattern. It:
 *
 *   1. Updates the agent's `currentAction` so the AgentPanel reflects the
 *      live tool / message / reasoning summary.
 *   2. Persists meaningful events to `activity_entries` so they survive
 *      page reloads (only socket-emitted events were visible before).
 *   3. Emits the live `agent:tool-event` socket message — same shape the
 *      frontend already consumes.
 *
 * Without this, you had no way to tell from the UI whether an agent was
 * working on tool call #50 or had been thinking silently for 5 minutes.
 */
function recordToolEvent(
  io: SocketServer,
  taskId: string,
  agentId: string,
  event: { kind: string; tool?: string; summary: string; details?: string; timestamp?: string; callId?: string },
): void {
  const ts = event.timestamp ?? new Date().toISOString();

  io.to(`task:${taskId}`).emit('agent:tool-event', {
    taskId,
    agentId,
    ...event,
    timestamp: ts,
  });

  // A heartbeat is a synthetic "still thinking" reasoning event from startHeartbeat —
  // we want it to count as liveness (touch updatedAt via the DB write) but NOT
  // overwrite the last useful currentAction the user is reading on the UI.
  const isHeartbeat =
    event.kind === 'reasoning' && /still thinking/i.test(event.summary);
  // Bump the tool-call counter on real tool starts (not on tool-complete to avoid double-counting).
  const isToolStart = event.kind === 'tool-start';

  // Drive the agent's currentAction so AgentPanel shows what it's doing now.
  // tool-complete usually clears the action (we set it to a short ✓ snippet).
  // Skip noisy 'tool-complete' with empty summaries (already filtered in UI but
  // this also prevents a no-op DB write).
  const isNoiseyComplete = event.kind === 'tool-complete' && (!event.summary || event.summary === '✓ ');
  if (!isNoiseyComplete) {
    const action = truncateAction(event.summary);
    if (action) {
      const patch: { currentAction?: string; lastUsefulAction?: string; toolCallCount?: number } = {};
      if (!isHeartbeat) {
        patch.currentAction = action;
        patch.lastUsefulAction = action;
      } else {
        // Heartbeat: still mark agent alive (DB row updatedAt bumps via update()),
        // and surface idle time on currentAction so UI can show "💭 still thinking 60s"
        // but keep lastUsefulAction unchanged.
        patch.currentAction = action;
      }
      if (isToolStart) {
        const cur = store.getAgent(taskId, agentId);
        patch.toolCallCount = (cur?.toolCallCount ?? 0) + 1;
      }
      store.updateAgent(taskId, agentId, patch);
      io.to(`task:${taskId}`).emit('agent:status', {
        taskId,
        agentId,
        status: 'working',
        currentAction: action,
        timestamp: ts,
        ...(typeof patch.toolCallCount === 'number' ? { toolCallCount: patch.toolCallCount } : {}),
      });
    }
  }

  // Persist to activity_entries for the Live Activity panel — but skip the
  // noisiest events so the feed stays scannable.
  if (isNoiseyComplete) return;
  if (event.kind === 'reasoning' && !event.summary) return;
  // Don't persist heartbeat reasoning events — they are pure liveness signals
  // and would otherwise spam the activity log.
  if (isHeartbeat) return;
  store.addActivityEntry(taskId, {
    kind: 'agent-log',
    agentId,
    level: event.kind === 'error' ? 'error' : 'info',
    message: event.summary,
    timestamp: ts,
    ...(event.tool ? { command: event.tool } : {}),
    ...(event.details ? { output: event.details } : {}),
  });
}

/** Aggregate one SDK `assistant.usage` event onto the agent's owning turn.
 *  No-op when we cannot resolve the agent's turn (legacy rows). */
function recordUsageEvent(
  io: SocketServer,
  taskId: string,
  agentId: string,
  event: {
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    nanoAiu?: number;
    durationMs?: number;
  },
): void {
  // Resolve owning turn from the agent (preferred) or the task's current turn
  // (fallback). Either way, it must exist for legacy data.
  const agent = store.getAgent(taskId, agentId);
  const turnId =
    agent?.turnId ?? turnStore.getCurrentTurn(taskId)?.id ?? turnStore.getLastTurn(taskId)?.id;
  if (!turnId) return;
  const updated = turnStore.recordUsage(turnId, {
    model: event.model,
    agentId,
    ...(event.inputTokens != null ? { inputTokens: event.inputTokens } : {}),
    ...(event.outputTokens != null ? { outputTokens: event.outputTokens } : {}),
    ...(event.cacheReadTokens != null ? { cacheReadTokens: event.cacheReadTokens } : {}),
    ...(event.cacheWriteTokens != null ? { cacheWriteTokens: event.cacheWriteTokens } : {}),
    ...(event.nanoAiu != null ? { nanoAiu: event.nanoAiu } : {}),
    ...(event.durationMs != null ? { durationMs: event.durationMs } : {}),
    calls: 1,
  });
  if (updated) {
    io.to(`task:${taskId}`).emit('turn:updated', updated);
  }
}

function truncateAction(s: string): string {
  if (!s) return '';
  const oneLine = s.split('\n')[0] ?? '';
  return oneLine.length > 120 ? oneLine.slice(0, 117) + '…' : oneLine;
}

/**
 * Wrap an agent turn with a heartbeat: every `intervalMs` of silence
 * (no tool / message / reasoning event), emit a "💭 still thinking…" so
 * the user knows the SDK call is alive even when the model is slow to
 * react. The heartbeat resets every time `bump()` is called from the
 * shared event handler.
 */
function startHeartbeat(
  io: SocketServer,
  taskId: string,
  agentId: string,
  intervalMs = 30_000,
): { bump: () => void; stop: () => void } {
  let lastEvent = Date.now();
  const timer = setInterval(() => {
    const idle = Date.now() - lastEvent;
    if (idle < intervalMs) return;
    lastEvent = Date.now();
    const secs = Math.round(idle / 1000);
    recordToolEvent(io, taskId, agentId, {
      kind: 'reasoning',
      summary: `💭 still thinking… (${secs}s of silence)`,
    });
  }, intervalMs);
  return {
    bump: () => {
      lastEvent = Date.now();
    },
    stop: () => clearInterval(timer),
  };
}

// ─── Fixer-driven scripted ops ────────────────────────────────────────
//
// The scripted `acrBuild` and `deployApp` are still the source of truth —
// they handle az workload-identity login, exact Service/Deployment naming
// (which the nginx gateway depends on), env-var injection (BASE_PATH /
// NEXT_PUBLIC_BASE_PATH), readiness waits, etc. When they fail we spawn
// the LLM ops-fixer, which inspects the workspace, edits files (Dockerfile
// / app source), and returns. We commit + push any changes (so the PR
// reflects the fix), recompute the image tag from the new SHA, and retry
// the scripted op. Capped at MAX_*_FIX_ATTEMPTS so we don't loop forever.

interface BuildContext {
  io: SocketServer;
  taskId: string;
  builderAgentId: string;
  agentSession: AgentSession;
  handle: git.RepoHandle;
  branch: string;
  imageName: string;
  dockerfile: string;
  port: number;
  /** Initial commit SHA to tag the first build attempt with. */
  initialSha: string;
}

interface BuildOutcome {
  imageRef: string;
  /** Final commit SHA the image was built from (may be > initialSha if the fixer pushed). */
  sha: string;
}

/**
 * Detects errors that are transient infrastructure problems (not bugs in the
 * user's code or Dockerfile) and should trigger a plain retry instead of the
 * LLM fixer. The classic case is Docker Hub's anonymous-pull rate limit
 * hitting an ACR Build agent that shares an IP with thousands of other
 * tenants — nothing about the user's repo is wrong, the fixer can't help,
 * and a different agent IP a minute later usually succeeds.
 */
function isTransientBuildError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes('toomanyrequests') ||
    lower.includes('pull rate limit') ||
    lower.includes('429 too many requests') ||
    lower.includes('i/o timeout') ||
    lower.includes('temporary failure resolving')
  );
}

const TRANSIENT_BUILD_RETRIES = 3;
const TRANSIENT_BUILD_BACKOFF_MS = 30_000;

/**
 * Run `acrBuild` with fixer-driven recovery. On failure: spawn fixer,
 * commit/push any edits, retry. Returns the image ref of the successful build.
 */
async function buildWithFixer(ctx: BuildContext): Promise<BuildOutcome> {
  let sha = ctx.initialSha;
  let lastErr: unknown;
  let transientRetries = 0;
  for (let attempt = 1; attempt <= MAX_BUILD_FIX_ATTEMPTS + 1; attempt++) {
    const tag = sha.substring(0, 12);
    if (ACR_NAME) {
      store.updateTask(ctx.taskId, {
        imageRef: `${ACR_NAME}.azurecr.io/${ctx.imageName}:${tag}`,
        commitSha: sha,
      });
    }
    try {
      logPhase(
        ctx.io,
        ctx.taskId,
        ctx.builderAgentId,
        'info',
        `Starting az acr build → ${ctx.imageName}:${tag}… (attempt ${attempt}/${MAX_BUILD_FIX_ATTEMPTS + 1})`,
      );
      const buildStart = Date.now();
      const result = await acrBuild({
        cwd: ctx.handle.cwd,
        imageName: ctx.imageName,
        tag,
        dockerfile: ctx.dockerfile,
      });
      logPhase(
        ctx.io,
        ctx.taskId,
        ctx.builderAgentId,
        'info',
        `Image built in ${Math.round((Date.now() - buildStart) / 1000)}s`,
        undefined,
        result.imageRef,
      );
      store.updateTask(ctx.taskId, {
        imageRef: result.imageRef,
        commitSha: sha,
      });
      return { imageRef: result.imageRef, sha };
    } catch (err) {
      lastErr = err;
      const errMsg = err instanceof Error ? err.message : String(err);
      logPhase(
        ctx.io,
        ctx.taskId,
        ctx.builderAgentId,
        'warn',
        `acr build failed (attempt ${attempt}): ${errMsg.split('\n')[0] ?? errMsg}`,
        undefined,
        errMsg,
      );

      // Transient infrastructure failure (e.g. Docker Hub rate limit on a
      // shared ACR build agent IP). Retry with backoff WITHOUT involving the
      // LLM fixer — there's nothing for it to fix.
      if (isTransientBuildError(errMsg) && transientRetries < TRANSIENT_BUILD_RETRIES) {
        transientRetries++;
        logPhase(
          ctx.io,
          ctx.taskId,
          ctx.builderAgentId,
          'info',
          `Transient build error detected (Docker Hub rate limit / network); retrying in ${Math.round(TRANSIENT_BUILD_BACKOFF_MS / 1000)}s without invoking the fixer (transient retry ${transientRetries}/${TRANSIENT_BUILD_RETRIES})`,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, TRANSIENT_BUILD_BACKOFF_MS));
        attempt--; // don't consume a fixer attempt for a transient retry
        continue;
      }

      if (attempt > MAX_BUILD_FIX_ATTEMPTS) break;

      // Spawn a fixer pseudo-agent so the user sees recovery in the UI.
      const fixer = spawnPhase(ctx.io, ctx.taskId, 'fixer', `Fixer Liliputian (build #${attempt})`);
      if (!fixer) break;
      logPhase(ctx.io, ctx.taskId, fixer, 'info', 'Investigating build failure and proposing fixes…');
      try {
        await runOpsFixer({
          session: ctx.agentSession,
          phase: 'build',
          attempt,
          errorMessage: errMsg.split('\n')[0] ?? errMsg,
          errorOutput: errMsg,
          context: {
            repo: ctx.handle.repo,
            dockerfile: ctx.dockerfile,
            port: ctx.port,
            acrName: ACR_NAME,
            imageRef: `${ACR_NAME}.azurecr.io/${ctx.imageName}:${tag}`,
          },
          onLog: (level, msg, cmd, out) => logPhase(ctx.io, ctx.taskId, fixer, level, msg, cmd, out),
          onToolEvent: (event) => recordToolEvent(ctx.io, ctx.taskId, fixer, event),
          onUsage: (event) => recordUsageEvent(ctx.io, ctx.taskId, fixer, event),
        });
      } catch (fixerErr) {
        const m = fixerErr instanceof Error ? fixerErr.message : String(fixerErr);
        failPhase(ctx.io, ctx.taskId, fixer, `Fixer turn failed: ${m}`);
        break;
      }

      // If the fixer touched files, commit + push so the next build picks them up.
      const changed = await git.changedFiles(ctx.handle);
      if (changed.length === 0) {
        logPhase(ctx.io, ctx.taskId, fixer, 'warn', 'Fixer made no file changes — the next build attempt would just repeat the same failure. Aborting fix loop.');
        completePhase(ctx.io, ctx.taskId, fixer);
        break;
      }
      logPhase(ctx.io, ctx.taskId, fixer, 'info', `Fixer changed ${changed.length} file(s); committing…`, undefined, changed.join('\n'));
      const newSha = await runGitOpWithFixer<string>({
        agentSession: ctx.agentSession,
        op: () => git.commitAll(ctx.handle, `fix(agent): build failure recovery (attempt ${attempt})`),
        describe: 'git commit (build-fix)',
        cwd: ctx.handle.cwd,
        branch: ctx.handle.branch,
        repo: ctx.handle.repo,
        recoveryCheck: async () => {
          if (await git.isWorkingTreeClean(ctx.handle)) {
            const head = await git.headSha(ctx.handle);
            return { recovered: true, result: head };
          }
          return { recovered: false };
        },
        onLog: (level, msg, cmd, out) => logPhase(ctx.io, ctx.taskId, fixer, level, msg, cmd, out),
      });
      logPhase(ctx.io, ctx.taskId, fixer, 'info', `Commit ${newSha.substring(0, 7)} ready; pushing…`);
      await runGitOpWithFixer<void>({
        agentSession: ctx.agentSession,
        op: () => git.push(ctx.handle),
        describe: `git push origin ${ctx.handle.branch} (build-fix)`,
        cwd: ctx.handle.cwd,
        branch: ctx.handle.branch,
        repo: ctx.handle.repo,
        recoveryCheck: async () => {
          if (await git.isBranchUpToDateWithRemote(ctx.handle)) {
            return { recovered: true, result: undefined as void };
          }
          return { recovered: false };
        },
        onLog: (level, msg, cmd, out) => logPhase(ctx.io, ctx.taskId, fixer, level, msg, cmd, out),
      });
      sha = newSha;
      store.updateTask(ctx.taskId, { commitSha: sha });
      completePhase(ctx.io, ctx.taskId, fixer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Build failed');
}

interface DeployContext {
  io: SocketServer;
  taskId: string;
  deployerAgentId: string;
  agentSession: AgentSession;
  handle: git.RepoHandle;
  branch: string;
  imageName: string;
  dockerfile: string;
  port: number;
  namespace: string;
  pathPrefix: string;
  /** The image to deploy (may be replaced if a fix triggers a rebuild). */
  initialImageRef: string;
  initialSha: string;
}

interface DeployOutcome {
  imageRef: string;
  sha: string;
}

/**
 * Deploy + readiness with fixer-driven recovery. If the deployment doesn't
 * become ready, the fixer is asked to repair the app/Dockerfile; we then
 * rebuild a new image (new tag) and retry the deploy.
 */
async function deployWithFixer(ctx: DeployContext): Promise<DeployOutcome> {
  let imageRef = ctx.initialImageRef;
  let sha = ctx.initialSha;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_DEPLOY_FIX_ATTEMPTS + 1; attempt++) {
    try {
      logPhase(
        ctx.io,
        ctx.taskId,
        ctx.deployerAgentId,
        'info',
        `Deploying ${imageRef}… (attempt ${attempt}/${MAX_DEPLOY_FIX_ATTEMPTS + 1})`,
      );
      await deployApp({
        namespace: ctx.namespace,
        appName: 'app',
        image: imageRef,
        port: ctx.port,
        env: { PORT: String(ctx.port) },
        pathPrefix: ctx.pathPrefix,
      });
      logPhase(ctx.io, ctx.taskId, ctx.deployerAgentId, 'info', 'Waiting for pod to become ready…');
      const ready = await waitDeploymentReady(ctx.namespace, 'app', 180_000);
      if (!ready) throw new Error('Deployment did not become ready within 3 minutes.');
      return { imageRef, sha };
    } catch (err) {
      lastErr = err;
      const errMsg = err instanceof Error ? err.message : String(err);
      logPhase(
        ctx.io,
        ctx.taskId,
        ctx.deployerAgentId,
        'warn',
        `deploy failed (attempt ${attempt}): ${errMsg.split('\n')[0] ?? errMsg}`,
        undefined,
        errMsg,
      );
      if (attempt > MAX_DEPLOY_FIX_ATTEMPTS) break;

      const fixer = spawnPhase(ctx.io, ctx.taskId, 'fixer', `Fixer Liliputian (deploy #${attempt})`);
      if (!fixer) break;
      logPhase(ctx.io, ctx.taskId, fixer, 'info', 'Investigating deploy failure and proposing fixes…');
      try {
        await runOpsFixer({
          session: ctx.agentSession,
          phase: 'deploy',
          attempt,
          errorMessage: errMsg.split('\n')[0] ?? errMsg,
          errorOutput: errMsg,
          context: {
            repo: ctx.handle.repo,
            dockerfile: ctx.dockerfile,
            port: ctx.port,
            namespace: ctx.namespace,
            pathPrefix: ctx.pathPrefix,
            imageRef,
          },
          onLog: (level, msg, cmd, out) => logPhase(ctx.io, ctx.taskId, fixer, level, msg, cmd, out),
          onToolEvent: (event) => recordToolEvent(ctx.io, ctx.taskId, fixer, event),
          onUsage: (event) => recordUsageEvent(ctx.io, ctx.taskId, fixer, event),
        });
      } catch (fixerErr) {
        const m = fixerErr instanceof Error ? fixerErr.message : String(fixerErr);
        failPhase(ctx.io, ctx.taskId, fixer, `Fixer turn failed: ${m}`);
        break;
      }

      const changed = await git.changedFiles(ctx.handle);
      if (changed.length === 0) {
        logPhase(ctx.io, ctx.taskId, fixer, 'warn', 'Fixer made no file changes — the next deploy attempt would just repeat the same failure. Aborting fix loop.');
        completePhase(ctx.io, ctx.taskId, fixer);
        break;
      }
      logPhase(ctx.io, ctx.taskId, fixer, 'info', `Fixer changed ${changed.length} file(s); committing + rebuilding…`, undefined, changed.join('\n'));
      const newSha = await runGitOpWithFixer<string>({
        agentSession: ctx.agentSession,
        op: () => git.commitAll(ctx.handle, `fix(agent): deploy failure recovery (attempt ${attempt})`),
        describe: 'git commit (deploy-fix)',
        cwd: ctx.handle.cwd,
        branch: ctx.handle.branch,
        repo: ctx.handle.repo,
        recoveryCheck: async () => {
          if (await git.isWorkingTreeClean(ctx.handle)) {
            const head = await git.headSha(ctx.handle);
            return { recovered: true, result: head };
          }
          return { recovered: false };
        },
        onLog: (level, msg, cmd, out) => logPhase(ctx.io, ctx.taskId, fixer, level, msg, cmd, out),
      });
      await runGitOpWithFixer<void>({
        agentSession: ctx.agentSession,
        op: () => git.push(ctx.handle),
        describe: `git push origin ${ctx.handle.branch} (deploy-fix)`,
        cwd: ctx.handle.cwd,
        branch: ctx.handle.branch,
        repo: ctx.handle.repo,
        recoveryCheck: async () => {
          if (await git.isBranchUpToDateWithRemote(ctx.handle)) {
            return { recovered: true, result: undefined as void };
          }
          return { recovered: false };
        },
        onLog: (level, msg, cmd, out) => logPhase(ctx.io, ctx.taskId, fixer, level, msg, cmd, out),
      });
      sha = newSha;
      store.updateTask(ctx.taskId, { commitSha: sha });

      // Rebuild the image with the new SHA so the next deploy picks up the fix.
      const tag = sha.substring(0, 12);
      logPhase(ctx.io, ctx.taskId, fixer, 'info', `Rebuilding ${ctx.imageName}:${tag}…`);
      const rebuilt = await acrBuild({
        cwd: ctx.handle.cwd,
        imageName: ctx.imageName,
        tag,
        dockerfile: ctx.dockerfile,
      });
      imageRef = rebuilt.imageRef;
      store.updateTask(ctx.taskId, { imageRef });
      logPhase(ctx.io, ctx.taskId, fixer, 'info', `Rebuilt: ${imageRef}`);
      completePhase(ctx.io, ctx.taskId, fixer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Deploy failed');
}

// ─── Post-deploy validate-and-heal loop ───────────────────────────────
//
// After a successful deploy, the pod may be Ready but the app might still be
// broken in ways that only show up at runtime — wrong port, wrong base path,
// app crashes a few seconds in, etc. This loop probes the live preview, asks
// the LLM ops-fixer to repair anything it finds, rebuilds + redeploys, and
// loops until healthy. The user said "forever"; we cap at MAX_VALIDATE_ATTEMPTS
// (default 30) to bound token spend and bail-out if the fixer makes no
// progress between attempts.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ValidateResult {
  healthy: boolean;
  /** One-line summary suitable for chat / activity log. */
  summary: string;
  /** Multi-line diagnostic body (HTTP probe + pods + last log lines) for the fixer prompt. */
  diagnostics: string;
  /** Probe details for the UI. */
  httpStatus: number;
  podSummary: string;
}

/**
 * Probe a live dev preview for runtime health.
 *
 * Strategy:
 *   1. HTTP-GET the public preview URL with a 10s timeout. Anything 5xx /
 *      timeout / ECONNREFUSED / unreachable = unhealthy.
 *   2. List pods in the namespace; flag any that are not Running+Ready, or
 *      that have restarted in the last 60s.
 *   3. Pull the last 200 log lines from the primary pod (and the previous
 *      instance if the current one has restarted), so the fixer prompt has
 *      real evidence to reason from.
 *
 * The decision logic is intentionally lenient on 4xx (the app is responding,
 * just nothing at /). 5xx is a hard failure — that's what we hit with the
 * vite-on-8080 case where the Service resolves but the upstream is dead.
 */
async function validateDevPreview(
  devUrl: string,
  namespace: string,
): Promise<ValidateResult> {
  // Step 1: HTTP probe
  let httpStatus = 0;
  let httpBodySnippet = '';
  let httpError: string | null = null;
  let httpFinalUrl = '';
  let httpRedirected = false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    try {
      // Follow redirects (default). A 302 to a broken target is NOT healthy —
      // we want the final response. fetch follows up to 20 redirects by default.
      const r = await fetch(devUrl, { signal: ctrl.signal, redirect: 'follow' });
      httpStatus = r.status;
      httpFinalUrl = r.url;
      httpRedirected = r.redirected;
      const body = await r.text();
      httpBodySnippet = body.slice(0, 500);
    } finally {
      clearTimeout(t);
    }
  } catch (e) {
    httpError = e instanceof Error ? e.message : String(e);
  }

  // Step 2: Pod info
  let pods: DevPodInfo[] = [];
  try {
    pods = await listDevPods(namespace);
  } catch (e) {
    pods = [];
    httpError = httpError ?? `listDevPods failed: ${e instanceof Error ? e.message : String(e)}`;
  }

  const podSummary = pods.length === 0
    ? '(no pods in namespace)'
    : pods
        .map(
          (p) =>
            `${p.name}: phase=${p.phase} ready=${p.ready} restarts=${p.restarts}` +
            (p.reason ? ` reason=${p.reason}` : '') +
            (p.message ? ` msg=${p.message.slice(0, 120)}` : ''),
        )
        .join('\n');

  // Step 3: Logs from the primary pod
  const primary = pods.find((p) => p.phase === 'Running') ?? pods[0];
  let logsTail = '(no pod available)';
  let prevLogsTail = '';
  if (primary) {
    try {
      const log = await getPodLogs(namespace, primary.name, { tailLines: 200 });
      logsTail = log.length > 4000 ? '…' + log.slice(-4000) : log;
    } catch (e) {
      logsTail = `(could not read logs: ${e instanceof Error ? e.message : String(e)})`;
    }
    if (primary.restarts > 0) {
      try {
        const prev = await getPodLogs(namespace, primary.name, { tailLines: 100, previous: true });
        prevLogsTail = prev.length > 2000 ? '…' + prev.slice(-2000) : prev;
      } catch {
        // best effort — previous logs may not exist if the kubelet rotated them
      }
    }
  }

  // Step 4: Decide healthy
  const podsOk =
    pods.length > 0 && pods.every((p) => p.phase === 'Running' && p.ready);
  // Hard-fail on 4xx/5xx / unreachable. 0 means the fetch itself errored.
  // 404 at the dev-preview root means the app doesn't serve its own base path
  // (typical for missing BASE_PATH wiring), which is "broken" from the user's
  // perspective even though the pod is alive — treat it as unhealthy and
  // hand it to the fixer.
  const httpReachable = httpError === null && httpStatus > 0;
  // Only 2xx counts as healthy. With redirect:'follow', any 3xx that resolved
  // to a 2xx is reported as 2xx; any 3xx surfaced here means the redirect
  // chain ended at a 3xx (rare) or hit max-redirects — treat as unhealthy.
  // ALSO: if the redirect chain leaves the dev preview's own base path, the
  // app is misbehaving (e.g. redirecting users to / and getting Liliput's
  // homepage, which is a 200 but completely wrong). Treat as unhealthy.
  const devBase = (() => {
    try {
      const u = new URL(devUrl);
      return `${u.origin}${u.pathname.endsWith('/') ? u.pathname : u.pathname + '/'}`;
    } catch {
      return devUrl;
    }
  })();
  const finalStaysInBase = httpFinalUrl
    ? httpFinalUrl.startsWith(devBase) || httpFinalUrl + '/' === devBase
    : true;
  const httpOk =
    httpReachable && httpStatus >= 200 && httpStatus < 300 && finalStaysInBase;
  const healthy = podsOk && httpOk;

  const finalUrlNote = httpRedirected && httpFinalUrl && httpFinalUrl !== devUrl
    ? ` (redirected → ${httpFinalUrl})`
    : '';

  let summary: string;
  if (healthy) {
    summary = `Pods Ready, HTTP ${httpStatus} from ${devUrl}${finalUrlNote}`;
  } else if (!podsOk) {
    const bad = pods.filter((p) => p.phase !== 'Running' || !p.ready);
    summary =
      bad.length > 0
        ? `Pod ${bad[0]!.name} is ${bad[0]!.phase}${bad[0]!.ready ? '' : '/notReady'}` +
          (bad[0]!.reason ? ` (${bad[0]!.reason})` : '')
        : pods.length === 0
          ? `No pods in namespace ${namespace}`
          : `Pods unstable`;
  } else if (httpError) {
    summary = `HTTP probe of ${devUrl} failed: ${httpError.slice(0, 120)}`;
  } else if (!finalStaysInBase) {
    summary = `HTTP ${httpStatus} from ${devUrl} but redirected OUT of its base path → ${httpFinalUrl} (app is sending users away from its own preview URL — usually missing BASE_PATH wiring on the redirect)`;
  } else if (httpStatus >= 500) {
    summary = `HTTP ${httpStatus} from ${devUrl}${finalUrlNote} (5xx — upstream broken)`;
  } else if (httpStatus >= 400) {
    summary = `HTTP ${httpStatus} from ${devUrl}${finalUrlNote} (4xx — app likely doesn't serve its base path)`;
  } else if (httpStatus >= 300) {
    summary = `HTTP ${httpStatus} from ${devUrl}${finalUrlNote} (3xx — redirect chain didn't resolve to a usable page)`;
  } else {
    summary = `HTTP ${httpStatus} from ${devUrl}${finalUrlNote} (unexpected status)`;
  }

  const diagnostics = [
    '=== HTTP probe ===',
    `URL: ${devUrl}`,
    httpRedirected && httpFinalUrl ? `Final URL after redirects: ${httpFinalUrl}` : '',
    httpError
      ? `Error: ${httpError}`
      : `Status: ${httpStatus}\nBody (first 500 chars):\n${httpBodySnippet || '(empty body)'}`,
    '',
    `=== Pods in ${namespace} ===`,
    podSummary,
    '',
    primary ? `=== Logs (${primary.name}, last 200 lines) ===` : '=== Logs ===',
    logsTail,
    prevLogsTail
      ? `\n=== Previous instance logs (${primary?.name}, last 100 lines) ===\n${prevLogsTail}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  return { healthy, summary, diagnostics, httpStatus, podSummary };
}

interface ValidateContext {
  io: SocketServer;
  taskId: string;
  agentSession: AgentSession;
  handle: git.RepoHandle;
  imageName: string;
  dockerfile: string;
  port: number;
  namespace: string;
  pathPrefix: string;
  devUrl: string;
  initialImageRef: string;
  initialSha: string;
}

interface ValidateOutcome {
  imageRef: string;
  sha: string;
  healthy: boolean;
  attemptsUsed: number;
}

/**
 * Loop: probe live preview → if unhealthy, ask ops-fixer to repair → commit +
 * push + rebuild + redeploy → re-probe. Continues until healthy or until the
 * cap is reached, or until a chat preempt arrives (in which case we bail out
 * cleanly so the chat handler can take over with fresh user intent).
 *
 * Idempotent w.r.t. failures — if any sub-step throws, we surface the error
 * to the validator agent's activity log and bail out of the loop without
 * crashing the caller. The caller's higher-level state (status='review',
 * devUrl set, PR opened) is unaffected by validate-loop failures.
 */
async function validateAndHealLoop(ctx: ValidateContext): Promise<ValidateOutcome> {
  setPipelineStage(ctx.io, ctx.taskId, 'validate', 'active');
  try {
    return await validateAndHealLoopInner(ctx);
  } finally {
    setPipelineStage(ctx.io, ctx.taskId, 'validate', 'done');
  }
}

async function validateAndHealLoopInner(ctx: ValidateContext): Promise<ValidateOutcome> {
  const { io, taskId } = ctx;
  let imageRef = ctx.initialImageRef;
  let sha = ctx.initialSha;

  const tester = spawnPhase(io, taskId, 'tester', 'Validator Liliputian');
  if (!tester) {
    return { imageRef, sha, healthy: false, attemptsUsed: 0 };
  }

  logPhase(
    io,
    taskId,
    tester,
    'info',
    `🩺 Starting post-deploy health loop (cap ${MAX_VALIDATE_ATTEMPTS} attempts).`,
  );
  logger.info(
    { taskId, devUrl: ctx.devUrl, namespace: ctx.namespace },
    'validate-and-heal loop starting',
  );

  // Initial settle delay — lets the app finish boot before the first probe.
  if (VALIDATE_INITIAL_SETTLE_MS > 0) {
    logPhase(
      io,
      taskId,
      tester,
      'info',
      `Letting the app settle for ${Math.round(VALIDATE_INITIAL_SETTLE_MS / 1000)}s before first probe…`,
    );
    await sleep(VALIDATE_INITIAL_SETTLE_MS);
  }

  for (let attempt = 1; attempt <= MAX_VALIDATE_ATTEMPTS; attempt++) {
    // Chat preempt: the user just typed something while we were healing.
    // The validator is the LAST consumer of pendingChatMessages within this
    // iteration — if we don't handle them here, clearInFlightAgent will wipe
    // them on iteration end and the user's intent is permanently lost.
    // So: drain into a coder turn, redeploy any changes, then keep probing.
    const inFlight = inFlightAgents.get(taskId);
    if (inFlight && inFlight.pendingChatMessages.length > 0) {
      const count = inFlight.pendingChatMessages.length;
      logPhase(
        io,
        taskId,
        tester,
        'info',
        `💬 ${count} new chat message(s) arrived during validation — handing them to the coder…`,
      );
      const chatCoder = spawnPhase(
        io,
        taskId,
        'coder',
        `Coder Liliputian (chat #${attempt})`,
      );
      if (chatCoder) {
        try {
          await drainPendingChatMessages(io, taskId, chatCoder, {
            pathPrefix: ctx.pathPrefix,
            port: ctx.port,
          });
        } catch (drainErr) {
          const m = drainErr instanceof Error ? drainErr.message : String(drainErr);
          logPhase(io, taskId, chatCoder, 'warn', `drainPendingChatMessages threw: ${m}`);
        }
        let chatChanged: string[] = [];
        try {
          chatChanged = await git.changedFiles(ctx.handle);
        } catch {
          /* best effort */
        }
        if (chatChanged.length > 0) {
          logPhase(
            io,
            taskId,
            chatCoder,
            'info',
            `Coder produced ${chatChanged.length} file change(s) from chat — redeploying…`,
            undefined,
            chatChanged.join('\n'),
          );
          try {
            const r = await commitBuildAndRedeploy({
              io,
              taskId,
              fixerAgentId: chatCoder,
              ctx,
              imageRef,
              commitMsg: `feat(agent): apply user chat (validate attempt ${attempt})`,
              gitOpDescribe: 'chat-drain',
            });
            sha = r.sha;
            imageRef = r.imageRef;
          } catch (e) {
            const m = e instanceof Error ? e.message : String(e);
            logPhase(io, taskId, chatCoder, 'warn', `Chat-drain redeploy failed: ${m}`);
          }
        }
        completePhase(io, taskId, chatCoder);
      }
      // Loop continues — re-probe the (potentially new) deployment.
      continue;
    }

    logPhase(
      io,
      taskId,
      tester,
      'info',
      `🩺 Probe ${attempt}/${MAX_VALIDATE_ATTEMPTS} — checking ${ctx.devUrl} + pod health…`,
    );
    logger.info(
      { taskId, attempt, max: MAX_VALIDATE_ATTEMPTS, devUrl: ctx.devUrl },
      'validate probe starting',
    );

    let result: ValidateResult;
    try {
      result = await validateDevPreview(ctx.devUrl, ctx.namespace);
    } catch (probeErr) {
      const m = probeErr instanceof Error ? probeErr.message : String(probeErr);
      logPhase(io, taskId, tester, 'warn', `Probe itself errored: ${m}. Retrying in 10s.`);
      logger.warn({ taskId, attempt, err: m }, 'validate probe threw');
      await sleep(10_000);
      continue;
    }

    if (result.healthy) {
      logPhase(io, taskId, tester, 'info', `✅ HTTP healthy: ${result.summary}`);
      logger.info({ taskId, attempt, http: result.httpStatus }, 'validate probe healthy');

      // Stronger gate: run cucumber against the live preview if possible.
      // Failures here re-enter the heal loop so the agent fixes them just
      // like it would fix an HTTP failure.
      let gherkinFail = false;
      try {
        const g = await runGherkinChecks(ctx.handle.cwd, ctx.devUrl);
        if (g.status === 'passed') {
          logPhase(
            io,
            taskId,
            tester,
            'info',
            `🥒 Gherkin scenarios all green (${g.durationMs}ms).`,
          );
        } else if (g.status === 'skipped') {
          logPhase(io, taskId, tester, 'info', `🥒 Gherkin skipped: ${g.reason}`);
        } else {
          gherkinFail = true;
          // Repurpose `result` to drive the fixer with the gherkin failure.
          result = {
            healthy: false,
            httpStatus: result.httpStatus,
            summary: `gherkin scenarios failed: ${g.reason}`,
            diagnostics: g.output,
            podSummary: result.podSummary,
          };
          logPhase(
            io,
            taskId,
            tester,
            'warn',
            `🥒 Gherkin red — re-entering heal loop to fix scenarios.`,
            undefined,
            g.output,
          );
        }
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        logPhase(
          io,
          taskId,
          tester,
          'warn',
          `🥒 Gherkin runner threw: ${m} (treating as skipped)`,
        );
      }

      if (!gherkinFail) {
        applyVerdictGate(io, taskId, { deployHealthy: true, exitReason: 'healthy' });
        completePhase(io, taskId, tester);
        resetStuckHistory(taskId);
        const okMsg = store.addChatMessage(
          taskId,
          'liliput',
          `✅ Dev preview validated and healthy after ${attempt} probe(s).\n\n${result.summary}`,
        );
        if (okMsg) io.to(`task:${taskId}`).emit('chat:message', okMsg);
        return { imageRef, sha, healthy: true, attemptsUsed: attempt };
      }
    }

    logPhase(
      io,
      taskId,
      tester,
      'warn',
      `🔴 Unhealthy: ${result.summary}`,
      undefined,
      result.diagnostics,
    );
    logger.warn(
      { taskId, attempt, http: result.httpStatus, summary: result.summary },
      'validate probe unhealthy',
    );

    // Stuck detection: if we keep hitting the same error class, escalate
    // strategy in the next fixer prompt instead of running the same prompt
    // verbatim.
    const stuckDecision = recordStuck(taskId, result.summary);
    if (stuckDecision.stuck) {
      logPhase(
        io,
        taskId,
        tester,
        'warn',
        `🔁 Stuck on \`${stuckDecision.signature}\` for ${stuckDecision.streak} attempts — escalating fixer strategy (#${stuckDecision.strategyIndex}).`,
      );
      logger.warn(
        {
          taskId,
          signature: stuckDecision.signature,
          streak: stuckDecision.streak,
          strategy: stuckDecision.strategyIndex,
        },
        'validate loop escalating',
      );
    }

    if (attempt >= MAX_VALIDATE_ATTEMPTS) {
      logPhase(
        io,
        taskId,
        tester,
        'warn',
        `Exhausted ${MAX_VALIDATE_ATTEMPTS} validation attempts — pausing the heal loop. Chat to redirect.`,
      );
      applyVerdictGate(io, taskId, { deployHealthy: false, exitReason: 'exhausted' });
      completePhase(io, taskId, tester);
      const stuckMsg = store.addChatMessage(
        taskId,
        'liliput',
        `⚠️  Auto-heal paused after ${MAX_VALIDATE_ATTEMPTS} attempts — last status: ${result.summary}\n\nI tried rotating through ${stuckDecision.strategyIndex !== null ? 'multiple' : 'several'} strategies. Chat with me to redirect — e.g. "revert the last 3 commits and try a static HTML approach instead", or "look at the pod logs and tell me what's actually wrong".`,
      );
      if (stuckMsg) io.to(`task:${taskId}`).emit('chat:message', stuckMsg);
      resetStuckHistory(taskId);
      return { imageRef, sha, healthy: false, attemptsUsed: attempt };
    }

    // Ask the LLM ops-fixer to repair the runtime failure.
    const fixer = spawnPhase(io, taskId, 'fixer', `Fixer Liliputian (validate #${attempt})`);
    if (!fixer) {
      completePhase(io, taskId, tester);
      return { imageRef, sha, healthy: false, attemptsUsed: attempt };
    }

    const hb = startHeartbeat(io, taskId, fixer);
    try {
      try {
        await runOpsFixer({
          session: ctx.agentSession,
          phase: 'validate',
          attempt,
          errorMessage: result.summary,
          errorOutput: result.diagnostics,
          escalationBlock: stuckDecision.escalationBlock ?? undefined,
          context: {
            repo: ctx.handle.repo,
            dockerfile: ctx.dockerfile,
            port: ctx.port,
            namespace: ctx.namespace,
            pathPrefix: ctx.pathPrefix,
            imageRef,
          },
          onLog: (level, msg, cmd, out) => {
            hb.bump();
            logPhase(io, taskId, fixer, level, msg, cmd, out);
          },
          onToolEvent: (event) => {
            hb.bump();
            recordToolEvent(io, taskId, fixer, event);
          },
          onUsage: (event) => recordUsageEvent(io, taskId, fixer, event),
        });
      } finally {
        hb.stop();
      }
    } catch (fixerErr) {
      const m = fixerErr instanceof Error ? fixerErr.message : String(fixerErr);
      failPhase(io, taskId, fixer, `Validate-fixer turn failed: ${m}`);
      completePhase(io, taskId, tester);
      return { imageRef, sha, healthy: false, attemptsUsed: attempt };
    }

    // What did the fixer do? Three cases:
    //   (a) Edited files → commit, push, rebuild, redeploy, re-probe.
    //   (b) Ran kubectl/az itself (e.g. patched a Deployment) → no file diff
    //       but the live state may have changed — wait + re-probe directly.
    //   (c) Made no changes and ran nothing useful → bail out (no point
    //       looping the same probe → same fixer → same nothing).
    let changed: string[] = [];
    try {
      changed = await git.changedFiles(ctx.handle);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      logPhase(io, taskId, fixer, 'warn', `Could not list changed files: ${m}`);
    }

    if (changed.length === 0) {
      logPhase(
        io,
        taskId,
        fixer,
        'info',
        `Fixer made no file changes — re-probing in 10s in case live cluster state was patched directly.`,
      );
      completePhase(io, taskId, fixer);
      await sleep(10_000);
      continue;
    }

    logPhase(
      io,
      taskId,
      fixer,
      'info',
      `Fixer changed ${changed.length} file(s); committing + rebuilding + redeploying…`,
      undefined,
      changed.join('\n'),
    );

    try {
      const r = await commitBuildAndRedeploy({
        io,
        taskId,
        fixerAgentId: fixer,
        ctx,
        imageRef,
        commitMsg: `fix(agent): runtime healing (validate attempt ${attempt})`,
        gitOpDescribe: `validate-fix #${attempt}`,
      });
      sha = r.sha;
      imageRef = r.imageRef;
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      logPhase(io, taskId, fixer, 'warn', `Validate-fix redeploy failed: ${m}. Re-probing anyway.`);
    }
    completePhase(io, taskId, fixer);
  }

  // unreachable
  completePhase(io, taskId, tester);
  return { imageRef, sha, healthy: false, attemptsUsed: MAX_VALIDATE_ATTEMPTS };
}

/**
 * Commit working-tree changes, push, rebuild the image, and redeploy.
 * Used by both the fixer-changed-files path and the chat-drain path inside
 * validateAndHealLoop. Updates the task store with the new sha + imageRef.
 * Throws if commit/push fails fatally (caller logs + decides to continue probing).
 */
async function commitBuildAndRedeploy(opts: {
  io: SocketServer;
  taskId: string;
  fixerAgentId: string;
  ctx: ValidateContext;
  imageRef: string;
  commitMsg: string;
  gitOpDescribe: string;
}): Promise<{ sha: string; imageRef: string }> {
  const { io, taskId, fixerAgentId, ctx, commitMsg, gitOpDescribe } = opts;
  let imageRef = opts.imageRef;

  const newSha = await runGitOpWithFixer<string>({
    agentSession: ctx.agentSession,
    op: () => git.commitAll(ctx.handle, commitMsg),
    describe: `git commit (${gitOpDescribe})`,
    cwd: ctx.handle.cwd,
    branch: ctx.handle.branch,
    repo: ctx.handle.repo,
    recoveryCheck: async () => {
      if (await git.isWorkingTreeClean(ctx.handle)) {
        const head = await git.headSha(ctx.handle);
        return { recovered: true, result: head };
      }
      return { recovered: false };
    },
    onLog: (level, msg, cmd, out) => logPhase(io, taskId, fixerAgentId, level, msg, cmd, out),
  });
  await runGitOpWithFixer<void>({
    agentSession: ctx.agentSession,
    op: () => git.push(ctx.handle),
    describe: `git push origin ${ctx.handle.branch} (${gitOpDescribe})`,
    cwd: ctx.handle.cwd,
    branch: ctx.handle.branch,
    repo: ctx.handle.repo,
    recoveryCheck: async () => {
      if (await git.isBranchUpToDateWithRemote(ctx.handle)) {
        return { recovered: true, result: undefined as void };
      }
      return { recovered: false };
    },
    onLog: (level, msg, cmd, out) => logPhase(io, taskId, fixerAgentId, level, msg, cmd, out),
  });
  store.updateTask(taskId, { commitSha: newSha });

  const tag = newSha.substring(0, 12);
  logPhase(io, taskId, fixerAgentId, 'info', `Rebuilding ${ctx.imageName}:${tag}…`);
  const rebuilt = await acrBuild({
    cwd: ctx.handle.cwd,
    imageName: ctx.imageName,
    tag,
    dockerfile: ctx.dockerfile,
  });
  imageRef = rebuilt.imageRef;
  store.updateTask(taskId, { imageRef });
  logPhase(io, taskId, fixerAgentId, 'info', `Rebuilt: ${imageRef}; rolling out…`);

  await deployApp({
    namespace: ctx.namespace,
    appName: 'app',
    image: imageRef,
    port: ctx.port,
    env: { PORT: String(ctx.port) },
    pathPrefix: ctx.pathPrefix,
  });
  const ready = await waitDeploymentReady(ctx.namespace, 'app', 180_000);
  if (!ready) {
    logPhase(
      io,
      taskId,
      fixerAgentId,
      'warn',
      'Pod did not become Ready within 3 minutes; re-probing anyway.',
    );
  }
  return { sha: newSha, imageRef };
}

export function startBuild(io: SocketServer, taskId: string): void {
  void (async () => {
    const MAX_ATTEMPTS = parseInt(process.env['AGENT_MAX_RETRY_ATTEMPTS'] ?? '5', 10);
    const BACKOFF_BASE_MS = 5_000;
    let lastErr: unknown;
    let succeeded = false;
    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          await runFullPipeline(io, taskId);
          succeeded = true;
          break;
        } catch (err) {
          lastErr = err;
          if (!isRecoverableSdkError(err) || attempt === MAX_ATTEMPTS) {
            break;
          }
          const m = err instanceof Error ? err.message : String(err);
          const backoffMs = BACKOFF_BASE_MS * attempt;
          logger.warn(
            { taskId, attempt, maxAttempts: MAX_ATTEMPTS, backoffMs, err: m },
            'startBuild: recoverable SDK error — resetting and retrying after backoff',
          );
          const retryMsg = store.addChatMessage(
            taskId,
            'system',
            `🔄 Recoverable SDK error during build (attempt ${attempt}/${MAX_ATTEMPTS}): ${m}. Resurrecting in ${Math.round(backoffMs / 1000)}s…`,
          );
          if (retryMsg) io.to(`task:${taskId}`).emit('chat:message', retryMsg);
          liveSessions.delete(taskId);
          await resetCopilotClient();
          await new Promise((r) => setTimeout(r, backoffMs));
        }
      }
      if (!succeeded) {
        const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
        logger.error({ taskId, err: message }, 'Agent pipeline failed after all retry attempts');
        setTaskStatus(io, taskId, 'failed', { errorMessage: message });
        const sysMsg = store.addChatMessage(
          taskId,
          'system',
          `❌ Agent pipeline failed after ${MAX_ATTEMPTS} attempts: ${message}`,
        );
        if (sysMsg) io.to(`task:${taskId}`).emit('chat:message', sysMsg);
      }
    } finally {
      clearInFlightAgent(taskId);
    }
  })();
}

async function runFullPipeline(io: SocketServer, taskId: string): Promise<void> {
  const task = store.getTask(taskId);
  if (!task) throw new Error('Task not found');

  const repo = task.repository ?? DEFAULT_REPO;
  if (!repo) {
    throw new Error('No target repository specified for this task.');
  }
  const baseBranch = task.baseBranch ?? 'main';
  const branch = `liliput/task-${taskId.substring(0, 8)}`;

  // ── Pipeline preflight: Rewrite → Plan → Critique ──
  // These three bounded, non-fatal stages give every request the visible
  // multi-agent flow before the heavy clone/coder work begins. The composed
  // planning context is injected into the coder turn below.
  initPipeline(io, taskId);
  const { planningContext } = await runPreflightStages(io, taskId, task, repo);

  // Coder (implement stage)
  const coder = spawnPhase(io, taskId, 'coder', 'Coder Liliputian');
  if (!coder) throw new Error('Failed to register coder agent');
  setPipelineStage(io, taskId, 'implement', 'active');
  logPhase(io, taskId, coder, 'info', `Commit mode: ${task.commitMode ?? 'pr'}`);

  logPhase(io, taskId, coder, 'info', `Cloning ${repo}…`, `git clone ${repo}`);
  const handle = await git.clone({
    repo,
    ref: baseBranch,
    workdirName: `task-${taskId}`,
    onLog: (msg) => logPhase(io, taskId, coder, 'info', msg),
  });
  logPhase(io, taskId, coder, 'info', `Cloned to ${handle.cwd}`);

  logPhase(io, taskId, coder, 'info', `Creating branch ${branch}`, `git checkout -b ${branch}`);
  await git.createBranch(handle, branch);
  store.updateTask(taskId, { branch });

  // Reserve the branch on origin immediately so a pod crash mid-turn can
  // recover by re-cloning from the remote — without this, ``task.branch``
  // would only be set after the Builder phase succeeds, and any crash
  // during the (long) Coder turn would silently lose all work.
  let branchReserved = false;
  try {
    logPhase(io, taskId, coder, 'info', `Reserving branch on origin…`, `git push --set-upstream origin ${branch}`);
    await git.pushInitialBranch(handle, {
      onLog: (m) => logPhase(io, taskId, coder, 'info', m),
    });
    branchReserved = true;
    logPhase(io, taskId, coder, 'info', `📌 Branch ${branch} reserved — checkpoints will push here`);
  } catch (err) {
    // Non-fatal: agent can still run, just no resilience to mid-turn crashes.
    logPhase(
      io,
      taskId,
      coder,
      'warn',
      `Could not reserve branch on origin: ${err instanceof Error ? err.message : String(err)}. Continuing without checkpoint protection.`,
    );
  }
  const baselineSha = await git.headSha(handle);
  if (branchReserved) {
    store.updateTask(taskId, { baseCommitSha: baselineSha });
  }

  // Drop the Liliput Deploy Contract into the workspace so the agent can
  // re-read the proxy semantics any time. Excluded from git so it never
  // gets committed into the target repo.
  const pathPrefix = pathPrefixFor(repo, branch);
  await writeContractIntoWorkspace(handle.cwd, { pathPrefix });

  // Drop the spec's Gherkin block as tests/features/acceptance.feature so
  // the agent has a concrete starting point for the TDD loop. Best-effort —
  // never blocks workspace setup.
  try {
    const r = await writeAcceptanceFeature(handle.cwd, task.spec);
    if (r.written) {
      logPhase(
        io,
        taskId,
        coder,
        'info',
        '🥒 Wrote tests/features/acceptance.feature from spec Gherkin',
      );
      // We have a .feature file; make sure cucumber-js is available so the
      // post-deploy gherkin-runner doesn't silently skip. Best-effort.
      try {
        const ic = await installCucumberIfMissing(handle.cwd);
        if (ic.installed) {
          logPhase(
            io,
            taskId,
            coder,
            'info',
            `🥒 Installed @cucumber/cucumber as devDependency (${ic.durationMs}ms)`,
          );
        } else if (
          ic.skippedReason &&
          ic.skippedReason !== 'no-package-json' &&
          ic.skippedReason !== 'already-in-package-json' &&
          ic.skippedReason !== 'already-in-node-modules'
        ) {
          logPhase(
            io,
            taskId,
            coder,
            'warn',
            `(cucumber install skipped: ${ic.skippedReason})`,
          );
        }
      } catch (err) {
        logPhase(
          io,
          taskId,
          coder,
          'warn',
          `Could not install cucumber: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else if (r.skippedReason && r.skippedReason !== 'no-spec') {
      logPhase(
        io,
        taskId,
        coder,
        'info',
        `(acceptance.feature not written: ${r.skippedReason})`,
      );
    }
  } catch (err) {
    logPhase(
      io,
      taskId,
      coder,
      'warn',
      `Could not write acceptance.feature: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const coderSdk = resolveAgentSdkParams(
    task,
    'coder',
    {
      ...(task.model ? { taskModel: task.model } : {}),
      ...(task.reasoningEffort ? { taskReasoningEffort: task.reasoningEffort } : {}),
    },
  );
  logPhase(io, taskId, coder, 'info', `Spawning Copilot SDK session (model: ${coderSdk.model})…`);
  const agentSession = await createAgentSession(handle.cwd, coderSdk.model, coderSdk.reasoningEffort);
  registerInFlightAgent(taskId, {
    agentSession,
    pendingChatMessages: [],
    taskTitle: task.title,
    taskDescription: task.description,
    spec: task.spec,
  });
  logPhase(io, taskId, coder, 'info', 'Invoking LLM agent loop…');
  const hb = startHeartbeat(io, taskId, coder);
  const checkpointer = new CheckpointWriter({
    handle,
    onPushed: () => {
      store.updateTask(taskId, {
        branch,
        baseCommitSha: baselineSha,
      });
    },
    onLog: (level, message) => logPhase(io, taskId, coder, level, message),
  });
  let result;
  try {
    result = await runAgentTurn(agentSession, {
      taskTitle: task.title,
      taskDescription: task.description,
      spec: task.spec,
      isInitial: true,
      liliputContext: { pathPrefix },
      reviewerFeedback: consumeReviewerFeedbackForCoder(io, taskId) ?? undefined,
      ...(planningContext ? { planningContext } : {}),
      onLog: (level, msg, cmd, out) => {
        hb.bump();
        logPhase(io, taskId, coder, level, msg, cmd, out);
      },
      onToolEvent: (event) => {
        hb.bump();
        checkpointer.observe(event);
        recordToolEvent(io, taskId, coder, event);
      },
      onUsage: (event) => recordUsageEvent(io, taskId, coder, event),
    });
  } finally {
    hb.stop();
    // Flush any pending checkpoint synchronously so we never lose work
    // queued in the debounce window when the turn ends (success or failure).
    try {
      await checkpointer.flush();
    } catch (err) {
      logger.warn(
        { taskId, err: err instanceof Error ? err.message : String(err) },
        'Final checkpoint flush failed (non-fatal)',
      );
    }
  }
  await drainPendingChatMessages(io, taskId, coder, { pathPrefix });

  const changedFiles = await git.changedFiles(handle);
  const headSha = await git.headSha(handle);
  const hasCheckpointCommits = Boolean(baselineSha) && baselineSha !== headSha;
  const hasAnyChanges = changedFiles.length > 0 || hasCheckpointCommits;
  logPhase(
    io,
    taskId,
    coder,
    'info',
    `Agent made ${result.toolCallCount} tool calls — ${changedFiles.length} working-tree file(s) changed${hasCheckpointCommits ? ` (+ checkpoint commits ${baselineSha.substring(0, 7)}..${headSha.substring(0, 7)})` : ''}`,
    undefined,
    (result.summary ?? '') +
      (changedFiles.length ? `\n\nChanged files:\n${changedFiles.join('\n')}` : ''),
  );

  if (!hasAnyChanges) {
    const summary = (result.summary ?? '').trim();
    const verdict = summary
      ? summary.split('\n').find((l) => /VERDICT:/i.test(l)) ?? summary.split('\n').slice(-3).join(' ')
      : '';
    const detail = [
      `Agent produced no file changes after ${result.toolCallCount} tool call(s) — nothing to build.`,
      verdict ? `Agent's last words: ${verdict.trim().slice(0, 400)}` : 'Agent did not emit a verdict line.',
      'Common causes: agent gave up without writing code, only ran read-only tools, or hit a tool error it could not recover from.',
    ].join(' ');
    failPhase(io, taskId, coder, detail);
    clearInFlightAgent(taskId);
    await disposeAgentSession(agentSession);
    throw new Error(detail);
  }

  // Coder is done — mark it completed BEFORE the builder spawns so the UI
  // doesn't show two agents running side-by-side. The builder's work is
  // strictly sequential after this point.
  completePhase(io, taskId, coder);
  setPipelineStage(io, taskId, 'implement', 'done');

  // Builder
  setPipelineStage(io, taskId, 'build', 'active');
  const builder = spawnPhase(io, taskId, 'builder', 'Builder Liliputian');
  if (!builder) throw new Error('Failed to register builder agent');

  logPhase(io, taskId, builder, 'info', 'Resolving Dockerfile…');
  const df = await resolveDockerfile(handle.cwd);
  logPhase(io, taskId, builder, 'info', df.notes);

  logPhase(io, taskId, builder, 'info', 'Committing changes…', 'git add -A && git commit');

  // Squash any wip checkpoint commits made during the coder turn back into
  // a single feat: commit. ``baselineSha`` was captured right after we
  // created and pushed the empty branch, so resetting --soft to it
  // collapses the WIP series while preserving the final tree.
  const headBeforeSquash = await git.headSha(handle);
  let didSquash = false;
  if (baselineSha && baselineSha !== headBeforeSquash) {
    try {
      await git.softResetTo(handle, baselineSha);
      didSquash = true;
      logPhase(
        io,
        taskId,
        builder,
        'info',
        `Squashed wip checkpoints (${baselineSha.substring(0, 7)}..${headBeforeSquash.substring(0, 7)}) for clean PR history`,
      );
    } catch (err) {
      // Non-fatal: continue with whatever history we have.
      logPhase(
        io,
        taskId,
        builder,
        'warn',
        `Could not squash checkpoints: ${err instanceof Error ? err.message : String(err)}. Continuing with existing history.`,
      );
    }
  }

  let commitFixerAgent: string | undefined;
  const sha = await runGitOpWithFixer<string>({
    agentSession,
    op: () =>
      git.commitAll(
        handle,
        `feat(agent): ${task.title}\n\n${result.summary ?? ''}\n\nGenerated by Liliput agent for task ${taskId}.`,
      ),
    describe: 'git commit',
    cwd: handle.cwd,
    branch: handle.branch,
    repo,
    recoveryCheck: async () => {
      if (await git.isWorkingTreeClean(handle)) {
        const head = await git.headSha(handle);
        return { recovered: true, result: head };
      }
      return { recovered: false };
    },
    onLog: (level, msg, cmd, out) =>
      logPhase(io, taskId, commitFixerAgent ?? builder, level, msg, cmd, out),
    onFixerTurnStart: () => {
      commitFixerAgent = spawnPhase(io, taskId, 'fixer', 'Fixer Liliputian (git-commit)');
    },
    onFixerTurnEnd: () => {
      if (commitFixerAgent) {
        completePhase(io, taskId, commitFixerAgent);
        commitFixerAgent = undefined;
      }
    },
  });
  store.updateTask(taskId, { commitSha: sha, branch });
  logPhase(io, taskId, builder, 'info', `Commit ${sha.substring(0, 7)} ready`);

  logPhase(io, taskId, builder, 'info', 'Pushing branch…', `git push -u origin ${branch}`);
  let pushFixerAgent: string | undefined;
  await runGitOpWithFixer<void>({
    agentSession,
    op: () => (didSquash ? git.pushForceWithLease(handle) : git.push(handle)),
    describe: `git push${didSquash ? ' --force-with-lease' : ''} --set-upstream origin ${branch}`,
    cwd: handle.cwd,
    branch: handle.branch,
    repo,
    recoveryCheck: async () => {
      if (await git.isBranchUpToDateWithRemote(handle)) {
        return { recovered: true, result: undefined as void };
      }
      return { recovered: false };
    },
    onLog: (level, msg, cmd, out) =>
      logPhase(io, taskId, pushFixerAgent ?? builder, level, msg, cmd, out),
    onFixerTurnStart: () => {
      pushFixerAgent = spawnPhase(io, taskId, 'fixer', 'Fixer Liliputian (git-push)');
    },
    onFixerTurnEnd: () => {
      if (pushFixerAgent) {
        completePhase(io, taskId, pushFixerAgent);
        pushFixerAgent = undefined;
      }
    },
  });
  store.updateTask(taskId, {
    branch,
    baseCommitSha: baselineSha,
    commitSha: sha,
  });
  logPhase(io, taskId, builder, 'info', `Branch pushed to ${repo}`);

  if (!ACR_NAME) {
    failPhase(io, taskId, builder, 'ACR_NAME env var not set — cannot build image.');
    throw new Error('ACR_NAME not configured');
  }

  const repoSlug = sanitiseK8sName(repo.replace('/', '-'));
  const imageName = `liliput-app-${repoSlug}`;
  const buildOutcome = await buildWithFixer({
    io,
    taskId,
    builderAgentId: builder,
    agentSession,
    handle,
    branch,
    imageName,
    dockerfile: df.dockerfile,
    port: df.port,
    initialSha: sha,
  });
  store.updateTask(taskId, { imageRef: buildOutcome.imageRef, commitSha: buildOutcome.sha });
  completePhase(io, taskId, coder);
  completePhase(io, taskId, builder);
  setPipelineStage(io, taskId, 'build', 'done');

  // Deployer
  setPipelineStage(io, taskId, 'deploy', 'active');
  setTaskStatus(io, taskId, 'deploying');
  const deployer = spawnPhase(io, taskId, 'deployer', 'Deployer Liliputian');
  if (!deployer) throw new Error('Failed to register deployer agent');

  const namespace = devEnvName(repo, branch);
  const appName = 'app';
  const devUrl = `${PUBLIC_BASE_URL}${pathPrefix}/`;
  // `pathPrefix` is already in scope from the coder phase above (computed
  // once via pathPrefixFor(repo, branch) right after clone).
  store.updateTask(taskId, {
    devNamespace: namespace,
    devUrl,
    devPort: df.port,
    devEnvState: 'stopped',
  });

  logPhase(io, taskId, deployer, 'info', `Ensuring namespace ${namespace}…`);
  await ensureNamespace({ name: namespace, labels: { 'liliput.dev/task-id': taskId } });

  const deployOutcome = await deployWithFixer({
    io,
    taskId,
    deployerAgentId: deployer,
    agentSession,
    handle,
    branch,
    imageName,
    dockerfile: df.dockerfile,
    port: df.port,
    namespace,
    pathPrefix,
    initialImageRef: buildOutcome.imageRef,
    initialSha: buildOutcome.sha,
  });
  store.updateTask(taskId, { imageRef: deployOutcome.imageRef, commitSha: deployOutcome.sha });

  logPhase(io, taskId, deployer, 'info', `Patching gateway route ${pathPrefix} → ${namespace}/${appName}`);
  devEnvs.set(taskId, {
    taskId,
    pathPrefix,
    upstreamHost: `${appName}.${namespace}.svc.cluster.local`,
    upstreamPort: 80,
    namespace,
  });
  await syncRoutes(activeRoutes());

  store.updateTask(taskId, { devEnvState: 'active' });
  logPhase(io, taskId, deployer, 'info', `Dev environment live at ${devUrl}`);
  completePhase(io, taskId, deployer);
  setPipelineStage(io, taskId, 'deploy', 'done');

  const implementationNotes = appendImplementationNote(undefined, result.summary);
  let implementationChangedFiles = await collectImplementationFiles(
    taskId,
    handle,
    baselineSha,
    changedFiles,
  );
  store.updateTask(taskId, {
    implementationNotes,
    implementationChangedFiles,
  });

  // Auto-open a draft PR right after deploy so the user can see it from the UI
  // during review. Ship marks it ready (or merges in direct mode); Discard closes it.
  const reviewer = spawnPhase(io, taskId, 'reviewer', 'Reviewer Liliputian');
  let prUrl: string | undefined;
  let prNumber: number | undefined;
  if (reviewer && task.repository) {
    const baseBranch = task.baseBranch ?? 'main';
    try {
      const existingPr = await findPullRequestByHead(
        task.repository,
        branch,
        baseBranch,
      );
      logPhase(
        io,
        taskId,
        reviewer,
        'info',
        existingPr
          ? `Reusing pull request #${existingPr.number} for ${branch}`
          : `Opening draft pull request to ${baseBranch}…`,
      );
      const pr =
        existingPr ??
        (await openPullRequest({
          repo: task.repository,
          title: `[liliput] ${task.title}`,
          body: taskPullRequestDescription(task, {
            implementationNotes,
            changedFiles: implementationChangedFiles,
            commitSha: deployOutcome.sha,
            previewUrl: devUrl,
          }),
          head: branch,
          base: baseBranch,
          draft: true,
        }));
      prUrl = pr.htmlUrl;
      prNumber = pr.number;
      store.updateTask(taskId, {
        pullRequestUrl: pr.htmlUrl,
        pullRequestNumber: pr.number,
      });
      logPhase(io, taskId, reviewer, 'info', `Draft PR opened: ${pr.htmlUrl}`);
      // Link PR back to Feature so the RM dispatcher can find it. The PR is
      // still draft — we apply `dev:in-progress` on the issue, not rm:review.
      await linkPrToFeatureForTask(task, pr.number, pr.htmlUrl, /*isDraft*/ true);
      completePhase(io, taskId, reviewer);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      logPhase(io, taskId, reviewer, 'warn', `Could not open draft PR: ${m}`);
      // Don't fail the whole pipeline — user can still ship to retry.
      completePhase(io, taskId, reviewer);
    }
  }

  // Persist the dev URL + namespace + PR info now (so resurrection / UI know
  // where the preview lives), but DON'T flip status to 'review' yet — we
  // first run the autonomous validate-and-heal loop. Users will only see
  // 'review' once we've confirmed the preview is actually healthy (or once
  // the heal loop has exhausted itself and there's nothing more we can do
  // without their input).
  store.updateTask(taskId, {
    devNamespace: namespace,
    devUrl,
    devPort: df.port,
    devEnvState: 'active',
    ...(prUrl ? { pullRequestUrl: prUrl } : {}),
    ...(prNumber !== undefined ? { pullRequestNumber: prNumber } : {}),
  });

  // Stash the live session so follow-up chat messages can iterate on this
  // same workspace + branch + PR. Disposed by ship/discard or new task.
  liveSessions.set(taskId, {
    agentSession,
    repoHandle: handle,
    repo,
    branch,
    imageName,
    pathPrefix,
    namespace,
    dockerfile: df.dockerfile,
    port: df.port,
  });

  const liliputMsg = store.addChatMessage(
    taskId,
    'liliput',
    `🚢 Pod is deployed. Running autonomous validation against the preview now — ` +
      `I'll let you know once it's healthy.\n\n• **Preview (validating):** ${devUrl}\n` +
      (prUrl ? `• **Draft PR:** ${prUrl}\n` : ''),
  );
  if (liliputMsg) io.to(`task:${taskId}`).emit('chat:message', liliputMsg);

  // Now run the autonomous validate-and-heal loop. Pod was Ready at deploy
  // time but the app may still 502 (port mismatch, base path issue, etc.) —
  // probe + repair until healthy or until the cap is reached. User can chat
  // mid-loop; chat preempts cleanly bail out.
  const validateOutcome = await validateAndHealLoop({
    io,
    taskId,
    agentSession,
    handle,
    imageName,
    dockerfile: df.dockerfile,
    port: df.port,
    namespace,
    pathPrefix,
    devUrl,
    initialImageRef: deployOutcome.imageRef,
    initialSha: deployOutcome.sha,
  });

  implementationChangedFiles = await collectImplementationFiles(
    taskId,
    handle,
    baselineSha,
    implementationChangedFiles,
  );
  store.updateTask(taskId, {
    implementationNotes,
    implementationChangedFiles,
  });
  if (prNumber !== undefined) {
    await refreshPullRequestDescription(
      taskId,
      {
        description: task.description,
        repository: task.repository,
        pullRequestNumber: prNumber,
      },
      {
        implementationNotes,
        changedFiles: implementationChangedFiles,
        commitSha: validateOutcome.sha,
        previewUrl: devUrl,
        validationHealthy: validateOutcome.healthy,
      },
    );
  }

  // Reviewer Agent: after the full initial pipeline (coder turn → build → deploy
  // → validate) check whether anything important was missed. Blocks for up to
  // the reviewer timeout (typically a few seconds). If the reviewer flags
  // something the queued feedback will be picked up by the next coder turn.
  setPipelineStage(io, taskId, 'review', 'active');
  try {
    await triggerPipelineReview(io, taskId, {
      workspaceRoot: handle.cwd,
      sha: validateOutcome.sha,
      kind: 'coder-initial',
      coderSummary: result.summary,
      devUrl,
      validationHealthy: validateOutcome.healthy,
      validateAttemptsUsed: validateOutcome.attemptsUsed,
    });
  } catch (err) {
    logger.warn({ taskId, err: err instanceof Error ? err.message : String(err) }, 'Pipeline reviewer threw (non-fatal)');
  }

  // After validate (healthy OR cap-exhausted OR chat-preempt), surface the
  // task as 'review' so the UI lets the user chat / ship / discard. The
  // validate loop already posted the appropriate "✅ healthy" or "⚠️
  // auto-heal paused" chat message — we don't duplicate it here.
  setTaskStatus(io, taskId, 'review', {
    devNamespace: namespace,
    devUrl,
    devPort: df.port,
    devEnvState: 'active',
    ...(prUrl ? { pullRequestUrl: prUrl } : {}),
    ...(prNumber !== undefined ? { pullRequestNumber: prNumber } : {}),
  });
  setPipelineStage(io, taskId, 'review', 'done');
}

export async function shipTask(io: SocketServer, taskId: string): Promise<Task> {
  const task = store.getTask(taskId);
  if (!task) throw new Error('Task not found');
  if (task.status !== 'review') {
    throw new Error(`Cannot ship a task in "${task.status}" status (need "review").`);
  }
  if (!task.repository || !task.branch) {
    throw new Error('Task is missing repository or branch.');
  }

  setTaskStatus(io, taskId, 'shipping');
  const reviewer = spawnPhase(io, taskId, 'reviewer', 'Reviewer Liliputian');
  if (!reviewer) throw new Error('Failed to register reviewer agent');

  try {
    const baseBranch = task.baseBranch ?? 'main';
    let prUrl = task.pullRequestUrl;
    let prNumber = task.pullRequestNumber;

    // Open a PR now if one wasn't auto-created at deploy time (fallback path).
    if (!prNumber) {
      logPhase(io, taskId, reviewer, 'info', `Opening pull request to ${baseBranch}…`);
      const pr = await openPullRequest({
        repo: task.repository,
        title: `[liliput] ${task.title}`,
        body: taskPullRequestDescription(task, {
          implementationNotes: task.implementationNotes,
          changedFiles: task.implementationChangedFiles,
          commitSha: task.commitSha,
          previewUrl: task.devUrl,
        }),
        head: task.branch,
        base: baseBranch,
        draft: false,
      });
      prUrl = pr.htmlUrl;
      prNumber = pr.number;
      logPhase(io, taskId, reviewer, 'info', `Pull request opened: ${pr.htmlUrl}`);
      // Link PR back to Feature + apply rm:review so the RM dispatcher fires.
      await linkPrToFeatureForTask(task, pr.number, pr.htmlUrl, /*isDraft*/ false);
    } else {
      // PR already exists as a draft — mark it ready for review.
      logPhase(io, taskId, reviewer, 'info', `Marking PR #${prNumber} ready for review…`);
      try {
        await refreshPullRequestDescription(taskId, task, {
          implementationNotes: task.implementationNotes,
          changedFiles: task.implementationChangedFiles,
          commitSha: task.commitSha,
          previewUrl: task.devUrl,
        });
        await markPullRequestReady(task.repository, prNumber);
        logPhase(io, taskId, reviewer, 'info', `PR ready for review: ${prUrl}`);
        // After mark-ready, transition the issue + PR labels to rm:review.
        await linkPrToFeatureForTask(task, prNumber, prUrl ?? '', /*isDraft*/ false);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        logPhase(io, taskId, reviewer, 'warn', `Mark-ready failed (PR still open as draft): ${m}`);
      }
    }

    if ((task.commitMode ?? 'pr') === 'direct' && prNumber !== undefined) {
      try {
        logPhase(io, taskId, reviewer, 'info', 'Direct mode — auto-merging PR…');
        await mergePullRequest(task.repository, prNumber);
        logPhase(io, taskId, reviewer, 'info', 'PR merged.');
      } catch (mergeErr) {
        const m = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
        logPhase(io, taskId, reviewer, 'warn', `Auto-merge failed (PR still open): ${m}`);
      }
    }

    completePhase(io, taskId, reviewer);
    setTaskStatus(io, taskId, 'completed', {
      ...(prUrl ? { pullRequestUrl: prUrl } : {}),
      ...(prNumber !== undefined ? { pullRequestNumber: prNumber } : {}),
    });
    // Free the live session — task is finished.
    await tearDownLiveSession(taskId);
    return store.getTask(taskId)!;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failPhase(io, taskId, reviewer, message);
    setTaskStatus(io, taskId, 'failed', { errorMessage: message });
    throw err;
  }
}

export async function discardTask(io: SocketServer, taskId: string): Promise<Task> {
  const task = store.getTask(taskId);
  if (!task) throw new Error('Task not found');

  const cleaner = spawnPhase(io, taskId, 'deployer', 'Cleanup Liliputian');
  await teardownTask(task, {
    log: (level, message) => {
      if (cleaner) logPhase(io, taskId, cleaner, level, message);
    },
  });

  if (cleaner) completePhase(io, taskId, cleaner);
  setTaskStatus(io, taskId, 'discarded', { devUrl: undefined });
  return store.getTask(taskId)!;
}

/**
 * Close a task in place — no PR, no branch delete. Used when the user just
 * wants to park the work where it is: the agent's commits stay on the remote
 * branch, the dev namespace is kept (image cached) so it can be resurrected,
 * and the task transitions to `completed`. Differs from `shipTask` (opens PR)
 * and `discardTask` (closes PR + deletes branch + deletes namespace).
 */
export async function closeTask(io: SocketServer, taskId: string): Promise<Task> {
  const task = store.getTask(taskId);
  if (!task) throw new Error('Task not found');

  // Abort any in-flight agent turn so the SDK stops immediately.
  try {
    const live = liveSessions.get(taskId);
    if (live) abortAgentTurn(live.agentSession);
  } catch (err) {
    logger.warn(
      { taskId, err: err instanceof Error ? err.message : String(err) },
      'closeTask: abort failed (continuing)',
    );
  }

  // Best-effort stop the dev env (preserve namespace + image so a future chat
  // can resurrect it). Skip when already stopped/deleted or when the task
  // never produced one.
  const devEnvState = task.devEnvState ?? 'active';
  if (task.devNamespace && devEnvState === 'active') {
    try {
      await stopDevEnvForTask(io, taskId);
    } catch (err) {
      logger.warn(
        { taskId, err: err instanceof Error ? err.message : String(err) },
        'closeTask: stopDevEnv failed (continuing)',
      );
    }
  }

  // Free the SDK session + on-disk workspace. The branch is already on the
  // remote so nothing about the user's work is lost.
  await tearDownLiveSession(taskId);

  setTaskStatus(io, taskId, 'completed');
  const msg = store.addChatMessage(
    taskId,
    'liliput',
    '🏁 Workstream closed without opening a PR. The branch is preserved on the remote — chat to reopen and continue.',
  );
  if (msg) io.to(`task:${taskId}`).emit('chat:message', msg);
  return store.getTask(taskId)!;
}

/**
 * Cancel an in-flight run without tearing anything down. Aborts the current
 * agent turn (SDK call) and flips the task to `failed` with a "cancelled by
 * user" message. The branch, dev env, and workspace are left intact so the
 * user can pick it back up via chat (which routes through the standard
 * `failed → iterateTask` recovery path).
 */
export async function cancelTask(io: SocketServer, taskId: string): Promise<Task> {
  const task = store.getTask(taskId);
  if (!task) throw new Error('Task not found');

  // Abort the SDK turn (returns control to the engine immediately) and pop
  // any pending chat messages so they don't replay on the next turn.
  try {
    const live = liveSessions.get(taskId);
    if (live) abortAgentTurn(live.agentSession);
  } catch (err) {
    logger.warn(
      { taskId, err: err instanceof Error ? err.message : String(err) },
      'cancelTask: abort live session failed (continuing)',
    );
  }
  const inFlight = inFlightAgents.get(taskId);
  if (inFlight) {
    inFlight.pendingChatMessages.length = 0;
    try {
      void abortAgentTurn(inFlight.agentSession);
    } catch (err) {
      logger.warn(
        { taskId, err: err instanceof Error ? err.message : String(err) },
        'cancelTask: abort in-flight agent failed (continuing)',
      );
    }
  }

  setTaskStatus(io, taskId, 'failed', {
    errorMessage: 'Cancelled by user — chat to continue.',
  });
  const msg = store.addChatMessage(
    taskId,
    'liliput',
    '🛑 Cancelled. Chat with another instruction to resume on the same branch.',
  );
  if (msg) io.to(`task:${taskId}`).emit('chat:message', msg);
  return store.getTask(taskId)!;
}

/**
 * Tear down all external state for a task: close PR, delete remote branch,
 * delete dev k8s namespace, dispose live SDK session, remove workspace dir,
 * resync the gateway. Idempotent — every step is best-effort and logs but
 * doesn't throw on failure (4xx/422 from GitHub typically means already gone).
 *
 * Used by both `discardTask` (soft — flip status to discarded, keep history)
 * and the hard delete routes (purge from DB after teardown).
 */
export async function teardownTask(
  task: Task,
  opts: { log?: (level: 'info' | 'warn' | 'error', message: string) => void } = {},
): Promise<void> {
  const log = opts.log ?? (() => {});

  // Abort any in-flight agent turn so we don't leave the SDK chasing a
  // workspace we're about to delete from disk.
  try {
    const live = liveSessions.get(task.id);
    if (live) {
      log('info', 'Aborting in-flight agent turn…');
      abortAgentTurn(live.agentSession);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('warn', `Abort failed (continuing): ${message}`);
  }

  // Close the PR if one exists.
  if (task.repository && task.pullRequestNumber !== undefined) {
    try {
      log('info', `Closing PR #${task.pullRequestNumber}…`);
      await closePullRequest(task.repository, task.pullRequestNumber);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log('warn', `PR close failed: ${message}`);
    }
  }

  // Delete the dev namespace.
  if (task.devNamespace) {
    try {
      log('info', `Deleting namespace ${task.devNamespace}…`);
      await deleteNamespace(task.devNamespace);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log('warn', `Namespace delete failed: ${message}`);
    }
  }

  // Forget the dev env & resync the gateway.
  devEnvs.delete(task.id);
  try {
    await syncRoutes(activeRoutes());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('warn', `Gateway sync failed: ${message}`);
  }

  // Delete the agent's branch on the remote (never touches main / other branches).
  if (task.repository && task.branch) {
    try {
      log('info', `Deleting remote branch ${task.branch}…`);
      await deleteRemoteBranch(task.repository, task.branch);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log('warn', `Branch delete failed: ${message}`);
    }
  }

  await tearDownLiveSession(task.id);
}

/**
 * Disconnects the SDK session for a task and removes the workspace from disk.
 * Safe to call when no live session exists — in that case it still purges any
 * orphaned `task-<id>` workspace directory the previous pod left behind.
 */
async function tearDownLiveSession(taskId: string): Promise<void> {
  const live = liveSessions.get(taskId);
  if (live) {
    liveSessions.delete(taskId);
    await disposeAgentSession(live.agentSession);
    await git.cleanup(live.repoHandle);
  }
  // Always try to remove the deterministic workspace path — it may exist on
  // disk from a previous pod incarnation even when no in-memory session does.
  await git.removeWorkspaceDir(`task-${taskId}`);
}

/**
 * One-shot pass at startup: delete on-disk `task-*` workspaces whose task no
 * longer needs them (shipped, discarded, failed, or absent from the store).
 * Frees PVC space that would otherwise leak across pod restarts.
 */
export async function purgeOrphanWorkspaces(): Promise<{ removed: number; kept: number }> {
  const dirs = await git.listWorkspaceDirs();
  let removed = 0;
  let kept = 0;
  for (const dir of dirs) {
    const m = /^task-([0-9a-fA-F-]{8,})$/.exec(dir);
    if (!m) {
      // Unknown layout (e.g. legacy `repo-slug-uuid-resurrect-…` dirs from
      // pre-fix builds) — always remove.
      await git.removeWorkspaceDir(dir);
      removed += 1;
      logger.info({ dir }, 'Purged unrecognised workspace directory');
      continue;
    }
    const taskId = m[1]!;
    const task = store.getTask(taskId);
    const terminal = !task || task.status === 'completed' || task.status === 'discarded' || task.status === 'failed';
    if (terminal) {
      await git.removeWorkspaceDir(dir);
      removed += 1;
      logger.info({ taskId, status: task?.status ?? 'missing' }, 'Purged orphan workspace');
    } else {
      kept += 1;
    }
  }
  if (removed > 0 || kept > 0) {
    logger.info({ removed, kept }, 'Workspace orphan purge complete');
  }
  return { removed, kept };
}

/**
 * Iterate on a task that's already in `review` (or `completed`) — the user
 * sent a follow-up chat message and wants the agent to keep editing.
 *
 * Reuses the live SDK session (so conversation memory is preserved) and the
 * existing workspace + branch. Produces a new commit on the same PR and
 * a rolling redeploy of the dev preview.
 */
export function iterateTask(io: SocketServer, taskId: string, message: string): void {
  void (async () => {
    // Auto-retry on recoverable SDK faults (dead subprocess OR idle-watchdog
    // abort). The user may not be present — Liliput agents are expected to
    // run unattended for hours/days, so we keep trying with backoff rather
    // than failing the task on transient SDK problems.
    //
    // Each retry drops the live session + resets the singleton client; the
    // resurrection on the next runIteration call spawns a fresh SDK session
    // and replays a recap from chat history.
    const MAX_ATTEMPTS = parseInt(process.env['AGENT_MAX_RETRY_ATTEMPTS'] ?? '5', 10);
    const BACKOFF_BASE_MS = 5_000;
    let lastErr: unknown;
    let succeeded = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await runIteration(io, taskId, message);
        succeeded = true;
        break;
      } catch (err) {
        lastErr = err;
        if (!isRecoverableSdkError(err) || attempt === MAX_ATTEMPTS) {
          break;
        }
        const m = err instanceof Error ? err.message : String(err);
        const backoffMs = BACKOFF_BASE_MS * attempt;
        logger.warn(
          { taskId, attempt, maxAttempts: MAX_ATTEMPTS, backoffMs, err: m },
          'iterateTask: recoverable SDK error — resetting and retrying after backoff',
        );
        const retryMsg = store.addChatMessage(
          taskId,
          'system',
          `🔄 Recoverable SDK error (attempt ${attempt}/${MAX_ATTEMPTS}): ${m}. Resurrecting in ${Math.round(backoffMs / 1000)}s…`,
        );
        if (retryMsg) io.to(`task:${taskId}`).emit('chat:message', retryMsg);
        liveSessions.delete(taskId);
        await resetCopilotClient();
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
    if (!succeeded) {
      const m = lastErr instanceof Error ? lastErr.message : String(lastErr);
      logger.error({ taskId, err: m }, 'Iteration failed after all retry attempts');
      setTaskStatus(io, taskId, 'failed', { errorMessage: m });
      const sysMsg = store.addChatMessage(
        taskId,
        'system',
        `❌ Iteration failed after ${MAX_ATTEMPTS} attempts: ${m}`,
      );
      if (sysMsg) io.to(`task:${taskId}`).emit('chat:message', sysMsg);
    }
    clearInFlightAgent(taskId);
  })();
}

/**
 * Build a recap block from the task's chat history. Used after a session
 * resurrection (SDK lost in-memory context) so the agent's first follow-up
 * turn has continuity. We include up to the last N messages, oldest-first,
 * and truncate each so a long history doesn't blow the prompt budget.
 *
 * The current `newMessage` is excluded — it appears in the prompt's
 * `## New instruction` block on its own.
 */
function buildResurrectionRecap(
  taskId: string,
  newMessage: string,
  maxMessages = 20,
  maxBytesPerMessage = 600,
): string {
  const all = store.getChatHistory(taskId);
  const filtered = all.filter((m) => m.content !== newMessage);
  const tail = filtered.slice(-maxMessages);
  if (tail.length === 0) return '(no prior chat history on file)';
  const lines: string[] = [];
  for (const m of tail) {
    const who =
      m.role === 'gulliver'
        ? 'USER'
        : m.role === 'liliput'
          ? 'LILIPUT'
          : (m.agentName ?? String(m.role).toUpperCase());
    const body =
      m.content.length > maxBytesPerMessage
        ? m.content.slice(0, maxBytesPerMessage) + '…'
        : m.content;
    lines.push(`### ${who} (${m.timestamp})`);
    lines.push(body);
    lines.push('');
  }
  return lines.join('\n').trim();
}

/**
 * "Pure rebuild command" detection. Returns true when the user's chat
 * message is essentially a deploy directive with no other actionable
 * content (e.g. "rebuild", "redeploy now", "go ahead and rebuild",
 * "rebuild and deploy"). When this fires, iterateTask short-circuits the
 * agent turn entirely and goes straight to marker → commit → build →
 * deploy. The agent has no veto.
 *
 * We deliberately keep this conservative: a message like "rebuild the
 * login form" includes "rebuild" but is NOT a deploy directive, so it
 * runs through the normal agent turn.
 */
export function isPureRebuildCommand(message: string): boolean {
  const m = message.trim().replace(/[.!?]+$/, '').toLowerCase();
  if (!m || m.length > 120) return false;
  // Optional polite/imperative prefixes.
  const prefix =
    '(?:please\\s+|just\\s+|go\\s+ahead\\s+(?:and\\s+)?|can\\s+you\\s+(?:please\\s+)?|i\\s+want\\s+(?:you\\s+)?(?:to\\s+)?)?';
  const verb =
    '(?:re-?build|re-?deploy|deploy|build|push|ship\\s+to\\s+dev)';
  // Optional second verb joined by and/&/then.
  const secondVerb =
    `(?:\\s+(?:and|&|then|,)\\s+${verb})?`;
  // Optional trailing modifiers like "now", "again", "please", "the app",
  // "the preview", "it".
  const suffix =
    '(?:\\s+(?:it|the\\s+(?:app|preview|image|build|task)|now|again|please|the\\s+container|to\\s+dev))*';
  const re = new RegExp(`^${prefix}${verb}${secondVerb}${suffix}$`, 'i');
  return re.test(m);
}

async function runIteration(io: SocketServer, taskId: string, message: string): Promise<void> {
  const task = store.getTask(taskId);
  if (!task) throw new Error('Task not found');

  let live = liveSessions.get(taskId);
  if (!live) {
    if (!task.repository || !task.branch) {
      throw new Error(
        'Cannot resurrect session — task is missing repository or branch metadata.',
      );
    }
    live = await resurrectLiveSession(io, taskId, task);
  }

  // If the user changed the model or reasoning-effort dropdowns since the
  // session was created (or resurrected), push the new values into the live
  // SDK session before the next turn — otherwise the cached session keeps
  // sending the old reasoning_effort and 400s on models like
  // claude-opus-4.7-xhigh that only accept ONE specific value.
  const coderSdk = resolveAgentSdkParams(
    task,
    'coder',
    {
      ...(task.model ? { taskModel: task.model } : {}),
      ...(task.reasoningEffort ? { taskReasoningEffort: task.reasoningEffort } : {}),
    },
  );
  await applyModelChange(live.agentSession, coderSdk.model, coderSdk.reasoningEffort);

  setTaskStatus(io, taskId, 'building');

  const coder = spawnPhase(io, taskId, 'coder', 'Coder Liliputian');
  if (!coder) throw new Error('Failed to register coder agent');

  registerInFlightAgent(taskId, {
    agentSession: live.agentSession,
    pendingChatMessages: [],
    taskTitle: task.title,
    taskDescription: task.description,
    spec: task.spec,
  });

  // Short-circuit: if the user's message is a pure rebuild/redeploy command,
  // skip the agent turn entirely. The agent has no veto over a direct
  // "rebuild" instruction — that's an operator command, not an editing task.
  // We write a marker file so the SHA is unique (unique image tag → real
  // rollout), then drop straight into the commit + build + deploy path.
  const pureRebuild = isPureRebuildCommand(message);
  if (pureRebuild) {
    logPhase(
      io,
      taskId,
      coder,
      'info',
      `Pure rebuild command detected (${JSON.stringify(message.substring(0, 60))}) — skipping agent turn, going straight to build+deploy.`,
    );
    chatStatus(io, taskId, `🔨 Skipping the agent turn — you asked to rebuild, so I'm going straight to build + redeploy.`);
    const ackMsg = store.addChatMessage(
      taskId,
      'liliput',
      `🔨 Direct rebuild requested. Skipping the agent turn and forcing a fresh build + redeploy of the current commit.`,
    );
    if (ackMsg) io.to(`task:${taskId}`).emit('chat:message', ackMsg);
    try {
      const markerPath = path.join(live.repoHandle.cwd, '.liliput-rebuild');
      const stamp = new Date().toISOString();
      await fs.writeFile(
        markerPath,
        `# Liliput rebuild marker — touched ${stamp} on operator request.\n` +
          `# This file exists only to give git a unique commit so the dev\n` +
          `# preview gets a fresh image tag and a real rollout.\n`,
        'utf8',
      );
      logPhase(io, taskId, coder, 'info', `Wrote .liliput-rebuild marker (${stamp})`);
    } catch (markerErr) {
      const m = markerErr instanceof Error ? markerErr.message : String(markerErr);
      logPhase(io, taskId, coder, 'warn', `Could not write rebuild marker: ${m}`);
    }
    completePhase(io, taskId, coder);
    await runRebuildOnly(io, taskId, live, message);
    return;
  }

  // Multi-agent pipeline (follow-up path): run the bounded, non-fatal
  // rewrite → plan → critique preflight on the user's follow-up message, then
  // feed the distilled planning context into the coder turn. Pure rebuild
  // commands returned above, so they correctly skip these LLM stages.
  initPipeline(io, taskId);
  const { planningContext } = await runPreflightStages(io, taskId, task, live.repo, {
    requestTitle: task.title,
    requestText: message,
  });
  setPipelineStage(io, taskId, 'implement', 'active');

  chatStatus(io, taskId, `🛠️  Coder Liliputian is reading your message and editing files — this can take a few minutes…`);
  logPhase(io, taskId, coder, 'info', `Iteration: ${message.substring(0, 200)}`);

  // Consume freshlyResurrected one-shot: build a recap from chat history so
  // the agent has context after the SDK session was rebuilt empty.
  let recap: string | undefined;
  if (live.freshlyResurrected) {
    recap = buildResurrectionRecap(taskId, message);
    live.freshlyResurrected = false;
  }

  const hb = startHeartbeat(io, taskId, coder);
  let result;
  try {
    result = await runAgentTurn(live.agentSession, {
      taskTitle: task.title,
      taskDescription: task.description,
      spec: task.spec,
      followUp: message,
      isInitial: false,
      ...(planningContext ? { planningContext } : {}),
      liliputContext: { pathPrefix: live.pathPrefix, port: live.port },
      recap,
      reviewerFeedback: consumeReviewerFeedbackForCoder(io, taskId) ?? undefined,
      onLog: (level, msg, cmd, out) => {
        hb.bump();
        logPhase(io, taskId, coder, level, msg, cmd, out);
      },
      onToolEvent: (event) => {
        hb.bump();
        recordToolEvent(io, taskId, coder, event);
      },
      onUsage: (event) => recordUsageEvent(io, taskId, coder, event),
    });
  } finally {
    hb.stop();
  }
  await drainPendingChatMessages(io, taskId, coder, {
    pathPrefix: live.pathPrefix,
    port: live.port,
  });

  const changed = await git.changedFiles(live.repoHandle);
  // Force-rebuild detection: user explicitly asked for a rebuild/redeploy in
  // their chat message. Even if the agent didn't make edits, we re-trigger
  // build+deploy from current HEAD so they can test the latest committed
  // state. Without this, the user gets stuck in a "agent says it can't, but
  // also doesn't edit anything" loop.
  const wantsRebuild = /\b(re-?build|re-?deploy|deploy\s+(again|now)|build\s+(again|now)|force\s+(re)?build)\b/i.test(
    message,
  );
  logPhase(
    io,
    taskId,
    coder,
    'info',
    `Iteration: ${result.toolCallCount} tool calls, ${changed.length} file(s) changed${wantsRebuild ? ' [user requested rebuild]' : ''}`,
    undefined,
    result.summary,
  );
  if (changed.length === 0 && !wantsRebuild) {
    logPhase(io, taskId, coder, 'info', 'No file changes this turn — staying on previous commit.');
    completePhase(io, taskId, coder);
    setPipelineStage(io, taskId, 'implement', 'done');
    setPipelineStage(io, taskId, 'review', 'skipped');
    setTaskStatus(io, taskId, 'review');
    const sysMsg = store.addChatMessage(
      taskId,
      'liliput',
      `Done — but the agent didn't change any files this turn. Summary:\n${result.summary}\n\n💡 If you want me to rebuild + redeploy the current commit anyway, ask explicitly (e.g. "rebuild and redeploy now").`,
    );
    if (sysMsg) io.to(`task:${taskId}`).emit('chat:message', sysMsg);
    return;
  }
  if (changed.length === 0 && wantsRebuild) {
    logPhase(
      io,
      taskId,
      coder,
      'info',
      'No file changes, but user requested rebuild — forcing rebuild from current HEAD.',
    );
    // Write a rebuild marker so the commit has real content (unique SHA →
    // unique image tag → real rollout). Without this the rebuild would
    // collide on the same image and AKS would no-op the rollout.
    try {
      const markerPath = path.join(live.repoHandle.cwd, '.liliput-rebuild');
      const stamp = new Date().toISOString();
      await fs.writeFile(
        markerPath,
        `# Liliput rebuild marker — touched ${stamp} on operator request.\n` +
          `# This file exists only to give git a unique commit so the dev\n` +
          `# preview gets a fresh image tag and a real rollout.\n`,
        'utf8',
      );
      logPhase(
        io,
        taskId,
        coder,
        'info',
        `Wrote .liliput-rebuild marker (${stamp})`,
      );
    } catch (markerErr) {
      const m = markerErr instanceof Error ? markerErr.message : String(markerErr);
      logPhase(io, taskId, coder, 'warn', `Could not write rebuild marker: ${m}`);
    }
    const forceMsg = store.addChatMessage(
      taskId,
      'liliput',
      `🔨 No code changes this turn — but you asked to rebuild, so I'm forcing a rebuild + redeploy from the current commit.`,
    );
    if (forceMsg) io.to(`task:${taskId}`).emit('chat:message', forceMsg);
  }

  // Coder is done — mark it completed BEFORE spawning the builder so the UI
  // doesn't show two agents running side-by-side during the (sequential)
  // build phase.
  completePhase(io, taskId, coder);
  setPipelineStage(io, taskId, 'implement', 'done');

  // Commit + push delta.
  setPipelineStage(io, taskId, 'build', 'active');
  const builder = spawnPhase(io, taskId, 'builder', 'Builder Liliputian');
  if (!builder) throw new Error('Failed to register builder agent');

  chatStatus(
    io,
    taskId,
    `📦 Coder finished — ${result.toolCallCount} tool call(s), ${changed.length} file(s) changed. Committing & building image…`,
  );
  logPhase(io, taskId, builder, 'info', 'Committing iteration changes…');
  let iterCommitFixerAgent: string | undefined;
  const sha = await runGitOpWithFixer<string>({
    agentSession: live.agentSession,
    op: () =>
      git.commitAll(
        live.repoHandle,
        `iter(agent): ${truncate(message, 60)}\n\n${result.summary}\n\nLiliput iteration on task ${taskId}.`,
      ),
    describe: 'git commit',
    cwd: live.repoHandle.cwd,
    branch: live.repoHandle.branch,
    repo: live.repo,
    recoveryCheck: async () => {
      if (await git.isWorkingTreeClean(live.repoHandle)) {
        const head = await git.headSha(live.repoHandle);
        return { recovered: true, result: head };
      }
      return { recovered: false };
    },
    onLog: (level, msg, cmd, out) =>
      logPhase(io, taskId, iterCommitFixerAgent ?? builder, level, msg, cmd, out),
    onFixerTurnStart: () => {
      iterCommitFixerAgent = spawnPhase(io, taskId, 'fixer', 'Fixer Liliputian (git-commit)');
    },
    onFixerTurnEnd: () => {
      if (iterCommitFixerAgent) {
        completePhase(io, taskId, iterCommitFixerAgent);
        iterCommitFixerAgent = undefined;
      }
    },
  });
  store.updateTask(taskId, { commitSha: sha });
  logPhase(io, taskId, builder, 'info', `Commit ${sha.substring(0, 7)} ready`);

  logPhase(io, taskId, builder, 'info', 'Pushing branch…', `git push origin ${live.branch}`);
  let iterPushFixerAgent: string | undefined;
  await runGitOpWithFixer<void>({
    agentSession: live.agentSession,
    op: () => git.push(live.repoHandle),
    describe: `git push origin ${live.branch}`,
    cwd: live.repoHandle.cwd,
    branch: live.repoHandle.branch,
    repo: live.repo,
    recoveryCheck: async () => {
      if (await git.isBranchUpToDateWithRemote(live.repoHandle)) {
        return { recovered: true, result: undefined as void };
      }
      return { recovered: false };
    },
    onLog: (level, msg, cmd, out) =>
      logPhase(io, taskId, iterPushFixerAgent ?? builder, level, msg, cmd, out),
    onFixerTurnStart: () => {
      iterPushFixerAgent = spawnPhase(io, taskId, 'fixer', 'Fixer Liliputian (git-push)');
    },
    onFixerTurnEnd: () => {
      if (iterPushFixerAgent) {
        completePhase(io, taskId, iterPushFixerAgent);
        iterPushFixerAgent = undefined;
      }
    },
  });
  logPhase(io, taskId, builder, 'info', 'Branch pushed; PR will pick up the new commit automatically.');

  // Per-round conflict guard: keep the branch free of merge conflicts with the
  // base branch. Cheap-gates on a fetch + ancestor check, does an in-memory
  // conflict probe, and only spawns a Copilot resolver turn when a REAL
  // conflict exists. Never throws — a guard hiccup must not break the round.
  if (CONFLICT_GUARD_ENABLED) {
    let conflictAgent: string | undefined;
    const guardResult = await guardMainConflicts({
      agentSession: live.agentSession,
      handle: live.repoHandle,
      baseBranch: task.baseBranch ?? 'main',
      repo: live.repo,
      autoPush: true,
      ...(task.pullRequestNumber !== undefined ? { prNumber: task.pullRequestNumber } : {}),
      onLog: (level, msg, cmd, out) =>
        logPhase(io, taskId, conflictAgent ?? builder, level, msg, cmd, out),
      onResolverStart: () => {
        conflictAgent = spawnPhase(io, taskId, 'fixer', 'Conflict Resolver Liliputian');
      },
      onResolverEnd: () => {
        if (conflictAgent) {
          completePhase(io, taskId, conflictAgent);
          conflictAgent = undefined;
        }
      },
    });
    if (guardResult.status === 'resolved') {
      chatStatus(
        io,
        taskId,
        `🔀 Resolved merge conflicts with ${task.baseBranch ?? 'main'} (${guardResult.conflictedFiles.length} file(s)).`,
      );
    } else if (guardResult.status === 'unresolved') {
      chatStatus(
        io,
        taskId,
        `⚠️ Could not auto-resolve conflicts with ${task.baseBranch ?? 'main'} — flagged for manual rebase.`,
      );
    }
  }

  if (!ACR_NAME) {
    failPhase(io, taskId, builder, 'ACR_NAME env var not set — cannot rebuild image.');
    throw new Error('ACR_NAME not configured');
  }

  const buildOutcome = await buildWithFixer({
    io,
    taskId,
    builderAgentId: builder,
    agentSession: live.agentSession,
    handle: live.repoHandle,
    branch: live.branch,
    imageName: live.imageName,
    dockerfile: live.dockerfile,
    port: live.port,
    initialSha: sha,
  });
  store.updateTask(taskId, { imageRef: buildOutcome.imageRef, commitSha: buildOutcome.sha });
  completePhase(io, taskId, builder);
  setPipelineStage(io, taskId, 'build', 'done');

  chatStatus(io, taskId, `🚀 Image \`${buildOutcome.imageRef.split('/').pop()}\` built. Rolling preview deployment…`);

  setPipelineStage(io, taskId, 'deploy', 'active');
  setTaskStatus(io, taskId, 'deploying');
  const deployer = spawnPhase(io, taskId, 'deployer', 'Deployer Liliputian');
  if (!deployer) throw new Error('Failed to register deployer agent');

  const deployOutcome = await deployWithFixer({
    io,
    taskId,
    deployerAgentId: deployer,
    agentSession: live.agentSession,
    handle: live.repoHandle,
    branch: live.branch,
    imageName: live.imageName,
    dockerfile: live.dockerfile,
    port: live.port,
    namespace: live.namespace,
    pathPrefix: live.pathPrefix,
    initialImageRef: buildOutcome.imageRef,
    initialSha: buildOutcome.sha,
  });
  store.updateTask(taskId, { imageRef: deployOutcome.imageRef, commitSha: deployOutcome.sha });
  completePhase(io, taskId, deployer);
  setPipelineStage(io, taskId, 'deploy', 'done');

  const devUrl = `${PUBLIC_BASE_URL}${live.pathPrefix}/`;
  // Persist devUrl/namespace early but keep status='deploying' until validate
  // confirms healthy (or exhausts).
  store.updateTask(taskId, { devUrl, devNamespace: live.namespace, devPort: live.port, devEnvState: 'active' });

  const liliputMsg = store.addChatMessage(
    taskId,
    'liliput',
    `🔁 Iteration applied — running validation against the new preview…\n\n• ${changed.length} file(s) changed (commit \`${sha.substring(0, 7)}\`)\n` +
      `• **Preview (validating):** ${devUrl}\n` +
      (task.pullRequestUrl ? `• **PR:** ${task.pullRequestUrl}\n` : '') +
      `\n${result.summary}`,
  );
  if (liliputMsg) io.to(`task:${taskId}`).emit('chat:message', liliputMsg);

  // Autonomous validate-and-heal loop after iteration. Same idea as the
  // initial pipeline — probe the live preview, ask ops-fixer to repair,
  // commit + rebuild + redeploy, repeat until healthy or the cap is hit.
  const iterValidateOutcome = await validateAndHealLoop({
    io,
    taskId,
    agentSession: live.agentSession,
    handle: live.repoHandle,
    imageName: live.imageName,
    dockerfile: live.dockerfile,
    port: live.port,
    namespace: live.namespace,
    pathPrefix: live.pathPrefix,
    devUrl,
    initialImageRef: deployOutcome.imageRef,
    initialSha: deployOutcome.sha,
  });

  const implementationNotes = appendImplementationNote(
    task.implementationNotes,
    result.summary,
  );
  const implementationChangedFiles = await collectImplementationFiles(
    taskId,
    live.repoHandle,
    task.baseCommitSha,
    mergeImplementationFiles(task.implementationChangedFiles, changed),
  );
  store.updateTask(taskId, {
    implementationNotes,
    implementationChangedFiles,
  });
  await refreshPullRequestDescription(taskId, task, {
    implementationNotes,
    changedFiles: implementationChangedFiles,
    commitSha: iterValidateOutcome.sha,
    previewUrl: devUrl,
    validationHealthy: iterValidateOutcome.healthy,
  });

  // Reviewer Agent: post-iteration review. Inspects the latest changes plus
  // the validation outcome, posts feedback to chat only if it spots something
  // important. Queued feedback is picked up by the next coder turn.
  setPipelineStage(io, taskId, 'review', 'active');
  try {
    await triggerPipelineReview(io, taskId, {
      workspaceRoot: live.repoHandle.cwd,
      sha: iterValidateOutcome.sha,
      kind: 'coder-iter',
      coderSummary: result.summary,
      devUrl,
      validationHealthy: iterValidateOutcome.healthy,
      validateAttemptsUsed: iterValidateOutcome.attemptsUsed,
    });
  } catch (err) {
    logger.warn({ taskId, err: err instanceof Error ? err.message : String(err) }, 'Iter reviewer threw (non-fatal)');
  }

  // Flip back to 'review' after validate (loop already posted the appropriate
  // healthy/exhausted chat message).
  setPipelineStage(io, taskId, 'review', 'done');
  setTaskStatus(io, taskId, 'review', { devUrl, devNamespace: live.namespace, devPort: live.port, devEnvState: 'active' });
}

/**
 * Direct rebuild path — used when the user issues a pure rebuild command
 * ("rebuild", "redeploy now", "go ahead and rebuild"). Skips the agent
 * turn entirely and runs commit + push + build + deploy + validate
 * against the current workspace state. Caller is expected to have already
 * written the .liliput-rebuild marker so the working tree is dirty.
 */
async function runRebuildOnly(
  io: SocketServer,
  taskId: string,
  live: LiveSession,
  message: string,
): Promise<void> {
  const task = store.getTask(taskId);
  if (!task) throw new Error('Task not found');

  setPipelineStage(io, taskId, 'build', 'active');
  const builder = spawnPhase(io, taskId, 'builder', 'Builder Liliputian');
  if (!builder) throw new Error('Failed to register builder agent');

  chatStatus(io, taskId, `📦 Committing rebuild marker & building image…`);
  logPhase(io, taskId, builder, 'info', 'Committing rebuild marker…');
  let commitFixer: string | undefined;
  const sha = await runGitOpWithFixer<string>({
    agentSession: live.agentSession,
    op: () =>
      git.commitAll(
        live.repoHandle,
        `iter(rebuild): ${truncate(message, 60)}\n\nDirect rebuild requested by user.\n\nLiliput rebuild on task ${taskId}.`,
      ),
    describe: 'git commit',
    cwd: live.repoHandle.cwd,
    branch: live.repoHandle.branch,
    repo: live.repo,
    recoveryCheck: async () => {
      if (await git.isWorkingTreeClean(live.repoHandle)) {
        const head = await git.headSha(live.repoHandle);
        return { recovered: true, result: head };
      }
      return { recovered: false };
    },
    onLog: (level, msg, cmd, out) =>
      logPhase(io, taskId, commitFixer ?? builder, level, msg, cmd, out),
    onFixerTurnStart: () => {
      commitFixer = spawnPhase(io, taskId, 'fixer', 'Fixer Liliputian (git-commit)');
    },
    onFixerTurnEnd: () => {
      if (commitFixer) {
        completePhase(io, taskId, commitFixer);
        commitFixer = undefined;
      }
    },
  });
  store.updateTask(taskId, { commitSha: sha });
  logPhase(io, taskId, builder, 'info', `Commit ${sha.substring(0, 7)} ready`);

  logPhase(io, taskId, builder, 'info', 'Pushing branch…', `git push origin ${live.branch}`);
  let pushFixer: string | undefined;
  await runGitOpWithFixer<void>({
    agentSession: live.agentSession,
    op: () => git.push(live.repoHandle),
    describe: `git push origin ${live.branch}`,
    cwd: live.repoHandle.cwd,
    branch: live.repoHandle.branch,
    repo: live.repo,
    recoveryCheck: async () => {
      if (await git.isBranchUpToDateWithRemote(live.repoHandle)) {
        return { recovered: true, result: undefined as void };
      }
      return { recovered: false };
    },
    onLog: (level, msg, cmd, out) =>
      logPhase(io, taskId, pushFixer ?? builder, level, msg, cmd, out),
    onFixerTurnStart: () => {
      pushFixer = spawnPhase(io, taskId, 'fixer', 'Fixer Liliputian (git-push)');
    },
    onFixerTurnEnd: () => {
      if (pushFixer) {
        completePhase(io, taskId, pushFixer);
        pushFixer = undefined;
      }
    },
  });
  logPhase(io, taskId, builder, 'info', 'Branch pushed.');

  if (!ACR_NAME) {
    failPhase(io, taskId, builder, 'ACR_NAME env var not set — cannot rebuild image.');
    throw new Error('ACR_NAME not configured');
  }

  const buildOutcome = await buildWithFixer({
    io,
    taskId,
    builderAgentId: builder,
    agentSession: live.agentSession,
    handle: live.repoHandle,
    branch: live.branch,
    imageName: live.imageName,
    dockerfile: live.dockerfile,
    port: live.port,
    initialSha: sha,
  });
  store.updateTask(taskId, { imageRef: buildOutcome.imageRef, commitSha: buildOutcome.sha });
  completePhase(io, taskId, builder);
  setPipelineStage(io, taskId, 'build', 'done');

  chatStatus(io, taskId, `🚀 Image \`${buildOutcome.imageRef.split('/').pop()}\` built. Rolling preview deployment…`);

  setPipelineStage(io, taskId, 'deploy', 'active');
  setTaskStatus(io, taskId, 'deploying');
  const deployer = spawnPhase(io, taskId, 'deployer', 'Deployer Liliputian');
  if (!deployer) throw new Error('Failed to register deployer agent');

  const deployOutcome = await deployWithFixer({
    io,
    taskId,
    deployerAgentId: deployer,
    agentSession: live.agentSession,
    handle: live.repoHandle,
    branch: live.branch,
    imageName: live.imageName,
    dockerfile: live.dockerfile,
    port: live.port,
    namespace: live.namespace,
    pathPrefix: live.pathPrefix,
    initialImageRef: buildOutcome.imageRef,
    initialSha: buildOutcome.sha,
  });
  store.updateTask(taskId, { imageRef: deployOutcome.imageRef, commitSha: deployOutcome.sha });
  completePhase(io, taskId, deployer);
  setPipelineStage(io, taskId, 'deploy', 'done');

  const devUrl = `${PUBLIC_BASE_URL}${live.pathPrefix}/`;
  store.updateTask(taskId, { devUrl, devNamespace: live.namespace, devPort: live.port, devEnvState: 'active' });

  const ackMsg = store.addChatMessage(
    taskId,
    'liliput',
    `🔨 Rebuild applied — validating the new preview…\n\n• Commit \`${sha.substring(0, 7)}\`\n` +
      `• **Preview (validating):** ${devUrl}\n` +
      (task.pullRequestUrl ? `• **PR:** ${task.pullRequestUrl}\n` : ''),
  );
  if (ackMsg) io.to(`task:${taskId}`).emit('chat:message', ackMsg);

  const rebuildValidateOutcome = await validateAndHealLoop({
    io,
    taskId,
    agentSession: live.agentSession,
    handle: live.repoHandle,
    imageName: live.imageName,
    dockerfile: live.dockerfile,
    port: live.port,
    namespace: live.namespace,
    pathPrefix: live.pathPrefix,
    devUrl,
    initialImageRef: deployOutcome.imageRef,
    initialSha: deployOutcome.sha,
  });

  const implementationNotes = appendImplementationNote(
    task.implementationNotes,
    'Rebuilt and redeployed the current implementation.',
  );
  const implementationChangedFiles = await collectImplementationFiles(
    taskId,
    live.repoHandle,
    task.baseCommitSha,
    task.implementationChangedFiles ?? [],
  );
  store.updateTask(taskId, {
    implementationNotes,
    implementationChangedFiles,
  });
  await refreshPullRequestDescription(taskId, task, {
    implementationNotes,
    changedFiles: implementationChangedFiles,
    commitSha: rebuildValidateOutcome.sha,
    previewUrl: devUrl,
    validationHealthy: rebuildValidateOutcome.healthy,
  });

  // Reviewer Agent: even pure-rebuild paths get a final review pass — the
  // app might still have issues that a rebuild surfaces (e.g. the previous
  // commit was already broken on `main`).
  try {
    await triggerPipelineReview(io, taskId, {
      workspaceRoot: live.repoHandle.cwd,
      sha: rebuildValidateOutcome.sha,
      kind: 'deploy',
      coderSummary: 'Pure rebuild (no agent turn).',
      devUrl,
      validationHealthy: rebuildValidateOutcome.healthy,
      validateAttemptsUsed: rebuildValidateOutcome.attemptsUsed,
    });
  } catch (err) {
    logger.warn({ taskId, err: err instanceof Error ? err.message : String(err) }, 'Rebuild reviewer threw (non-fatal)');
  }

  setTaskStatus(io, taskId, 'review', { devUrl, devNamespace: live.namespace, devPort: live.port, devEnvState: 'active' });
}

/** Returns true if a follow-up chat message would trigger an iteration. */
export function hasLiveSession(taskId: string): boolean {
  return liveSessions.has(taskId);
}

/**
 * Returns true if a chat message can trigger iteration on this task — either
 * because a live session is in memory, or because the task has enough persisted
 * metadata (repo + branch + reviewable status) for us to resurrect one.
 */
export function canIterate(taskId: string): boolean {
  if (liveSessions.has(taskId)) return true;
  const t = store.getTask(taskId);
  if (!t) return false;
  // Allow iteration on review/completed (normal follow-up) AND failed (recovery).
  // 'failed' tasks still have a real branch + workspace, so the user can chat
  // their way back to a green build instead of starting over from scratch.
  if (t.status !== 'review' && t.status !== 'completed' && t.status !== 'failed') return false;
  return Boolean(t.repository && t.branch);
}

/**
 * Resurrect a live session for a task whose in-memory session was lost
 * (typically due to a pod restart). Re-clones the persisted branch into a
 * fresh workspace, recreates the Copilot SDK session in that workspace, and
 * re-populates the `liveSessions` registry so iteration can proceed.
 *
 * The user sees the resurrection happen in the chat + activity log via the
 * 'researcher' phase agent (Resurrector Liliputian).
 */
async function resurrectLiveSession(
  io: SocketServer,
  taskId: string,
  task: Task,
): Promise<LiveSession> {
  if (!task.repository || !task.branch) {
    throw new Error('Task is missing repository or branch — nothing to resurrect.');
  }

  const ackMsg = store.addChatMessage(
    taskId,
    'liliput',
    `🪦→🧟 The previous agent session was lost (likely a pod restart). ` +
      `Resurrecting it from \`${task.repository}@${task.branch}\` — give me a moment…`,
  );
  if (ackMsg) io.to(`task:${taskId}`).emit('chat:message', ackMsg);

  const phaseAgent = spawnPhase(io, taskId, 'researcher', 'Resurrector Liliputian');
  if (!phaseAgent) throw new Error('Failed to register resurrector agent');

  try {
    const workdirName = `task-${taskId}`;
    let handle = await git.tryOpenExisting({
      repo: task.repository,
      ref: task.branch,
      workdirName,
      onLog: (m) => logPhase(io, taskId, phaseAgent, 'info', m),
    });
    if (handle) {
      logPhase(io, taskId, phaseAgent, 'info', `♻️  Reused existing workspace at ${handle.cwd}`);
      const reuseMsg = store.addChatMessage(
        taskId,
        'liliput',
        `♻️  Reusing existing workspace on disk — no full re-clone needed.`,
      );
      if (reuseMsg) io.to(`task:${taskId}`).emit('chat:message', reuseMsg);
    } else {
      logPhase(
        io,
        taskId,
        phaseAgent,
        'info',
        `Re-cloning ${task.repository}@${task.branch}…`,
        `git clone --branch ${task.branch} ${task.repository}`,
      );
      handle = await git.clone({
        repo: task.repository,
        ref: task.branch,
        workdirName,
        onLog: (m) => logPhase(io, taskId, phaseAgent, 'info', m),
      });
      logPhase(io, taskId, phaseAgent, 'info', `Cloned to ${handle.cwd}`);
    }

    logPhase(io, taskId, phaseAgent, 'info', 'Resolving Dockerfile…');
    const df = await resolveDockerfile(handle.cwd);
    logPhase(io, taskId, phaseAgent, 'info', df.notes);

    const [owner, name] = task.repository.split('/');
    if (!owner || !name) throw new Error(`Invalid repo slug: ${task.repository}`);
    const pathPrefix = pathPrefixFor(task.repository, task.branch);

    // Refresh the workspace contract — same content, but rewriting is
    // cheap and ensures the file exists if the workspace was reused.
    await writeContractIntoWorkspace(handle.cwd, { pathPrefix, port: df.port });

    const coderSdk = resolveAgentSdkParams(
      task,
      'coder',
      {
        ...(task.model ? { taskModel: task.model } : {}),
        ...(task.reasoningEffort ? { taskReasoningEffort: task.reasoningEffort } : {}),
      },
    );
    logPhase(io, taskId, phaseAgent, 'info', `Re-creating Copilot SDK session (model: ${coderSdk.model})…`);
    const agentSession = await createAgentSession(handle.cwd, coderSdk.model, coderSdk.reasoningEffort);

    const imageName = `liliput-app-${sanitiseK8sName(task.repository.replace('/', '-'))}`;
    const devPrefix = sanitiseK8sName(process.env.LILIPUT_DEV_PREFIX || 'dev');
    const namespace =
      task.devNamespace ??
      `${devPrefix}-${sanitiseK8sName(owner)}-${sanitiseK8sName(name)}-liliput-${taskId.substring(0, 8)}`;

    const live: LiveSession = {
      agentSession,
      repoHandle: handle,
      repo: task.repository,
      branch: task.branch,
      imageName,
      pathPrefix,
      namespace,
      dockerfile: df.dockerfile,
      port: df.port,
      freshlyResurrected: true,
    };
    liveSessions.set(taskId, live);

    logPhase(
      io,
      taskId,
      phaseAgent,
      'info',
      `✅ Session resurrected. Memory is empty (no prior turns) but workspace + branch + PR are intact. Recap from chat history will be replayed on the next turn.`,
    );
    completePhase(io, taskId, phaseAgent);

    const okMsg = store.addChatMessage(
      taskId,
      'liliput',
      `✅ Resurrected. SDK session recreated on branch \`${task.branch}\`. ` +
        `I'll seed the recap from our chat history into the next turn so I have your context.`,
    );
    if (okMsg) io.to(`task:${taskId}`).emit('chat:message', okMsg);

    return live;
  } catch (err) {
    failPhase(io, taskId, phaseAgent, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.substring(0, n) + '…';
}

function getToken(): string {
  const t =
    process.env['COPILOT_GITHUB_TOKEN'] ??
    process.env['GH_TOKEN'] ??
    process.env['GITHUB_TOKEN'];
  if (!t) throw new Error('No GitHub token');
  return t;
}

async function deleteRemoteBranch(repo: string, branch: string): Promise<void> {
  const url = `https://api.github.com/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok && res.status !== 404 && res.status !== 422) {
    const text = await res.text();
    throw new Error(`Branch delete failed (${res.status}): ${text}`);
  }
}

async function mergePullRequest(repo: string, prNumber: number): Promise<void> {
  const url = `https://api.github.com/repos/${repo}/pulls/${prNumber}/merge`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ merge_method: 'squash' }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PR merge failed (${res.status}): ${text}`);
  }
}

/**
 * Best-effort wrapper around \linkPrToFeature\ that resolves the linked
 * Feature + Issue from the Task.featureId. Silently no-ops when the Task
 * is not feature-linked (legacy or freeform tasks) or when PM emit is off.
 */
async function linkPrToFeatureForTask(
  task: { repository?: string; featureId?: string },
  prNumber: number,
  prUrl: string,
  isDraft: boolean,
): Promise<void> {
  if (process.env['LILIPUT_PM_EMIT_ENABLED'] !== '1') return;
  if (!task.repository || !task.featureId) return;
  try {
    const feature = featureStore.getFeature(task.featureId);
    if (!feature) return;
    await linkPrToFeature({
      repo: task.repository,
      featureId: feature.id,
      prNumber,
      prUrl,
      isDraft,
      ...(feature.githubIssueNumber !== undefined
        ? { issueNumber: feature.githubIssueNumber }
        : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Logging only -- this hook must NEVER crash the Dev pipeline.
    // The reconciler will repair any missed state on its next pass.
    logger.warn(
      { repository: task.repository, featureId: task.featureId, err: msg },
      'linkPrToFeatureForTask failed (ignored)',
    );
  }
}
