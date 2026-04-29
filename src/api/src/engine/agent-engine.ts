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
import type { AgentRole, Task } from '../../../shared/types/index.js';
import * as store from '../stores/task-store.js';
import { logger } from '../logger.js';
import * as git from './git-client.js';
import {
  createAgentSession,
  runAgentTurn,
  disposeAgentSession,
  abortAgentTurn,
  type AgentSession,
} from './agent-loop.js';
import { resolveDockerfile } from './dockerfile-detector.js';
import { acrBuild } from './azure-builder.js';
import { runOpsFixer } from './ops-fixer.js';
import { runGitOpWithFixer } from './git-fixer.js';
import {
  ensureNamespace,
  deployApp,
  waitDeploymentReady,
  devEnvName,
  sanitiseK8sName,
  deleteNamespace,
} from './k8s-deployer.js';
import { syncRoutes, type DevRoute } from './nginx-patcher.js';
import { openPullRequest, markPullRequestReady, closePullRequest } from './github-pr.js';

const ACR_NAME = process.env['ACR_NAME'] ?? '';
const PUBLIC_BASE_URL = process.env['LILIPUT_PUBLIC_URL'] ?? 'http://4.165.50.135';
const DEFAULT_REPO = process.env['LILIPUT_DEFAULT_TARGET_REPO'];
/** How many times to invoke the ops-fixer agent for build/deploy failures. */
const MAX_BUILD_FIX_ATTEMPTS = parseInt(process.env['MAX_BUILD_FIX_ATTEMPTS'] ?? '2', 10);
const MAX_DEPLOY_FIX_ATTEMPTS = parseInt(process.env['MAX_DEPLOY_FIX_ATTEMPTS'] ?? '2', 10);

interface DevEnvRecord {
  taskId: string;
  pathPrefix: string;
  upstreamHost: string;
  upstreamPort: number;
  namespace: string;
}
const devEnvs = new Map<string, DevEnvRecord>();

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
}
const liveSessions = new Map<string, LiveSession>();

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
      const result = await runAgentTurn(inFlight.agentSession, {
        taskTitle: inFlight.taskTitle,
        taskDescription: inFlight.taskDescription,
        spec: inFlight.spec,
        followUp,
        isInitial: false,
        onLog: (level, m, cmd, out) => logPhase(io, taskId, agentId, level, m, cmd, out),
        onToolEvent: (event) => {
          io.to(`task:${taskId}`).emit('agent:tool-event', {
            taskId,
            agentId,
            ...event,
          });
        },
      });
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
  store.updateAgent(taskId, agent.id, { status: 'working' });
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
    // Skip output to keep DB rows small; full output stays in agent_logs.
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
 * Run `acrBuild` with fixer-driven recovery. On failure: spawn fixer,
 * commit/push any edits, retry. Returns the image ref of the successful build.
 */
async function buildWithFixer(ctx: BuildContext): Promise<BuildOutcome> {
  let sha = ctx.initialSha;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_BUILD_FIX_ATTEMPTS + 1; attempt++) {
    const tag = sha.substring(0, 12);
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
          onToolEvent: (event) =>
            ctx.io.to(`task:${ctx.taskId}`).emit('agent:tool-event', { taskId: ctx.taskId, agentId: fixer, ...event }),
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
          onToolEvent: (event) =>
            ctx.io.to(`task:${ctx.taskId}`).emit('agent:tool-event', { taskId: ctx.taskId, agentId: fixer, ...event }),
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

export function startBuild(io: SocketServer, taskId: string): void {
  void (async () => {
    try {
      await runFullPipeline(io, taskId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ taskId, err: message }, 'Agent pipeline failed');
      setTaskStatus(io, taskId, 'failed', { errorMessage: message });
      const sysMsg = store.addChatMessage(taskId, 'system', `❌ Agent pipeline failed: ${message}`);
      if (sysMsg) io.to(`task:${taskId}`).emit('chat:message', sysMsg);
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

  // Architect
  const architect = spawnPhase(io, taskId, 'architect', 'Architect Liliputian');
  if (architect) {
    logPhase(io, taskId, architect, 'info', `Target repo: ${repo}@${baseBranch}`);
    logPhase(io, taskId, architect, 'info', `Working branch: ${branch}`);
    logPhase(io, taskId, architect, 'info', `Commit mode: ${task.commitMode ?? 'pr'}`);
    completePhase(io, taskId, architect);
  }

  // Coder
  const coder = spawnPhase(io, taskId, 'coder', 'Coder Liliputian');
  if (!coder) throw new Error('Failed to register coder agent');

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

  logPhase(io, taskId, coder, 'info', 'Spawning Copilot SDK session…');
  const agentSession = await createAgentSession(handle.cwd);
  registerInFlightAgent(taskId, {
    agentSession,
    pendingChatMessages: [],
    taskTitle: task.title,
    taskDescription: task.description,
    spec: task.spec,
  });
  logPhase(io, taskId, coder, 'info', 'Invoking LLM agent loop…');
  const result = await runAgentTurn(agentSession, {
    taskTitle: task.title,
    taskDescription: task.description,
    spec: task.spec,
    isInitial: true,
    onLog: (level, msg, cmd, out) => logPhase(io, taskId, coder, level, msg, cmd, out),
    onToolEvent: (event) => {
      io.to(`task:${taskId}`).emit('agent:tool-event', {
        taskId,
        agentId: coder,
        ...event,
      });
    },
  });
  await drainPendingChatMessages(io, taskId, coder);

  const changedFiles = await git.changedFiles(handle);
  logPhase(
    io,
    taskId,
    coder,
    'info',
    `Agent made ${result.toolCallCount} tool calls — ${changedFiles.length} file(s) changed`,
    undefined,
    (result.summary ?? '') +
      (changedFiles.length ? `\n\nChanged files:\n${changedFiles.join('\n')}` : ''),
  );

  if (changedFiles.length === 0) {
    failPhase(io, taskId, coder, 'Agent produced no file changes — nothing to build.');
    clearInFlightAgent(taskId);
    await disposeAgentSession(agentSession);
    throw new Error('Agent produced no file changes');
  }

  // Builder
  const builder = spawnPhase(io, taskId, 'builder', 'Builder Liliputian');
  if (!builder) throw new Error('Failed to register builder agent');

  logPhase(io, taskId, builder, 'info', 'Resolving Dockerfile…');
  const df = await resolveDockerfile(handle.cwd);
  logPhase(io, taskId, builder, 'info', df.notes);

  logPhase(io, taskId, builder, 'info', 'Committing changes…', 'git add -A && git commit');
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
    op: () => git.push(handle),
    describe: `git push --set-upstream origin ${branch}`,
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

  // Deployer
  setTaskStatus(io, taskId, 'deploying');
  const deployer = spawnPhase(io, taskId, 'deployer', 'Deployer Liliputian');
  if (!deployer) throw new Error('Failed to register deployer agent');

  const namespace = devEnvName(repo, branch);
  const appName = 'app';
  const [owner = 'unknown', name = 'repo'] = repo.split('/');
  const safeBranch = sanitiseK8sName(branch);
  const pathPrefix = `/dev/${sanitiseK8sName(owner)}/${sanitiseK8sName(name)}/${safeBranch}`;

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

  const devUrl = `${PUBLIC_BASE_URL}${pathPrefix}/`;
  logPhase(io, taskId, deployer, 'info', `Dev environment live at ${devUrl}`);
  completePhase(io, taskId, deployer);

  // Auto-open a draft PR right after deploy so the user can see it from the UI
  // during review. Ship marks it ready (or merges in direct mode); Discard closes it.
  const reviewer = spawnPhase(io, taskId, 'reviewer', 'Reviewer Liliputian');
  let prUrl: string | undefined;
  let prNumber: number | undefined;
  if (reviewer && task.repository && task.branch) {
    const baseBranch = task.baseBranch ?? 'main';
    try {
      logPhase(io, taskId, reviewer, 'info', `Opening draft pull request to ${baseBranch}…`);
      const pr = await openPullRequest({
        repo: task.repository,
        title: `[liliput] ${task.title}`,
        body:
          `Generated by the Liliput agent.\n\n` +
          `**Task:** ${task.title}\n\n${task.description}\n\n` +
          (task.spec ? `---\n\n## Spec\n\n${task.spec}\n` : '') +
          `\n\n_Dev preview: ${devUrl}_`,
        head: task.branch,
        base: baseBranch,
        draft: true,
      });
      prUrl = pr.htmlUrl;
      prNumber = pr.number;
      logPhase(io, taskId, reviewer, 'info', `Draft PR opened: ${pr.htmlUrl}`);
      completePhase(io, taskId, reviewer);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      logPhase(io, taskId, reviewer, 'warn', `Could not open draft PR: ${m}`);
      // Don't fail the whole pipeline — user can still ship to retry.
      completePhase(io, taskId, reviewer);
    }
  }

  setTaskStatus(io, taskId, 'review', {
    devNamespace: namespace,
    devUrl,
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
    `✨ Build complete!\n\n• **Preview:** ${devUrl}\n` +
      (prUrl ? `• **Draft PR:** ${prUrl}\n` : '') +
      `\n💬 Keep chatting to iterate — every message will run another turn ` +
      `(same workspace, same branch, same PR). Or click **Ship** to ${
        task.commitMode === 'direct' ? 'merge' : 'mark the PR ready for review'
      }, or **Discard** to close it.`,
  );
  if (liliputMsg) io.to(`task:${taskId}`).emit('chat:message', liliputMsg);
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
        body:
          `Generated by the Liliput agent.\n\n` +
          `**Task:** ${task.title}\n\n${task.description}\n\n` +
          (task.spec ? `---\n\n## Spec\n\n${task.spec}\n` : '') +
          `\n\n_Dev preview was deployed to ${task.devUrl ?? '(unknown)'}_`,
        head: task.branch,
        base: baseBranch,
        draft: false,
      });
      prUrl = pr.htmlUrl;
      prNumber = pr.number;
      logPhase(io, taskId, reviewer, 'info', `Pull request opened: ${pr.htmlUrl}`);
    } else {
      // PR already exists as a draft — mark it ready for review.
      logPhase(io, taskId, reviewer, 'info', `Marking PR #${prNumber} ready for review…`);
      try {
        await markPullRequestReady(task.repository, prNumber);
        logPhase(io, taskId, reviewer, 'info', `PR ready for review: ${prUrl}`);
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

  // Close the draft PR if one exists.
  if (task.repository && task.pullRequestNumber !== undefined) {
    try {
      if (cleaner)
        logPhase(io, taskId, cleaner, 'info', `Closing PR #${task.pullRequestNumber}…`);
      await closePullRequest(task.repository, task.pullRequestNumber);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (cleaner) logPhase(io, taskId, cleaner, 'warn', `PR close failed: ${message}`);
    }
  }

  if (task.devNamespace) {
    try {
      if (cleaner) logPhase(io, taskId, cleaner, 'info', `Deleting namespace ${task.devNamespace}…`);
      await deleteNamespace(task.devNamespace);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (cleaner) logPhase(io, taskId, cleaner, 'warn', `Namespace delete failed: ${message}`);
    }
  }

  devEnvs.delete(taskId);
  try {
    await syncRoutes(activeRoutes());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (cleaner) logPhase(io, taskId, cleaner, 'warn', `Gateway sync failed: ${message}`);
  }

  if (task.repository && task.branch) {
    try {
      if (cleaner) logPhase(io, taskId, cleaner, 'info', `Deleting remote branch ${task.branch}…`);
      await deleteRemoteBranch(task.repository, task.branch);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (cleaner) logPhase(io, taskId, cleaner, 'warn', `Branch delete failed: ${message}`);
    }
  }

  if (cleaner) completePhase(io, taskId, cleaner);
  setTaskStatus(io, taskId, 'discarded', { devUrl: undefined });
  await tearDownLiveSession(taskId);
  return store.getTask(taskId)!;
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
    try {
      await runIteration(io, taskId, message);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      logger.error({ taskId, err: m }, 'Iteration failed');
      setTaskStatus(io, taskId, 'failed', { errorMessage: m });
      const sysMsg = store.addChatMessage(taskId, 'system', `❌ Iteration failed: ${m}`);
      if (sysMsg) io.to(`task:${taskId}`).emit('chat:message', sysMsg);
    } finally {
      clearInFlightAgent(taskId);
    }
  })();
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

  chatStatus(io, taskId, `🛠️  Coder Liliputian is reading your message and editing files — this can take a few minutes…`);
  logPhase(io, taskId, coder, 'info', `Iteration: ${message.substring(0, 200)}`);
  const result = await runAgentTurn(live.agentSession, {
    taskTitle: task.title,
    taskDescription: task.description,
    spec: task.spec,
    followUp: message,
    isInitial: false,
    onLog: (level, msg, cmd, out) => logPhase(io, taskId, coder, level, msg, cmd, out),
    onToolEvent: (event) => {
      io.to(`task:${taskId}`).emit('agent:tool-event', {
        taskId,
        agentId: coder,
        ...event,
      });
    },
  });
  await drainPendingChatMessages(io, taskId, coder);

  const changed = await git.changedFiles(live.repoHandle);
  logPhase(
    io,
    taskId,
    coder,
    'info',
    `Iteration: ${result.toolCallCount} tool calls, ${changed.length} file(s) changed`,
    undefined,
    result.summary,
  );
  if (changed.length === 0) {
    logPhase(io, taskId, coder, 'info', 'No file changes this turn — staying on previous commit.');
    completePhase(io, taskId, coder);
    setTaskStatus(io, taskId, 'review');
    const sysMsg = store.addChatMessage(
      taskId,
      'liliput',
      `Done — but the agent didn't change any files this turn. Summary:\n${result.summary}`,
    );
    if (sysMsg) io.to(`task:${taskId}`).emit('chat:message', sysMsg);
    return;
  }

  // Commit + push delta.
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
  completePhase(io, taskId, coder);
  completePhase(io, taskId, builder);

  chatStatus(io, taskId, `🚀 Image \`${buildOutcome.imageRef.split('/').pop()}\` built. Rolling preview deployment…`);

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

  const devUrl = `${PUBLIC_BASE_URL}${live.pathPrefix}/`;
  setTaskStatus(io, taskId, 'review', { devUrl });

  const liliputMsg = store.addChatMessage(
    taskId,
    'liliput',
    `🔁 Iteration applied!\n\n• ${changed.length} file(s) changed (commit \`${sha.substring(0, 7)}\`)\n` +
      `• **Preview:** ${devUrl}\n` +
      (task.pullRequestUrl ? `• **PR:** ${task.pullRequestUrl}\n` : '') +
      `\n${result.summary}\n\n💬 Keep chatting to keep iterating, or **Ship** / **Discard** when ready.`,
  );
  if (liliputMsg) io.to(`task:${taskId}`).emit('chat:message', liliputMsg);
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

    logPhase(io, taskId, phaseAgent, 'info', 'Re-creating Copilot SDK session…');
    const agentSession = await createAgentSession(handle.cwd);

    const [owner, name] = task.repository.split('/');
    if (!owner || !name) throw new Error(`Invalid repo slug: ${task.repository}`);
    const safeBranch = sanitiseK8sName(task.branch);
    const pathPrefix = `/dev/${sanitiseK8sName(owner)}/${sanitiseK8sName(name)}/${safeBranch}`;
    const imageName = `liliput-app-${sanitiseK8sName(task.repository.replace('/', '-'))}`;
    const namespace =
      task.devNamespace ??
      `dev-${sanitiseK8sName(owner)}-${sanitiseK8sName(name)}-liliput-${taskId.substring(0, 8)}`;

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
    };
    liveSessions.set(taskId, live);

    logPhase(
      io,
      taskId,
      phaseAgent,
      'info',
      `✅ Session resurrected. Memory is empty (no prior turns) but workspace + branch + PR are intact.`,
    );
    completePhase(io, taskId, phaseAgent);

    const okMsg = store.addChatMessage(
      taskId,
      'liliput',
      `✅ Resurrected. SDK session recreated on branch \`${task.branch}\`. ` +
        `Note: I don't remember our previous conversation, so feel free to recap. Now applying your message…`,
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
