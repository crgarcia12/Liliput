/**
 * SQLite-backed Task store.
 *
 * Hot fields (id, status, repository, timestamps) are materialised as columns
 * for filtering/sorting; the rest of each Task/Agent/ChatMessage is round-
 * tripped as JSON in a `data` column. This keeps schema migrations rare
 * while letting us index what matters.
 *
 * All operations are synchronous (better-sqlite3) — fits Express's request
 * handlers and matches the previous in-memory API exactly.
 */

import { v4 as uuid } from 'uuid';
import type {
  Task,
  Agent,
  AgentRole,
  AgentLogEntry,
  ChatMessage,
  ChatRole,
  CommitMode,
} from '../../../shared/types/index.js';
import { getDb } from './db.js';

function now(): string {
  return new Date().toISOString();
}

// ─── Row helpers ──────────────────────────────────────────────

interface TaskRow {
  id: string;
  repository: string | null;
  status: string;
  data: string;
  created_at: string;
  updated_at: string;
}

interface AgentRow {
  id: string;
  task_id: string;
  position: number;
  data: string;
}

interface AgentLogRow {
  agent_id: string;
  ts: string;
  level: string;
  message: string;
  command: string | null;
  output: string | null;
}

interface ChatRow {
  id: string;
  task_id: string;
  ts: string;
  data: string;
}

/** Hydrate an Agent including its logs. */
function hydrateAgent(row: AgentRow, logs: AgentLogEntry[]): Agent {
  const base = JSON.parse(row.data) as Omit<Agent, 'logs'>;
  return { ...base, logs };
}

/** Hydrate a Task including its agents (+logs) and chat history. */
function hydrateTask(row: TaskRow): Task {
  const db = getDb();
  const base = JSON.parse(row.data) as Omit<Task, 'agents' | 'chatHistory'>;

  const agentRows = db
    .prepare('SELECT * FROM agents WHERE task_id = ? ORDER BY position ASC')
    .all(row.id) as AgentRow[];

  const agents: Agent[] = [];
  if (agentRows.length > 0) {
    const logsByAgent = new Map<string, AgentLogEntry[]>();
    const logRows = db
      .prepare(
        `SELECT agent_id, ts, level, message, command, output
           FROM agent_logs
          WHERE agent_id IN (${agentRows.map(() => '?').join(',')})
          ORDER BY id ASC`,
      )
      .all(...agentRows.map((a) => a.id)) as AgentLogRow[];
    for (const lr of logRows) {
      const list = logsByAgent.get(lr.agent_id) ?? [];
      list.push({
        timestamp: lr.ts,
        level: lr.level as AgentLogEntry['level'],
        message: lr.message,
        ...(lr.command ? { command: lr.command } : {}),
        ...(lr.output ? { output: lr.output } : {}),
      });
      logsByAgent.set(lr.agent_id, list);
    }
    for (const ar of agentRows) {
      agents.push(hydrateAgent(ar, logsByAgent.get(ar.id) ?? []));
    }
  }

  const chatRows = db
    .prepare('SELECT * FROM chat_messages WHERE task_id = ? ORDER BY ts ASC, id ASC')
    .all(row.id) as ChatRow[];
  const chatHistory: ChatMessage[] = chatRows.map((r) => JSON.parse(r.data) as ChatMessage);

  return { ...base, agents, chatHistory } as Task;
}

// ─── Tasks ───────────────────────────────────────────────────

export function createTask(
  title: string,
  description: string,
  repository?: string,
  options: { baseBranch?: string; commitMode?: CommitMode } = {},
): Task {
  const ts = now();
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
    createdAt: ts,
    updatedAt: ts,
  };

  // Strip nested collections before persisting (they live in their own tables).
  const { agents: _a, chatHistory: _c, ...rest } = task;
  void _a;
  void _c;

  getDb()
    .prepare(
      `INSERT INTO tasks (id, repository, status, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(task.id, task.repository ?? null, task.status, JSON.stringify(rest), ts, ts);

  return task;
}

export function getTask(id: string): Task | undefined {
  const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
    | TaskRow
    | undefined;
  if (!row) return undefined;
  return hydrateTask(row);
}

export function getTasks(): Task[] {
  const rows = getDb()
    .prepare('SELECT * FROM tasks ORDER BY updated_at DESC')
    .all() as TaskRow[];
  return rows.map((r) => hydrateTask(r));
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
      | 'pullRequestNumber'
      | 'commitSha'
      | 'imageRef'
      | 'devNamespace'
      | 'devUrl'
      | 'errorMessage'
    >
  >,
): Task | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
    | TaskRow
    | undefined;
  if (!row) return undefined;

  const ts = now();
  const baseObj = JSON.parse(row.data) as Omit<Task, 'agents' | 'chatHistory'>;
  const merged = { ...baseObj, ...updates, updatedAt: ts };

  db.prepare(
    `UPDATE tasks
        SET repository = ?, status = ?, data = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    (merged.repository ?? null) as string | null,
    merged.status,
    JSON.stringify(merged),
    ts,
    id,
  );

  return hydrateTask({ ...row, repository: merged.repository ?? null, status: merged.status, data: JSON.stringify(merged), updated_at: ts });
}

export function deleteTask(id: string): boolean {
  // FK cascade removes agents, agent_logs, chat_messages.
  const result = getDb().prepare('DELETE FROM tasks WHERE id = ?').run(id);
  return result.changes > 0;
}

// ─── Agents ──────────────────────────────────────────────────

export function addAgent(taskId: string, name: string, role: AgentRole): Agent | undefined {
  const db = getDb();
  const taskRow = db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId) as
    | { id: string }
    | undefined;
  if (!taskRow) return undefined;

  const ts = now();
  const agent: Agent = {
    id: uuid(),
    taskId,
    name,
    role,
    status: 'idle',
    logs: [],
    progress: 0,
    createdAt: ts,
    updatedAt: ts,
  };

  const { logs: _logs, ...rest } = agent;
  void _logs;

  const positionRow = db
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM agents WHERE task_id = ?')
    .get(taskId) as { next: number };

  db.prepare(
    `INSERT INTO agents (id, task_id, position, data) VALUES (?, ?, ?, ?)`,
  ).run(agent.id, taskId, positionRow.next, JSON.stringify(rest));

  // Bump task's updated_at so the tree view re-sorts.
  db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(ts, taskId);

  return agent;
}

export function updateAgent(
  taskId: string,
  agentId: string,
  updates: Partial<Pick<Agent, 'status' | 'currentAction' | 'progress'>>,
): Agent | undefined {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM agents WHERE id = ? AND task_id = ?')
    .get(agentId, taskId) as AgentRow | undefined;
  if (!row) return undefined;

  const ts = now();
  const baseObj = JSON.parse(row.data) as Omit<Agent, 'logs'>;
  const merged = { ...baseObj, ...updates, updatedAt: ts };

  db.prepare('UPDATE agents SET data = ? WHERE id = ?').run(
    JSON.stringify(merged),
    agentId,
  );
  db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(ts, taskId);

  return getAgent(taskId, agentId);
}

export function getAgent(taskId: string, agentId: string): Agent | undefined {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM agents WHERE id = ? AND task_id = ?')
    .get(agentId, taskId) as AgentRow | undefined;
  if (!row) return undefined;

  const logRows = db
    .prepare(
      `SELECT ts, level, message, command, output
         FROM agent_logs
        WHERE agent_id = ?
        ORDER BY id ASC`,
    )
    .all(agentId) as Omit<AgentLogRow, 'agent_id'>[];

  const logs: AgentLogEntry[] = logRows.map((lr) => ({
    timestamp: lr.ts,
    level: lr.level as AgentLogEntry['level'],
    message: lr.message,
    ...(lr.command ? { command: lr.command } : {}),
    ...(lr.output ? { output: lr.output } : {}),
  }));

  return hydrateAgent(row, logs);
}

export function addAgentLog(
  taskId: string,
  agentId: string,
  level: 'info' | 'warn' | 'error' | 'debug',
  message: string,
  command?: string,
  output?: string,
): void {
  const db = getDb();
  const exists = db
    .prepare('SELECT 1 AS x FROM agents WHERE id = ? AND task_id = ?')
    .get(agentId, taskId) as { x: number } | undefined;
  if (!exists) return;

  db.prepare(
    `INSERT INTO agent_logs (agent_id, ts, level, message, command, output)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(agentId, now(), level, message, command ?? null, output ?? null);
}

// ─── Chat ────────────────────────────────────────────────────

export function addChatMessage(
  taskId: string,
  role: ChatRole,
  content: string,
  agentId?: string,
  agentName?: string,
): ChatMessage | undefined {
  const db = getDb();
  const exists = db.prepare('SELECT 1 AS x FROM tasks WHERE id = ?').get(taskId) as
    | { x: number }
    | undefined;
  if (!exists) return undefined;

  const ts = now();
  const msg: ChatMessage = {
    id: uuid(),
    taskId,
    role,
    ...(agentId ? { agentId } : {}),
    ...(agentName ? { agentName } : {}),
    content,
    timestamp: ts,
  };

  db.prepare(
    `INSERT INTO chat_messages (id, task_id, ts, data) VALUES (?, ?, ?, ?)`,
  ).run(msg.id, taskId, ts, JSON.stringify(msg));
  db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(ts, taskId);

  return msg;
}

export function getChatHistory(taskId: string): ChatMessage[] {
  const rows = getDb()
    .prepare('SELECT * FROM chat_messages WHERE task_id = ? ORDER BY ts ASC, id ASC')
    .all(taskId) as ChatRow[];
  return rows.map((r) => JSON.parse(r.data) as ChatMessage);
}

// ─── Reset (for testing) ────────────────────────────────────

export function resetStore(): void {
  // Lazy import to avoid creating a circular dep at module init.
  // db.ts doesn't import this file, but resetStore is called from setup.ts
  // before tests, and we want to ensure the DB is initialised.
  const db = getDb();
  db.exec(`
    DELETE FROM agent_logs;
    DELETE FROM agents;
    DELETE FROM chat_messages;
    DELETE FROM tasks;
  `);
}

// ─── Boot-time reconciliation ────────────────────────────────

/**
 * Sweep stale in-flight state left behind by a previous container.
 *
 * SQLite persists across pod restarts, but the in-memory engine does not —
 * so any agent stuck in `working` and any task stuck in an active phase
 * after we boot is, by definition, orphaned. Mark them `failed` so the UI
 * stops claiming work is happening when nothing is.
 *
 * Safe statuses are preserved:
 *   - tasks: `review` (awaiting user), `completed`, `discarded`, `failed`
 *   - agents: anything other than `working`
 */
export function reconcileOrphanedRuns(): {
  agentsReset: number;
  tasksFailed: number;
} {
  const db = getDb();
  const ts = now();
  const note = 'Container restarted while this was in flight; marked failed by boot-time reconciler.';

  let agentsReset = 0;
  let tasksFailed = 0;

  const txn = db.transaction(() => {
    // 1. Agents stuck in `working`
    const agentRows = db
      .prepare('SELECT id, task_id, data FROM agents')
      .all() as Pick<AgentRow, 'id' | 'task_id' | 'data'>[];

    const updateAgentStmt = db.prepare('UPDATE agents SET data = ? WHERE id = ?');
    const insertLogStmt = db.prepare(
      `INSERT INTO agent_logs (agent_id, ts, level, message, command, output)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    for (const row of agentRows) {
      const agent = JSON.parse(row.data) as Omit<Agent, 'logs'>;
      if (agent.status === 'working') {
        const updated = { ...agent, status: 'failed' as const, updatedAt: ts };
        updateAgentStmt.run(JSON.stringify(updated), row.id);
        insertLogStmt.run(row.id, ts, 'warn', note, null, null);
        agentsReset++;
      }
    }

    // 2. Tasks stuck in an active phase
    const ACTIVE_STATUSES = ['clarifying', 'specifying', 'building', 'deploying', 'shipping'];
    const taskRows = db
      .prepare(
        `SELECT id, data FROM tasks WHERE status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`,
      )
      .all(...ACTIVE_STATUSES) as { id: string; data: string }[];

    const updateTaskStmt = db.prepare(
      'UPDATE tasks SET status = ?, data = ?, updated_at = ? WHERE id = ?',
    );

    for (const row of taskRows) {
      const task = JSON.parse(row.data) as Task;
      const updated = { ...task, status: 'failed' as const, updatedAt: ts };
      updateTaskStmt.run('failed', JSON.stringify(updated), ts, row.id);
      tasksFailed++;
    }
  });

  txn();
  return { agentsReset, tasksFailed };
}
