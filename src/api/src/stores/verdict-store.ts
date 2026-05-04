/**
 * Verdict capture — agents emit `VERDICT: done|blocked|continue — reason`
 * lines when they think they're finished (or stuck). This module parses
 * those lines and persists them so we can:
 *
 *  1. observe how often agents spontaneously declare completion
 *  2. validate how often their `done` claim was actually correct (vs the
 *     existing build/test/deploy outcome — feeds the eventual server-side
 *     verdict gate in PR-A2-core)
 *  3. surface `blocked` verdicts to the operator as a high-signal stuck-task
 *     indicator
 *
 * This module is OBSERVATIONAL ONLY — emitting `VERDICT: done` does NOT
 * yet affect control flow. Wiring the verdict to actually short-circuit
 * the loop is the mega-prompt PR (PR-A2-core).
 *
 * Parsing reuses `parseVerdict` from `engine/autopilot.ts` so the parser
 * is a single source of truth.
 */

import { v4 as uuid } from 'uuid';
import { parseVerdict, type VerdictStatus } from '../engine/autopilot.js';
import { getDb } from './db.js';

export interface AgentVerdict {
  id: string;
  taskId: string;
  agentId: string | null;
  ts: string;
  status: VerdictStatus;
  reason: string | null;
  raw: string | null;
}

interface Row {
  id: string;
  task_id: string;
  agent_id: string | null;
  ts: string;
  status: string;
  reason: string | null;
  raw: string | null;
}

/**
 * Record one verdict. Idempotent within the same minute window for the same
 * (task, agent, status) combination — prevents log spam if the agent emits
 * the same line repeatedly. Returns the row, or null if deduped.
 */
export function recordVerdict(
  taskId: string,
  agentId: string | null,
  status: VerdictStatus,
  reason: string | null,
  raw: string | null,
): AgentVerdict | null {
  const db = getDb();
  const ts = new Date().toISOString();
  const minuteKey = ts.slice(0, 16);
  const dup = db
    .prepare(
      `SELECT id FROM agent_verdicts
         WHERE task_id = ?
           AND COALESCE(agent_id, '') = COALESCE(?, '')
           AND status = ?
           AND substr(ts, 1, 16) = ?
         LIMIT 1`,
    )
    .get(taskId, agentId, status, minuteKey) as { id: string } | undefined;
  if (dup) return null;

  const verdict: AgentVerdict = {
    id: uuid(),
    taskId,
    agentId: agentId ?? null,
    ts,
    status,
    reason,
    raw,
  };
  db.prepare(
    `INSERT INTO agent_verdicts (id, task_id, agent_id, ts, status, reason, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    verdict.id,
    verdict.taskId,
    verdict.agentId,
    verdict.ts,
    verdict.status,
    verdict.reason,
    verdict.raw,
  );
  return verdict;
}

/**
 * Parse text for the LAST verdict line and record it. The parser only
 * returns the final verdict in the stream, so a single chat message can
 * never produce more than one row. Returns the recorded verdict or null
 * (no verdict / deduped).
 */
export function captureFromText(
  taskId: string,
  agentId: string | null,
  text: string,
): AgentVerdict | null {
  const v = parseVerdict(text);
  if (!v) return null;
  return recordVerdict(taskId, agentId, v.status, v.reason || null, v.raw);
}

function rowToVerdict(row: Row): AgentVerdict {
  return {
    id: row.id,
    taskId: row.task_id,
    agentId: row.agent_id,
    ts: row.ts,
    status: row.status as VerdictStatus,
    reason: row.reason,
    raw: row.raw,
  };
}

/** All verdicts, newest first. Optional taskId filter. */
export function listVerdicts(taskId?: string): AgentVerdict[] {
  const db = getDb();
  const rows = taskId
    ? (db
        .prepare(
          `SELECT * FROM agent_verdicts WHERE task_id = ? ORDER BY ts DESC, rowid DESC`,
        )
        .all(taskId) as Row[])
    : (db
        .prepare(`SELECT * FROM agent_verdicts ORDER BY ts DESC, rowid DESC`)
        .all() as Row[]);
  return rows.map(rowToVerdict);
}

/** The most recent verdict for a task, if any. */
export function latestVerdictForTask(
  taskId: string,
): AgentVerdict | undefined {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM agent_verdicts WHERE task_id = ? ORDER BY ts DESC, rowid DESC LIMIT 1`,
    )
    .get(taskId) as Row | undefined;
  return row ? rowToVerdict(row) : undefined;
}
