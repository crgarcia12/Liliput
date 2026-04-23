import type { Server as SocketServer } from 'socket.io';
import type { AgentRole } from '../../../shared/types/index.js';
import * as store from '../stores/task-store.js';
import { logger } from '../logger.js';

// Simulated log messages per agent role
const ROLE_PHASES: Record<AgentRole, { action: string; logs: { message: string; command?: string; output?: string }[] }[]> = {
  architect: [
    {
      action: 'Analyzing requirements',
      logs: [
        { message: 'Parsing task description…' },
        { message: 'Identifying components and dependencies…' },
      ],
    },
    {
      action: 'Creating work breakdown',
      logs: [
        { message: 'Breaking task into subtasks…' },
        { message: 'Assigning priorities and dependencies…' },
        { message: 'Work plan ready — delegating to agents' },
      ],
    },
  ],
  coder: [
    {
      action: 'Setting up branch',
      logs: [
        { message: 'Creating feature branch', command: 'git checkout -b feature/task', output: "Switched to a new branch 'feature/task'" },
      ],
    },
    {
      action: 'Writing code',
      logs: [
        { message: 'Implementing core logic…' },
        { message: 'Adding type definitions…' },
        { message: 'Writing helper functions…' },
      ],
    },
    {
      action: 'Committing changes',
      logs: [
        { message: 'Staging files', command: 'git add -A', output: '' },
        { message: 'Committing', command: 'git commit -m "feat: implement feature"', output: '[feature/task abc1234] feat: implement feature\n 3 files changed, 120 insertions(+)' },
      ],
    },
  ],
  reviewer: [
    {
      action: 'Reviewing pull request',
      logs: [
        { message: 'Checking code style and conventions…' },
        { message: 'Verifying test coverage…' },
        { message: 'Review complete — approved ✓' },
      ],
    },
  ],
  builder: [
    {
      action: 'Installing dependencies',
      logs: [
        { message: 'Running install', command: 'npm ci', output: 'added 347 packages in 8.2s' },
      ],
    },
    {
      action: 'Building project',
      logs: [
        { message: 'Compiling TypeScript', command: 'npm run build', output: 'Build completed successfully' },
      ],
    },
    {
      action: 'Running lint',
      logs: [
        { message: 'Linting source', command: 'npm run lint', output: 'No issues found' },
      ],
    },
  ],
  tester: [
    {
      action: 'Running unit tests',
      logs: [
        { message: 'Executing test suite', command: 'npm test', output: 'Tests: 24 passed, 0 failed\nTime: 3.2s' },
      ],
    },
    {
      action: 'Running integration tests',
      logs: [
        { message: 'Executing integration suite', command: 'npm run test:integration', output: 'Tests: 8 passed, 0 failed\nTime: 6.1s' },
      ],
    },
  ],
  deployer: [
    {
      action: 'Preparing deployment',
      logs: [
        { message: 'Building container image', command: 'docker build -t app:latest .', output: 'Successfully built image app:latest' },
      ],
    },
    {
      action: 'Deploying to environment',
      logs: [
        { message: 'Pushing image to registry…' },
        { message: 'Updating deployment manifest…' },
        { message: 'Rolling out update', command: 'kubectl rollout status', output: 'deployment "app" successfully rolled out' },
      ],
    },
  ],
  researcher: [
    {
      action: 'Researching documentation',
      logs: [
        { message: 'Searching for relevant patterns…' },
        { message: 'Reviewing best practices…' },
        { message: 'Research summary compiled' },
      ],
    },
  ],
};

// Agents to spawn after architect finishes
const FOLLOW_UP_AGENTS: { role: AgentRole; name: string }[] = [
  { role: 'coder', name: 'Coder Liliputian' },
  { role: 'builder', name: 'Builder Liliputian' },
  { role: 'tester', name: 'Tester Liliputian' },
  { role: 'deployer', name: 'Deployer Liliputian' },
];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(): number {
  return 2000 + Math.random() * 3000; // 2-5 seconds
}

async function runAgentSimulation(
  io: SocketServer,
  taskId: string,
  agentId: string,
  role: AgentRole,
): Promise<void> {
  const phases = ROLE_PHASES[role];
  const totalSteps = phases.reduce((n, p) => n + p.logs.length, 0);
  let step = 0;

  // Mark working
  store.updateAgent(taskId, agentId, { status: 'working' });
  io.to(`task:${taskId}`).emit('agent:status', { taskId, agentId, status: 'working' });

  for (const phase of phases) {
    store.updateAgent(taskId, agentId, { currentAction: phase.action });
    io.to(`task:${taskId}`).emit('agent:status', { taskId, agentId, status: 'working', currentAction: phase.action });

    for (const log of phase.logs) {
      await delay(randomDelay());
      step++;
      const progress = Math.round((step / totalSteps) * 100);

      store.addAgentLog(taskId, agentId, 'info', log.message, log.command, log.output);
      store.updateAgent(taskId, agentId, { progress });

      io.to(`task:${taskId}`).emit('agent:log', { taskId, agentId, ...log, timestamp: new Date().toISOString() });
      io.to(`task:${taskId}`).emit('agent:progress', { taskId, agentId, progress });
    }
  }

  // Complete
  store.updateAgent(taskId, agentId, { status: 'completed', progress: 100, currentAction: undefined });
  io.to(`task:${taskId}`).emit('agent:completed', { taskId, agentId });
}

/**
 * Spawn a single agent for a task.
 */
export function spawnAgent(
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

  logger.info({ taskId, agentId: agent.id, role }, 'Agent spawned');

  // Start simulation in background (fire-and-forget)
  runAgentSimulation(io, taskId, agent.id, role).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ taskId, agentId: agent.id, err: message }, 'Agent simulation failed');
    store.updateAgent(taskId, agent.id, { status: 'failed' });
    io.to(`task:${taskId}`).emit('agent:failed', { taskId, agentId: agent.id, error: message });
  });

  return agent.id;
}

/**
 * Spawn the architect agent, which then triggers follow-up agents.
 */
export function startBuild(io: SocketServer, taskId: string): void {
  const architectAgent = store.addAgent(taskId, 'Architect Liliputian', 'architect');
  if (!architectAgent) return;

  io.to(`task:${taskId}`).emit('agent:spawned', {
    taskId,
    agentId: architectAgent.id,
    name: architectAgent.name,
    role: 'architect',
    timestamp: new Date().toISOString(),
  });

  logger.info({ taskId }, 'Build started — architect agent spawned');

  // Run architect, then spawn follow-up agents
  runAgentSimulation(io, taskId, architectAgent.id, 'architect')
    .then(async () => {
      for (const { role, name } of FOLLOW_UP_AGENTS) {
        // Small stagger between spawns
        await delay(500);
        spawnAgent(io, taskId, role, name);
      }

      // Monitor for all agents complete
      monitorCompletion(io, taskId);
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ taskId, err: message }, 'Architect simulation failed');
      store.updateAgent(taskId, architectAgent.id, { status: 'failed' });
      store.updateTask(taskId, { status: 'failed' });
      io.to(`task:${taskId}`).emit('agent:failed', { taskId, agentId: architectAgent.id, error: message });
      io.to(`task:${taskId}`).emit('task:status', { taskId, status: 'failed' });
    });
}

function monitorCompletion(io: SocketServer, taskId: string): void {
  const check = (): void => {
    const task = store.getTask(taskId);
    if (!task) return;

    const allDone = task.agents.every((a: { status: string }) => a.status === 'completed' || a.status === 'failed');
    if (!allDone) {
      setTimeout(check, 2000);
      return;
    }

    const anyFailed = task.agents.some((a: { status: string }) => a.status === 'failed');
    const finalStatus = anyFailed ? 'failed' : 'completed';
    store.updateTask(taskId, { status: finalStatus });
    io.to(`task:${taskId}`).emit('task:status', { taskId, status: finalStatus });
    logger.info({ taskId, status: finalStatus }, 'Task finished');
  };

  setTimeout(check, 3000);
}
