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
import { runAgent } from './agent-loop.js';
import { resolveDockerfile } from './dockerfile-detector.js';
import { acrBuild } from './azure-builder.js';
import {
  ensureNamespace,
  deployApp,
  waitDeploymentReady,
  devEnvName,
  sanitiseK8sName,
  deleteNamespace,
} from './k8s-deployer.js';
import { syncRoutes, type DevRoute } from './nginx-patcher.js';
import { openPullRequest } from './github-pr.js';

const ACR_NAME = process.env['ACR_NAME'] ?? '';
const PUBLIC_BASE_URL = process.env['LILIPUT_PUBLIC_URL'] ?? 'http://4.165.50.135';
const DEFAULT_REPO = process.env['LILIPUT_DEFAULT_TARGET_REPO'];

interface DevEnvRecord {
  taskId: string;
  pathPrefix: string;
  upstreamHost: string;
  upstreamPort: number;
  namespace: string;
}
const devEnvs = new Map<string, DevEnvRecord>();

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
  io.to(`task:${taskId}`).emit('agent:spawned', {
    taskId,
    agentId: agent.id,
    name,
    role,
    timestamp: new Date().toISOString(),
  });
  store.updateAgent(taskId, agent.id, { status: 'working' });
  io.to(`task:${taskId}`).emit('agent:status', {
    taskId,
    agentId: agent.id,
    status: 'working',
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
  store.addAgentLog(taskId, agentId, level, message, command, output);
  io.to(`task:${taskId}`).emit('agent:log', {
    taskId,
    agentId,
    message,
    command,
    output,
    timestamp: new Date().toISOString(),
  });
}

function completePhase(io: SocketServer, taskId: string, agentId: string): void {
  store.updateAgent(taskId, agentId, {
    status: 'completed',
    progress: 100,
    currentAction: undefined,
  });
  io.to(`task:${taskId}`).emit('agent:completed', { taskId, agentId });
}

function failPhase(
  io: SocketServer,
  taskId: string,
  agentId: string,
  error: string,
): void {
  store.updateAgent(taskId, agentId, { status: 'failed' });
  io.to(`task:${taskId}`).emit('agent:failed', { taskId, agentId, error });
}

function setTaskStatus(
  io: SocketServer,
  taskId: string,
  status: Task['status'],
  extra: Partial<Task> = {},
): void {
  store.updateTask(taskId, { status, ...extra });
  io.to(`task:${taskId}`).emit('task:status', { taskId, status, ...extra });
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
  const handle = await git.clone({ repo, ref: baseBranch, workdirName: `task-${taskId}` });
  logPhase(io, taskId, coder, 'info', `Cloned to ${handle.cwd}`);

  logPhase(io, taskId, coder, 'info', `Creating branch ${branch}`, `git checkout -b ${branch}`);
  await git.createBranch(handle, branch);

  logPhase(io, taskId, coder, 'info', 'Invoking LLM agent loop…');
  const result = await runAgent({
    workspaceRoot: handle.cwd,
    taskTitle: task.title,
    taskDescription: task.description,
    spec: task.spec,
    onLog: (level, msg) => logPhase(io, taskId, coder, level, msg),
  });
  logPhase(
    io,
    taskId,
    coder,
    'info',
    `LLM proposed ${result.plan.ops.length} ops — applied ${result.apply.changedFiles.length}`,
    undefined,
    (result.plan.summary ?? '') +
      (result.apply.changedFiles.length
        ? `\n\nChanged files:\n${result.apply.changedFiles.join('\n')}`
        : ''),
  );

  if (result.apply.changedFiles.length === 0) {
    failPhase(io, taskId, coder, 'No edits were applied — nothing to build.');
    throw new Error('Agent produced no file changes');
  }

  // Builder
  const builder = spawnPhase(io, taskId, 'builder', 'Builder Liliputian');
  if (!builder) throw new Error('Failed to register builder agent');

  logPhase(io, taskId, builder, 'info', 'Resolving Dockerfile…');
  const df = await resolveDockerfile(handle.cwd);
  logPhase(io, taskId, builder, 'info', df.notes);

  logPhase(io, taskId, builder, 'info', 'Committing changes…', 'git add -A && git commit');
  const sha = await git.commitAll(
    handle,
    `feat(agent): ${task.title}\n\n${result.plan.summary ?? ''}\n\nGenerated by Liliput agent for task ${taskId}.`,
  );
  store.updateTask(taskId, { commitSha: sha, branch });
  logPhase(io, taskId, builder, 'info', `Commit ${sha.substring(0, 7)} created`);

  logPhase(io, taskId, builder, 'info', 'Pushing branch…', `git push -u origin ${branch}`);
  await git.push(handle);
  logPhase(io, taskId, builder, 'info', `Branch pushed to ${repo}`);

  if (!ACR_NAME) {
    failPhase(io, taskId, builder, 'ACR_NAME env var not set — cannot build image.');
    throw new Error('ACR_NAME not configured');
  }

  const repoSlug = sanitiseK8sName(repo.replace('/', '-'));
  const imageName = `liliput-app-${repoSlug}`;
  const tag = sha.substring(0, 12);
  logPhase(io, taskId, builder, 'info', `Starting az acr build → ${imageName}:${tag}…`);
  const buildStart = Date.now();
  const buildResult = await acrBuild({
    cwd: handle.cwd,
    imageName,
    tag,
    dockerfile: df.dockerfile,
  });
  logPhase(
    io,
    taskId,
    builder,
    'info',
    `Image built in ${Math.round((Date.now() - buildStart) / 1000)}s`,
    undefined,
    buildResult.imageRef,
  );
  store.updateTask(taskId, { imageRef: buildResult.imageRef });
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

  logPhase(io, taskId, deployer, 'info', `Deploying ${buildResult.imageRef}…`);
  await deployApp({
    namespace,
    appName,
    image: buildResult.imageRef,
    port: df.port,
    env: { PORT: String(df.port) },
    pathPrefix,
  });

  logPhase(io, taskId, deployer, 'info', 'Waiting for pod to become ready…');
  const ready = await waitDeploymentReady(namespace, appName, 180_000);
  if (!ready) {
    failPhase(io, taskId, deployer, 'Deployment did not become ready within 3 minutes.');
    throw new Error('Deployment readiness timeout');
  }

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

  setTaskStatus(io, taskId, 'review', { devNamespace: namespace, devUrl });

  const liliputMsg = store.addChatMessage(
    taskId,
    'liliput',
    `✨ Build complete! Preview your changes at ${devUrl}\n\nWhen you're happy, click **Ship** to ${
      task.commitMode === 'direct' ? 'merge directly' : 'open a pull request'
    }, or **Discard** to tear it down.`,
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
    logPhase(io, taskId, reviewer, 'info', `Pull request opened: ${pr.htmlUrl}`);

    if ((task.commitMode ?? 'pr') === 'direct') {
      try {
        logPhase(io, taskId, reviewer, 'info', 'Direct mode — auto-merging PR…');
        await mergePullRequest(task.repository, pr.number);
        logPhase(io, taskId, reviewer, 'info', 'PR merged.');
      } catch (mergeErr) {
        const m = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
        logPhase(io, taskId, reviewer, 'warn', `Auto-merge failed (PR still open): ${m}`);
      }
    }

    completePhase(io, taskId, reviewer);
    setTaskStatus(io, taskId, 'completed', { pullRequestUrl: pr.htmlUrl });
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
  return store.getTask(taskId)!;
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
