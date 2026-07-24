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
  ActivityEntry,
} from '../../../shared/types/index.js';
import { getDb } from './db.js';
import * as wsStore from './workstream-store.js';
import * as turnStore from './turn-store.js';
import { captureFromText as captureToolWishes } from './tool-wish-store.js';
import { captureFromText as captureVerdict } from './verdict-store.js';
import { getPodId, LEASE_DURATION_MS } from '../engine/pod-identity.js';

function now(): string {
  return new Date().toISOString();
}

// ─── Row helpers ──────────────────────────────────────────────

interface TaskRow {
  id: string;
  repository: string | null;
  workstream_id: string | null;
  campaign_cycle_id: string | null;
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

interface ActivityRow {
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
  const base = JSON.parse(row.data) as Omit<Task, 'agents' | 'chatHistory' | 'activityHistory' | 'turns' | 'currentTurnId'>;
  // Column is source of truth for the FK in case the JSON blob predates it.
  if (row.workstream_id && !base.workstreamId) {
    base.workstreamId = row.workstream_id;
  } else if (!('workstreamId' in base)) {
    base.workstreamId = undefined;
  }
  if (row.campaign_cycle_id && !base.campaignCycleId) {
    base.campaignCycleId = row.campaign_cycle_id;
  }

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

  // Last 200 activity entries (oldest → newest). Capped to keep payload small.
  const activityRows = db
    .prepare(
      `SELECT * FROM (
         SELECT * FROM activity_entries WHERE task_id = ? ORDER BY ts DESC, id DESC LIMIT 200
       ) ORDER BY ts ASC, id ASC`,
    )
    .all(row.id) as ActivityRow[];
  const activityHistory: ActivityEntry[] = activityRows.map(
    (r) => JSON.parse(r.data) as ActivityEntry,
  );

  const turns = turnStore.listTurnsForTask(row.id);
  const currentTurn = turns.find((t) => t.status === 'open');

  return {
    ...base,
    agents,
    chatHistory,
    activityHistory,
    turns,
    ...(currentTurn ? { currentTurnId: currentTurn.id } : {}),
  } as Task;
}

// ─── Tasks ───────────────────────────────────────────────────

export function createTask(
  title: string,
  description: string,
  repository?: string,
  options: {
    baseBranch?: string;
    commitMode?: CommitMode;
    workstreamId?: string;
    campaignCycleId?: string;
    ownerUserId?: string;
    model?: string;
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
    reviewerModel?: string;
    reviewerReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
    reviewerEnabled?: boolean;
  } = {},
): Task {
  const ts = now();
  // The Reviewer Agent is enabled by default whenever a `reviewerModel` is
  // configured. The caller can force it on/off via `reviewerEnabled`.
  const reviewerEnabled =
    options.reviewerEnabled !== undefined
      ? options.reviewerEnabled
      : Boolean(options.reviewerModel && options.reviewerModel.trim());
  const task: Task = {
    id: uuid(),
    title,
    description,
    status: 'clarifying',
    repository,
    baseBranch: options.baseBranch ?? 'main',
    commitMode: options.commitMode ?? 'pr',
    ...(options.workstreamId ? { workstreamId: options.workstreamId } : {}),
    ...(options.campaignCycleId
      ? { campaignCycleId: options.campaignCycleId }
      : {}),
    ...(options.ownerUserId ? { ownerUserId: options.ownerUserId } : {}),
    ...(options.model && options.model.trim() ? { model: options.model.trim() } : {}),
    ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
    ...(options.reviewerModel && options.reviewerModel.trim()
      ? { reviewerModel: options.reviewerModel.trim() }
      : {}),
    ...(options.reviewerReasoningEffort
      ? { reviewerReasoningEffort: options.reviewerReasoningEffort }
      : {}),
    reviewerEnabled,
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
      `INSERT INTO tasks (
         id, repository, workstream_id, campaign_cycle_id, status, data,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      task.id,
      task.repository ?? null,
      task.workstreamId ?? null,
      task.campaignCycleId ?? null,
      task.status,
      JSON.stringify(rest),
      ts,
      ts,
    );

  // Open the first turn so all agents/activity spawned during initial work
  // (spec gen, build, deploy) attach to it. Defensive coerce — some callers
  // (and a few legacy tests) pass non-string titles.
  const safeTitle = typeof title === 'string' ? title : String(title ?? '');
  const safeDesc = typeof description === 'string' ? description : String(description ?? '');
  turnStore.createTurn(task.id, safeDesc, {
    title: safeTitle.slice(0, 60),
    ...(task.model ? { model: task.model } : {}),
    ...(task.reasoningEffort ? { reasoningEffort: task.reasoningEffort } : {}),
    ...(task.reviewerEnabled !== false && task.reviewerModel
      ? { reviewerModel: task.reviewerModel }
      : {}),
    ...(task.reviewerEnabled !== false && task.reviewerModel && task.reviewerReasoningEffort
      ? { reviewerReasoningEffort: task.reviewerReasoningEffort }
      : {}),
  });

  return task;
}

export function getTask(id: string): Task | undefined {
  const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
    | TaskRow
    | undefined;
  if (!row) return undefined;
  return hydrateTask(row);
}

export function getTaskByCampaignCycleId(
  campaignCycleId: string,
): Task | undefined {
  const row = getDb()
    .prepare('SELECT * FROM tasks WHERE campaign_cycle_id = ?')
    .get(campaignCycleId) as TaskRow | undefined;
  return row ? hydrateTask(row) : undefined;
}

export function findCampaignTaskByPullRequest(
  repository: string,
  pullRequestNumber: number,
): Task | undefined {
  const rows = getDb()
    .prepare(
      `SELECT *
         FROM tasks
        WHERE repository = ?
          AND campaign_cycle_id IS NOT NULL`,
    )
    .all(repository) as TaskRow[];
  return rows
    .map((row) => hydrateTask(row))
    .find((task) => task.pullRequestNumber === pullRequestNumber);
}

export function getTasks(): Task[] {
  const rows = getDb()
    .prepare("SELECT * FROM tasks WHERE status != 'deleting' ORDER BY updated_at DESC")
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
      | 'baseCommitSha'
      | 'implementationNotes'
      | 'implementationChangedFiles'
      | 'imageRef'
      | 'devNamespace'
      | 'devUrl'
      | 'devPort'
      | 'devEnvState'
      | 'errorMessage'
      | 'workstreamId'
      | 'campaignCycleId'
      | 'model'
      | 'reasoningEffort'
      | 'reviewerModel'
      | 'reviewerReasoningEffort'
      | 'reviewerEnabled'
      | 'pendingReviewerFeedback'
      | 'reviewerAttempts'
      | 'campaignReleaseReview'
      | 'pipeline'
      | 'title'
    >
  >,
): Task | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
    | TaskRow
    | undefined;
  if (!row) return undefined;

  const ts = now();
  const baseObj = JSON.parse(row.data) as Omit<Task, 'agents' | 'chatHistory' | 'activityHistory'>;
  const { activityHistory: _ah, agents: _ag, chatHistory: _ch, ...rest } = updates as Partial<Task>;
  void _ah; void _ag; void _ch;
  const merged = { ...baseObj, ...rest, updatedAt: ts };

  db.prepare(
    `UPDATE tasks
        SET repository = ?,
            workstream_id = ?,
            campaign_cycle_id = ?,
            status = ?,
            data = ?,
            updated_at = ?
      WHERE id = ?`,
  ).run(
    (merged.repository ?? null) as string | null,
    (merged.workstreamId ?? null) as string | null,
    (merged.campaignCycleId ?? null) as string | null,
    merged.status,
    JSON.stringify(merged),
    ts,
    id,
  );

  // Close the open turn when the task lands in a terminal state. This stamps
  // the duration so the UI can show wall-clock time per turn. Idempotent:
  // closeCurrentTurn is a no-op when no open turn exists.
  if (
    rest.status &&
    rest.status !== row.status &&
    (rest.status === 'completed' ||
      rest.status === 'failed' ||
      rest.status === 'review')
  ) {
    try {
      turnStore.closeCurrentTurn(id);
    } catch {
      // closing must never break a status update
    }
  }

  return hydrateTask({
    ...row,
    repository: merged.repository ?? null,
    workstream_id: merged.workstreamId ?? null,
    campaign_cycle_id: merged.campaignCycleId ?? null,
    status: merged.status,
    data: JSON.stringify(merged),
    updated_at: ts,
  });
}

/** List tasks belonging to a workstream. */
export function listTasksByWorkstream(workstreamId: string): Task[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM tasks WHERE workstream_id = ? AND status != 'deleting' ORDER BY updated_at DESC",
    )
    .all(workstreamId) as TaskRow[];
  return rows.map((r) => hydrateTask(r));
}

/** List tasks for a repo (regardless of workstream). */
export function listTasksByRepository(repository: string): Task[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM tasks WHERE repository = ? AND status != 'deleting' ORDER BY updated_at DESC",
    )
    .all(repository) as TaskRow[];
  return rows.map((r) => hydrateTask(r));
}

/** List tasks that are mid-teardown (status='deleting'). Used by the
 *  resumable-teardown sweeper to retry external cleanup after a pod restart. */
export function listDeletingTasks(): Task[] {
  const rows = getDb()
    .prepare("SELECT * FROM tasks WHERE status = 'deleting' ORDER BY updated_at ASC")
    .all() as TaskRow[];
  return rows.map((r) => hydrateTask(r));
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
  // Attach to the currently-open turn. Fall back to the most recent turn
  // (rare race during status transitions) so we never orphan an agent.
  const turn = turnStore.getCurrentTurn(taskId) ?? turnStore.getLastTurn(taskId);

  const agent: Agent = {
    id: uuid(),
    taskId,
    ...(turn ? { turnId: turn.id } : {}),
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

  // turn_id is now a column, but we also keep it on the JSON blob for fast hydration.
  db.prepare(
    `INSERT INTO agents (id, task_id, position, data, turn_id) VALUES (?, ?, ?, ?, ?)`,
  ).run(agent.id, taskId, positionRow.next, JSON.stringify(rest), turn?.id ?? null);

  // Bump task's updated_at so the tree view re-sorts.
  db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(ts, taskId);

  return agent;
}

export function updateAgent(
  taskId: string,
  agentId: string,
  updates: Partial<
    Pick<
      Agent,
      | 'status'
      | 'currentAction'
      | 'progress'
      | 'startedAt'
      | 'toolCallCount'
      | 'lastUsefulAction'
      | 'errorMessage'
    >
  >,
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

  // Agent logs can also contain TOOL-WISH and VERDICT directives (esp. from
  // streamed SDK output). Capture them too. Best-effort, never throws.
  try {
    const haystack = [message, output ?? '', command ?? ''].join('\n');
    captureToolWishes(taskId, agentId, haystack);
    captureVerdict(taskId, agentId, haystack);
  } catch {
    /* swallow */
  }
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
  const taskRow = db.prepare('SELECT data FROM tasks WHERE id = ?').get(taskId) as
    | { data: string }
    | undefined;
  if (!taskRow) return undefined;

  // Gulliver (user) messages open a new turn — closing the previously-open one.
  // Other roles attach to the currently-open turn (or the most recent one).
  let turnId: string | undefined;
  if (role === 'gulliver') {
    let model: string | undefined;
    let reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | undefined;
    let reviewerModel: string | undefined;
    let reviewerReasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | undefined;
    try {
      const parsed = JSON.parse(taskRow.data) as {
        model?: string;
        reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
        reviewerModel?: string;
        reviewerReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
        reviewerEnabled?: boolean;
      };
      model = parsed.model;
      reasoningEffort = parsed.reasoningEffort;
      if (parsed.reviewerEnabled !== false && parsed.reviewerModel) {
        reviewerModel = parsed.reviewerModel;
        reviewerReasoningEffort = parsed.reviewerReasoningEffort;
      }
    } catch {
      // ignore
    }
    const newTurn = turnStore.createTurn(taskId, content, {
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(reviewerModel ? { reviewerModel } : {}),
      ...(reviewerModel && reviewerReasoningEffort ? { reviewerReasoningEffort } : {}),
    });
    turnId = newTurn?.id;
  } else {
    turnId =
      turnStore.getCurrentTurn(taskId)?.id ?? turnStore.getLastTurn(taskId)?.id;
  }

  const ts = now();
  const msg: ChatMessage = {
    id: uuid(),
    taskId,
    ...(turnId ? { turnId } : {}),
    role,
    ...(agentId ? { agentId } : {}),
    ...(agentName ? { agentName } : {}),
    content,
    timestamp: ts,
  };

  db.prepare(
    `INSERT INTO chat_messages (id, task_id, ts, data, turn_id) VALUES (?, ?, ?, ?, ?)`,
  ).run(msg.id, taskId, ts, JSON.stringify(msg), turnId ?? null);
  db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(ts, taskId);

  // Scan agent/system messages for TOOL-WISH and VERDICT directives. We don't
  // scan gulliver (human) messages — false positives would be confusing.
  if (role !== 'gulliver') {
    try {
      captureToolWishes(taskId, agentId ?? null, content);
      captureVerdict(taskId, agentId ?? null, content);
    } catch {
      // Capture must never break chat persistence.
    }
  }

  return msg;
}

export function getChatHistory(taskId: string): ChatMessage[] {
  const rows = getDb()
    .prepare('SELECT * FROM chat_messages WHERE task_id = ? ORDER BY ts ASC, id ASC')
    .all(taskId) as ChatRow[];
  return rows.map((r) => JSON.parse(r.data) as ChatMessage);
}

// ─── Activity feed (Live Activity panel) ─────────────────────

/** Append an entry to the persistent activity feed. Mirrors the live socket
 *  events (agent:log, agent:status, etc.) so the UI can render them after a
 *  reload or pod restart. Keep payloads small — no raw tool output. */
export function addActivityEntry(
  taskId: string,
  entry: Omit<ActivityEntry, 'id' | 'taskId' | 'timestamp'> & { timestamp?: string },
): ActivityEntry | undefined {
  const db = getDb();
  const exists = db.prepare('SELECT 1 AS x FROM tasks WHERE id = ?').get(taskId) as
    | { x: number }
    | undefined;
  if (!exists) return undefined;

  const ts = entry.timestamp ?? now();
  // Resolve the owning turn. Caller may pass it explicitly (rare); otherwise
  // fall back to the currently-open turn or the most recent one.
  const turnId =
    entry.turnId ??
    turnStore.getCurrentTurn(taskId)?.id ??
    turnStore.getLastTurn(taskId)?.id;
  const full: ActivityEntry = {
    id: uuid(),
    taskId,
    ...(turnId ? { turnId } : {}),
    timestamp: ts,
    kind: entry.kind,
    message: entry.message,
    ...(entry.agentId ? { agentId: entry.agentId } : {}),
    ...(entry.agentName ? { agentName: entry.agentName } : {}),
    ...(entry.level ? { level: entry.level } : {}),
    ...(entry.command ? { command: entry.command } : {}),
    ...(entry.output ? { output: entry.output } : {}),
  };

  db.prepare(
    `INSERT INTO activity_entries (id, task_id, ts, data, turn_id) VALUES (?, ?, ?, ?, ?)`,
  ).run(full.id, taskId, ts, JSON.stringify(full), turnId ?? null);

  return full;
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
    DELETE FROM activity_entries;
    DELETE FROM turns;
    DELETE FROM tasks;
    DELETE FROM workstreams;
  `);
}

/**
 * Boot-time backfill: every task with a repository but no parent workstream
 * gets attached to that repo's default workstream. Idempotent.
 */
export function backfillDefaultWorkstreams(): { tasksAssigned: number; workstreamsCreated: number } {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, repository FROM tasks WHERE workstream_id IS NULL AND repository IS NOT NULL`,
    )
    .all() as { id: string; repository: string }[];

  if (rows.length === 0) return { tasksAssigned: 0, workstreamsCreated: 0 };

  const before = new Set(wsStore.listWorkstreams().map((w) => `${w.repository}::${w.name}`));
  let assigned = 0;
  const ts = now();

  const txn = db.transaction(() => {
    const upd = db.prepare('UPDATE tasks SET workstream_id = ?, updated_at = ? WHERE id = ?');
    for (const r of rows) {
      const ws = wsStore.ensureDefaultWorkstream(r.repository);
      upd.run(ws.id, ts, r.id);
      assigned++;
    }
  });
  txn();

  const after = new Set(wsStore.listWorkstreams().map((w) => `${w.repository}::${w.name}`));
  let created = 0;
  for (const k of after) if (!before.has(k)) created++;

  return { tasksAssigned: assigned, workstreamsCreated: created };
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
 *
 * Returns a `resumable` list of task ids that the caller can hand to the
 * agent engine for auto-resume. We only consider tasks that were in
 * `building` (mid-agent-work) AND have the workspace metadata
 * (repository + branch) needed to resurrect a session. `deploying` and
 * `shipping` are intentionally NOT auto-resumed because they involve
 * non-idempotent k8s/git operations whose mid-flight state is unsafe to
 * blindly retry — the user gets a `failed` task and can re-trigger
 * manually.
 */
export function reconcileOrphanedRuns(): {
  agentsReset: number;
  tasksFailed: number;
  resumable: string[];
} {
  const db = getDb();
  const ts = now();
  const note = 'Container restarted while this was in flight; marked failed by boot-time reconciler.';
  const podId = getPodId();
  const leaseExpiresAt = Date.now() + LEASE_DURATION_MS;

  let agentsReset = 0;
  let tasksFailed = 0;
  const resumable: string[] = [];

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
        const updated = {
          ...agent,
          status: 'failed' as const,
          updatedAt: ts,
          errorMessage: 'interrupted by API restart',
        };
        updateAgentStmt.run(JSON.stringify(updated), row.id);
        insertLogStmt.run(row.id, ts, 'warn', note, null, null);
        agentsReset++;
      }
    }

    // 2. Tasks stuck in an active phase
    const ACTIVE_STATUSES = ['clarifying', 'specifying', 'building', 'deploying', 'shipping'];
    const taskRows = db
      .prepare(
        `SELECT id, status, campaign_cycle_id, data
           FROM tasks
          WHERE status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`,
      )
      .all(...ACTIVE_STATUSES) as {
        id: string;
        status: string;
        campaign_cycle_id: string | null;
        data: string;
      }[];

    const updateTaskStmt = db.prepare(
      `UPDATE tasks
         SET status = ?, data = ?, updated_at = ?, owner_pod_id = ?, lease_expires_at = ?
       WHERE id = ?`,
    );
    const replayableCampaignStmt = db.prepare(
      `SELECT 1
         FROM autonomous_cycles cycle
         JOIN autonomous_campaigns campaign ON campaign.id = cycle.campaign_id
        WHERE cycle.id = ?
          AND campaign.status = 'running'
          AND campaign.current_cycle_id = cycle.id
          AND cycle.status IN ('proposing', 'delivering')`,
    );

    for (const row of taskRows) {
      const task = JSON.parse(row.data) as Task;
      const campaignCycleId = row.campaign_cycle_id ?? task.campaignCycleId;
      const campaignCanResume =
        campaignCycleId !== undefined &&
        replayableCampaignStmt.get(campaignCycleId) !== undefined;
      const shouldReplayCampaignHandoff =
        campaignCanResume &&
        (row.status === 'clarifying' ||
          row.status === 'specifying' ||
          (row.status === 'building' && !task.baseCommitSha));
      if (shouldReplayCampaignHandoff) {
        const replayable = {
          ...task,
          campaignCycleId,
          status: 'clarifying' as const,
          errorMessage: undefined,
          updatedAt: ts,
        };
        updateTaskStmt.run(
          'clarifying',
          JSON.stringify(replayable),
          ts,
          podId,
          leaseExpiresAt,
          row.id,
        );
        continue;
      }
      const updated = { ...task, status: 'failed' as const, updatedAt: ts };
      updateTaskStmt.run(
        'failed',
        JSON.stringify(updated),
        ts,
        podId,
        leaseExpiresAt,
        row.id,
      );
      tasksFailed++;

      // Resumable iff (a) was actively coding, and (b) has a workspace to
      // resurrect against. `iterateTask` requires repository + branch.
      if (
        row.status === 'building' &&
        task.repository &&
        task.branch &&
        task.baseCommitSha
      ) {
        resumable.push(row.id);
      }
    }
  });

  txn();
  return { agentsReset, tasksFailed, resumable };
}
