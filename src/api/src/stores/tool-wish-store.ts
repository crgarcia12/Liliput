/**
 * Tool wishes — agents emit `TOOL-WISH: <tool> — <reason>` lines in chat or
 * agent logs when they wish a CLI was installed in the runtime image. This
 * module parses those lines and persists them so the operator can review and
 * bake popular requests into the next Dockerfile build.
 *
 * Format (case-insensitive on the prefix, dash separator can be `-`, `--`,
 * `—`, or `:`):
 *   TOOL-WISH: jq — needed to parse kubectl json output
 *   tool-wish: yq -- helm chart inspection
 *   TOOL-WISH gh-cli: already shipped (filtered out as duplicate, see below)
 *
 * The parser is deliberately lenient because it runs against free-form LLM
 * output. The `tool` is normalised to lowercase + trimmed; `reason` keeps
 * original casing.
 */
import { v4 as uuid } from 'uuid';
import { getDb } from './db.js';

export interface ToolWish {
  id: string;
  taskId: string;
  agentId: string | null;
  ts: string;
  tool: string;
  reason: string | null;
}

export interface ToolWishAggregate {
  tool: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  reasons: string[];
  taskIds: string[];
}

interface Row {
  id: string;
  task_id: string;
  agent_id: string | null;
  ts: string;
  tool: string;
  reason: string | null;
}

const TOOL_WISH_RE =
  /(?:^|\n)\s*tool[-_ ]wish\s*[:\-—]\s*([A-Za-z0-9_.+\-/@]+)\s*(?:[:\-—]+\s*(.+?))?(?=\n|$)/gi;

/**
 * Extract tool wishes from a chunk of free-form text (chat message, agent log
 * line, etc). Returns one entry per match. Empty array if none found.
 */
export function parseToolWishes(
  text: string
): Array<{ tool: string; reason: string | null }> {
  if (!text) return [];
  const out: Array<{ tool: string; reason: string | null }> = [];
  // Reset lastIndex because the regex is /g and we reuse it across calls.
  TOOL_WISH_RE.lastIndex = 0;
  for (const m of text.matchAll(TOOL_WISH_RE)) {
    const tool = (m[1] ?? '').trim().toLowerCase();
    if (!tool) continue;
    const reason = (m[2] ?? '').trim() || null;
    out.push({ tool, reason });
  }
  return out;
}

/**
 * Record one tool wish. Called from the chat-persistence path after parsing.
 * Idempotent enough: same task + same tool + same minute is treated as the
 * same wish (avoids spam if the agent repeats itself in a tight loop).
 */
export function recordToolWish(
  taskId: string,
  agentId: string | null,
  tool: string,
  reason: string | null
): ToolWish | null {
  const db = getDb();
  const ts = new Date().toISOString();
  const minuteKey = ts.slice(0, 16); // yyyy-MM-ddTHH:mm
  // Dedupe within the minute window for the same (task, tool) combo.
  const dup = db
    .prepare(
      `SELECT id FROM tool_wishes
       WHERE task_id = ? AND tool = ? AND substr(ts, 1, 16) = ?
       LIMIT 1`
    )
    .get(taskId, tool, minuteKey) as { id: string } | undefined;
  if (dup) return null;

  const wish: ToolWish = {
    id: uuid(),
    taskId,
    agentId: agentId ?? null,
    ts,
    tool,
    reason,
  };
  db.prepare(
    `INSERT INTO tool_wishes (id, task_id, agent_id, ts, tool, reason)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(wish.id, wish.taskId, wish.agentId, wish.ts, wish.tool, wish.reason);
  return wish;
}

/**
 * Convenience: parse text and record any wishes found. Returns the recorded
 * entries (excluding ones suppressed by the dedupe window).
 */
export function captureFromText(
  taskId: string,
  agentId: string | null,
  text: string
): ToolWish[] {
  const recorded: ToolWish[] = [];
  for (const w of parseToolWishes(text)) {
    const r = recordToolWish(taskId, agentId, w.tool, w.reason);
    if (r) recorded.push(r);
  }
  return recorded;
}

function rowToWish(row: Row): ToolWish {
  return {
    id: row.id,
    taskId: row.task_id,
    agentId: row.agent_id,
    ts: row.ts,
    tool: row.tool,
    reason: row.reason,
  };
}

/** All wishes, newest first. */
export function listToolWishes(): ToolWish[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM tool_wishes ORDER BY ts DESC`)
    .all() as Row[];
  return rows.map(rowToWish);
}

/**
 * Aggregated by tool (most-wished first). The operator wants to see "jq has
 * been requested 14 times across 6 tasks" rather than 14 individual rows.
 */
export function aggregateToolWishes(): ToolWishAggregate[] {
  const wishes = listToolWishes();
  const map = new Map<string, ToolWishAggregate>();
  for (const w of wishes) {
    let agg = map.get(w.tool);
    if (!agg) {
      agg = {
        tool: w.tool,
        count: 0,
        firstSeen: w.ts,
        lastSeen: w.ts,
        reasons: [],
        taskIds: [],
      };
      map.set(w.tool, agg);
    }
    agg.count++;
    if (w.ts < agg.firstSeen) agg.firstSeen = w.ts;
    if (w.ts > agg.lastSeen) agg.lastSeen = w.ts;
    if (w.reason && !agg.reasons.includes(w.reason)) agg.reasons.push(w.reason);
    if (!agg.taskIds.includes(w.taskId)) agg.taskIds.push(w.taskId);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}
