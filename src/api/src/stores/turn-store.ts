/**
 * Turn store — one row per user message → agent activity grouping.
 *
 * Hierarchy: Repo → Workstream → Task → Turn → Agents.
 *
 * Lifecycle:
 *   - `createTurn` is called when the task is first created (with the original
 *     description) and on every subsequent `gulliver` chat message. Any
 *     previously-open turn for the same task is closed in the same transaction.
 *   - Agents and activity entries created while a turn is open inherit its id.
 *   - `recordUsage` is called from agent-loop when the SDK emits an
 *     `assistant.usage` event; we add the deltas onto the agent's owning turn.
 *   - `closeTurn` flips status to `completed` and stamps `durationMs`.
 *
 *  Workstream + repo rollups are pure SUM queries across this table.
 */

import { v4 as uuid } from 'uuid';
import type { ReasoningEffort, Turn, UsageRollup } from '../../../shared/types/index.js';
import { getDb } from './db.js';

interface TurnRow {
  id: string;
  task_id: string;
  position: number;
  status: 'open' | 'completed';
  title: string;
  user_message: string;
  model: string | null;
  reasoning_effort: string | null;
  reviewer_model: string | null;
  reviewer_reasoning_effort: string | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  nano_aiu: number | null;
  call_count: number;
}

function rowToTurn(row: TurnRow): Turn {
  const totalTokens =
    row.input_tokens + row.output_tokens + row.cache_read_tokens + row.cache_write_tokens;
  const turn: Turn = {
    id: row.id,
    taskId: row.task_id,
    index: row.position + 1,
    title: row.title,
    userMessage: row.user_message,
    status: row.status,
    startedAt: row.started_at,
    usage: {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      totalTokens,
      callCount: row.call_count,
      ...(row.nano_aiu != null ? { nanoAiu: row.nano_aiu } : {}),
    },
    agentIds: [],
  };
  if (row.model) turn.model = row.model;
  if (row.reasoning_effort) turn.reasoningEffort = row.reasoning_effort as ReasoningEffort;
  if (row.reviewer_model) turn.reviewerModel = row.reviewer_model;
  if (row.reviewer_reasoning_effort) {
    turn.reviewerReasoningEffort = row.reviewer_reasoning_effort as ReasoningEffort;
  }
  if (row.completed_at) turn.completedAt = row.completed_at;
  if (row.duration_ms != null) turn.durationMs = row.duration_ms;
  return turn;
}

function attachAgentIds(turns: Turn[]): Turn[] {
  if (turns.length === 0) return turns;
  const db = getDb();
  const ids = turns.map((t) => t.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT id, turn_id FROM agents WHERE turn_id IN (${placeholders})`)
    .all(...ids) as Array<{ id: string; turn_id: string }>;
  const byTurn = new Map<string, string[]>();
  for (const r of rows) {
    const arr = byTurn.get(r.turn_id) ?? [];
    arr.push(r.id);
    byTurn.set(r.turn_id, arr);
  }
  return turns.map((t) => ({ ...t, agentIds: byTurn.get(t.id) ?? [] }));
}

/** Build the title for a fresh turn. Today: first ~6 words / 60 chars of the
 *  user message, trimmed. Future: replace with a 1-4 word LLM call. */
function makeTitle(userMessage: string): string {
  const cleaned = userMessage.replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return 'Untitled turn';
  const words = cleaned.split(' ').slice(0, 6).join(' ');
  return words.length > 60 ? words.slice(0, 57).trimEnd() + '…' : words;
}

/** Open a new turn for the task, closing the previously open turn (if any).
 *  Returns the new Turn. */
export function createTurn(
  taskId: string,
  userMessage: string,
  options: {
    model?: string;
    reasoningEffort?: ReasoningEffort;
    reviewerModel?: string;
    reviewerReasoningEffort?: ReasoningEffort;
    title?: string;
  } = {},
): Turn | undefined {
  const db = getDb();
  const exists = db.prepare('SELECT 1 AS x FROM tasks WHERE id = ?').get(taskId) as
    | { x: number }
    | undefined;
  if (!exists) return undefined;

  const id = uuid();
  const ts = new Date().toISOString();
  const title = options.title ?? makeTitle(userMessage);

  const txn = db.transaction(() => {
    // Close any currently-open turn for this task.
    const open = db
      .prepare(`SELECT id, started_at FROM turns WHERE task_id = ? AND status = 'open'`)
      .all(taskId) as Array<{ id: string; started_at: string }>;
    for (const row of open) {
      const dur = new Date(ts).getTime() - new Date(row.started_at).getTime();
      const durationMs = Number.isFinite(dur) && dur > 0 ? dur : 0;
      db.prepare(
        `UPDATE turns SET status = 'completed', completed_at = ?, duration_ms = ? WHERE id = ?`,
      ).run(ts, durationMs, row.id);
    }

    const positionRow = db
      .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM turns WHERE task_id = ?')
      .get(taskId) as { next: number };

    db.prepare(
      `INSERT INTO turns (
         id, task_id, position, status, title, user_message, model, reasoning_effort,
         reviewer_model, reviewer_reasoning_effort,
         started_at, completed_at, duration_ms,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         nano_aiu, call_count
       ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, 0, 0, 0, NULL, 0)`,
    ).run(
      id,
      taskId,
      positionRow.next,
      title,
      userMessage,
      options.model ?? null,
      options.reasoningEffort ?? null,
      options.reviewerModel ?? null,
      options.reviewerReasoningEffort ?? null,
      ts,
    );
  });
  txn();

  return getTurn(id);
}

export function getTurn(id: string): Turn | undefined {
  const row = getDb().prepare('SELECT * FROM turns WHERE id = ?').get(id) as
    | TurnRow
    | undefined;
  if (!row) return undefined;
  return attachAgentIds([rowToTurn(row)])[0];
}

export function getCurrentTurn(taskId: string): Turn | undefined {
  const row = getDb()
    .prepare(
      `SELECT * FROM turns WHERE task_id = ? AND status = 'open' ORDER BY position DESC LIMIT 1`,
    )
    .get(taskId) as TurnRow | undefined;
  if (!row) return undefined;
  return attachAgentIds([rowToTurn(row)])[0];
}

/** Most recent turn (open OR closed) — used as the fallback when an agent
 *  fires without an open turn (rare race during status transitions). */
export function getLastTurn(taskId: string): Turn | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM turns WHERE task_id = ? ORDER BY position DESC LIMIT 1`)
    .get(taskId) as TurnRow | undefined;
  if (!row) return undefined;
  return attachAgentIds([rowToTurn(row)])[0];
}

export function listTurnsForTask(taskId: string): Turn[] {
  const rows = getDb()
    .prepare(`SELECT * FROM turns WHERE task_id = ? ORDER BY position ASC`)
    .all(taskId) as TurnRow[];
  return attachAgentIds(rows.map(rowToTurn));
}

/** Close the currently-open turn (if any). Idempotent. */
export function closeCurrentTurn(taskId: string): Turn | undefined {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM turns WHERE task_id = ? AND status = 'open' ORDER BY position DESC LIMIT 1`,
    )
    .get(taskId) as TurnRow | undefined;
  if (!row) return undefined;

  const ts = new Date().toISOString();
  const dur = new Date(ts).getTime() - new Date(row.started_at).getTime();
  const durationMs = Number.isFinite(dur) && dur > 0 ? dur : 0;
  db.prepare(
    `UPDATE turns SET status = 'completed', completed_at = ?, duration_ms = ? WHERE id = ?`,
  ).run(ts, durationMs, row.id);
  return getTurn(row.id);
}

export interface UsageDelta {
  /** Model id reported by the SDK `assistant.usage` event. Required so the
   *  per-call row can be priced later. Old callers that don't have a model
   *  (legacy tests) may pass undefined; the per-call row is still written
   *  with model='unknown' so totals stay correct. */
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  nanoAiu?: number;
  /** ISO-8601 UTC timestamp of the LLM call. Defaults to now(). */
  occurredAt?: string;
  /** Wall-clock duration of the LLM call in ms, if the SDK reported it. */
  durationMs?: number;
  /** Number of API calls represented by this delta. Defaults to 1. */
  calls?: number;
  /** Owning agent id when known. Stored on the per-call row so cost can
   *  later be sliced per agent kind (coder / reviewer / ops-fixer). */
  agentId?: string;
}

/** Add a usage delta to a turn's running totals AND persist a per-call row
 *  (one per SDK `assistant.usage` event) so cost can be computed against
 *  the price effective at the time of the call. */
export function recordUsage(turnId: string, delta: UsageDelta): Turn | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM turns WHERE id = ?').get(turnId) as
    | TurnRow
    | undefined;
  if (!row) return undefined;

  const calls = delta.calls ?? 1;
  const inputTokens = delta.inputTokens ?? 0;
  const outputTokens = delta.outputTokens ?? 0;
  const cacheReadTokens = delta.cacheReadTokens ?? 0;
  const cacheWriteTokens = delta.cacheWriteTokens ?? 0;
  const newInput = row.input_tokens + inputTokens;
  const newOutput = row.output_tokens + outputTokens;
  const newCacheRead = row.cache_read_tokens + cacheReadTokens;
  const newCacheWrite = row.cache_write_tokens + cacheWriteTokens;
  const newNanoAiu =
    delta.nanoAiu != null ? (row.nano_aiu ?? 0) + delta.nanoAiu : row.nano_aiu;
  const newCalls = row.call_count + calls;
  const occurredAt = delta.occurredAt ?? new Date().toISOString();

  const updateTurn = db.prepare(
    `UPDATE turns
        SET input_tokens = ?,
            output_tokens = ?,
            cache_read_tokens = ?,
            cache_write_tokens = ?,
            nano_aiu = ?,
            call_count = ?
      WHERE id = ?`,
  );
  const insertCall = db.prepare(
    `INSERT INTO turn_usage_call (
       id, turn_id, task_id, agent_id, model,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       nano_aiu, duration_ms, occurred_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const txn = db.transaction(() => {
    updateTurn.run(
      newInput,
      newOutput,
      newCacheRead,
      newCacheWrite,
      newNanoAiu,
      newCalls,
      turnId,
    );
    // One row per SDK `assistant.usage` event (calls=1 is the common case).
    // If a caller batches multiple calls into a single delta (calls > 1) we
    // still write a single row with the summed counts — preserves cost math
    // but loses per-call granularity. The only producer today (agent-engine
    // `recordUsageEvent`) always passes calls=1, so this is fine.
    insertCall.run(
      uuid(),
      turnId,
      row.task_id,
      delta.agentId ?? null,
      delta.model ?? 'unknown',
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      delta.nanoAiu ?? null,
      delta.durationMs ?? null,
      occurredAt,
    );
  });
  txn();

  return getTurn(turnId);
}

/** Update title (e.g. after async LLM titling lands). */
export function setTurnTitle(turnId: string, title: string): void {
  getDb().prepare('UPDATE turns SET title = ? WHERE id = ?').run(title, turnId);
}

interface AggRow {
  turns: number;
  totalIn: number | null;
  totalOut: number | null;
  totalCacheRead: number | null;
  totalCacheWrite: number | null;
  totalDur: number | null;
  totalNanoAiu: number | null;
}

function aggToRollup(agg: AggRow): UsageRollup {
  const inputTokens = agg.totalIn ?? 0;
  const outputTokens = agg.totalOut ?? 0;
  const cacheReadTokens = agg.totalCacheRead ?? 0;
  const cacheWriteTokens = agg.totalCacheWrite ?? 0;
  const result: UsageRollup = {
    turns: agg.turns,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    durationMs: agg.totalDur ?? 0,
  };
  if (agg.totalNanoAiu != null && agg.totalNanoAiu > 0) result.nanoAiu = agg.totalNanoAiu;
  return result;
}

const ROLLUP_SELECT = `
  SELECT
    COUNT(*)                    AS turns,
    SUM(input_tokens)           AS totalIn,
    SUM(output_tokens)          AS totalOut,
    SUM(cache_read_tokens)      AS totalCacheRead,
    SUM(cache_write_tokens)     AS totalCacheWrite,
    SUM(COALESCE(duration_ms, 0)) AS totalDur,
    SUM(nano_aiu)               AS totalNanoAiu
  FROM turns
`;

export function rollupForTask(taskId: string): UsageRollup {
  const agg = getDb()
    .prepare(`${ROLLUP_SELECT} WHERE task_id = ?`)
    .get(taskId) as AggRow;
  return aggToRollup(agg);
}

export function rollupForWorkstream(workstreamId: string): UsageRollup {
  const agg = getDb()
    .prepare(
      `${ROLLUP_SELECT}
        WHERE task_id IN (SELECT id FROM tasks WHERE workstream_id = ?)`,
    )
    .get(workstreamId) as AggRow;
  return aggToRollup(agg);
}

export function rollupForRepo(repository: string): UsageRollup {
  const agg = getDb()
    .prepare(
      `${ROLLUP_SELECT}
        WHERE task_id IN (SELECT id FROM tasks WHERE repository = ?)`,
    )
    .get(repository) as AggRow;
  return aggToRollup(agg);
}

/** Map of repository → UsageRollup, used for the workstreams home page. */
export function rollupAllRepos(): Map<string, UsageRollup> {
  const rows = getDb()
    .prepare(
      `SELECT
         t.repository                         AS repository,
         COUNT(tu.id)                          AS turns,
         SUM(tu.input_tokens)                  AS totalIn,
         SUM(tu.output_tokens)                 AS totalOut,
         SUM(tu.cache_read_tokens)             AS totalCacheRead,
         SUM(tu.cache_write_tokens)            AS totalCacheWrite,
         SUM(COALESCE(tu.duration_ms, 0))      AS totalDur,
         SUM(tu.nano_aiu)                      AS totalNanoAiu
       FROM tasks t
       JOIN turns tu ON tu.task_id = t.id
       WHERE t.repository IS NOT NULL
       GROUP BY t.repository`,
    )
    .all() as Array<AggRow & { repository: string }>;
  const map = new Map<string, UsageRollup>();
  for (const r of rows) map.set(r.repository, aggToRollup(r));
  return map;
}

/** Map of workstreamId → UsageRollup, used for sidebar workstream rows. */
export function rollupAllWorkstreams(): Map<string, UsageRollup> {
  const rows = getDb()
    .prepare(
      `SELECT
         t.workstream_id                       AS workstream_id,
         COUNT(tu.id)                          AS turns,
         SUM(tu.input_tokens)                  AS totalIn,
         SUM(tu.output_tokens)                 AS totalOut,
         SUM(tu.cache_read_tokens)             AS totalCacheRead,
         SUM(tu.cache_write_tokens)            AS totalCacheWrite,
         SUM(COALESCE(tu.duration_ms, 0))      AS totalDur,
         SUM(tu.nano_aiu)                      AS totalNanoAiu
       FROM tasks t
       JOIN turns tu ON tu.task_id = t.id
       WHERE t.workstream_id IS NOT NULL
       GROUP BY t.workstream_id`,
    )
    .all() as Array<AggRow & { workstream_id: string }>;
  const map = new Map<string, UsageRollup>();
  for (const r of rows) map.set(r.workstream_id, aggToRollup(r));
  return map;
}
