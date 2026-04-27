import { v4 as uuid } from 'uuid';
import type { Task, Agent, AgentRole, ChatMessage, ChatRole } from '../../../shared/types/index.js';

const tasks = new Map<string, Task>();

function now(): string {
  return new Date().toISOString();
}

// ─── Tasks ───────────────────────────────────────────────────

export function createTask(
  title: string,
  description: string,
  repository?: string,
  options: { baseBranch?: string; commitMode?: import('../../../shared/types/index.js').CommitMode } = {},
): Task {
  const task: Task = {
    id: uuid(),
    title,
    description,
    status: 'clarifying',
    repository,
    baseBranch: options.baseBranch ?? 'main',
    commitMode: options.commitMode ?? 'pr',
    agents: [],
    chatHistory: [],
    createdAt: now(),
    updatedAt: now(),
  };
  tasks.set(task.id, task);
  return task;
}

export function getTask(id: string): Task | undefined {
  return tasks.get(id);
}

export function getTasks(): Task[] {
  return Array.from(tasks.values());
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      Task,
      | 'status'
      | 'spec'
      | 'repository'
      | 'baseBranch'
      | 'branch'
      | 'commitMode'
      | 'pullRequestUrl'
      | 'commitSha'
      | 'imageRef'
      | 'devNamespace'
      | 'devUrl'
      | 'errorMessage'
    >
  >,
): Task | undefined {
  const task = tasks.get(id);
  if (!task) return undefined;
  Object.assign(task, updates, { updatedAt: now() });
  return task;
}

export function deleteTask(id: string): boolean {
  return tasks.delete(id);
}

// ─── Agents ──────────────────────────────────────────────────

export function addAgent(taskId: string, name: string, role: AgentRole): Agent | undefined {
  const task = tasks.get(taskId);
  if (!task) return undefined;

  const agent: Agent = {
    id: uuid(),
    taskId,
    name,
    role,
    status: 'idle',
    logs: [],
    progress: 0,
    createdAt: now(),
    updatedAt: now(),
  };
  task.agents.push(agent);
  task.updatedAt = now();
  return agent;
}

export function updateAgent(
  taskId: string,
  agentId: string,
  updates: Partial<Pick<Agent, 'status' | 'currentAction' | 'progress'>>,
): Agent | undefined {
  const task = tasks.get(taskId);
  if (!task) return undefined;

  const agent = task.agents.find((a: Agent) => a.id === agentId);
  if (!agent) return undefined;

  Object.assign(agent, updates, { updatedAt: now() });
  task.updatedAt = now();
  return agent;
}

export function getAgent(taskId: string, agentId: string): Agent | undefined {
  const task = tasks.get(taskId);
  if (!task) return undefined;
  return task.agents.find((a: Agent) => a.id === agentId);
}

export function addAgentLog(
  taskId: string,
  agentId: string,
  level: 'info' | 'warn' | 'error' | 'debug',
  message: string,
  command?: string,
  output?: string,
): void {
  const agent = getAgent(taskId, agentId);
  if (!agent) return;
  agent.logs.push({ timestamp: now(), level, message, command, output });
}

// ─── Chat ────────────────────────────────────────────────────

export function addChatMessage(
  taskId: string,
  role: ChatRole,
  content: string,
  agentId?: string,
  agentName?: string,
): ChatMessage | undefined {
  const task = tasks.get(taskId);
  if (!task) return undefined;

  const msg: ChatMessage = {
    id: uuid(),
    taskId,
    role,
    agentId,
    agentName,
    content,
    timestamp: now(),
  };
  task.chatHistory.push(msg);
  task.updatedAt = now();
  return msg;
}

export function getChatHistory(taskId: string): ChatMessage[] {
  const task = tasks.get(taskId);
  return task?.chatHistory ?? [];
}

// ─── Reset (for testing) ────────────────────────────────────

export function resetStore(): void {
  tasks.clear();
}
