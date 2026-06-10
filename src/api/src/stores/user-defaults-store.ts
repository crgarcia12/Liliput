/**
 * Per-user agent-model defaults store.
 *
 * Source of truth for `user_agent_defaults` (one row per user × agent role).
 * NULL columns mean "fall through to env / server default" — keep this in mind
 * when reading: a row CAN exist with `model = NULL` (user explicitly reset that
 * role) and we treat it as "no pin".
 *
 * Resolution order is implemented in `resolveAgentConfig` (see
 * `engine/agent-config.ts`):
 *    task-pin (per-workstream) → THIS TABLE → env (`COPILOT_<ROLE>_MODEL`) →
 *    env (`COPILOT_MODEL`) → constant 'claude-sonnet-4.5'.
 *
 * Live semantics: changing the profile takes effect on the NEXT turn that
 * resolves. Turns already opened keep their snapshotted model in `turns`.
 */

import type {
  AgentConfigRole,
  ReasoningEffort,
} from '../../../shared/types/index.js';
import { AGENT_CONFIG_ROLES } from '../../../shared/types/index.js';
import { getDb } from './db.js';
import { logger } from '../logger.js';

export interface StoredUserDefault {
  role: AgentConfigRole;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  updatedAt: string;
}

interface UserDefaultRow {
  agent_role: string;
  model: string | null;
  reasoning_effort: string | null;
  updated_at: string;
}

function isAgentConfigRole(value: string): value is AgentConfigRole {
  return (AGENT_CONFIG_ROLES as readonly string[]).includes(value);
}

function isReasoningEffort(value: string | null): value is ReasoningEffort {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh';
}

function rowToStored(row: UserDefaultRow): StoredUserDefault | null {
  if (!isAgentConfigRole(row.agent_role)) return null;
  return {
    role: row.agent_role,
    model: row.model && row.model.trim() ? row.model.trim() : null,
    reasoningEffort: row.reasoning_effort && isReasoningEffort(row.reasoning_effort)
      ? row.reasoning_effort
      : null,
    updatedAt: row.updated_at,
  };
}

/** Return all stored defaults for a user. Missing roles are simply absent
 *  from the returned array — the resolver treats them as "no pin". */
export function listDefaults(userId: string): StoredUserDefault[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT agent_role, model, reasoning_effort, updated_at
         FROM user_agent_defaults
        WHERE user_id = ?`,
    )
    .all(userId) as UserDefaultRow[];
  const out: StoredUserDefault[] = [];
  for (const r of rows) {
    const s = rowToStored(r);
    if (s) out.push(s);
  }
  return out;
}

export function getDefault(
  userId: string,
  role: AgentConfigRole,
): StoredUserDefault | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT agent_role, model, reasoning_effort, updated_at
         FROM user_agent_defaults
        WHERE user_id = ? AND agent_role = ?`,
    )
    .get(userId, role) as UserDefaultRow | undefined;
  if (!row) return null;
  return rowToStored(row);
}

export interface SetDefaultInput {
  /** Null or empty string clears the pin. */
  model?: string | null;
  /** Null clears the reasoning pin (auto-derive from model id). */
  reasoningEffort?: ReasoningEffort | null;
}

/** Upsert a single role's defaults for a user. Pass `model: null` (or empty)
 *  to clear the pin while keeping the row (useful to mark "I explicitly chose
 *  to fall through" — distinct from "never configured"). */
export function setDefault(
  userId: string,
  role: AgentConfigRole,
  input: SetDefaultInput,
): StoredUserDefault {
  const db = getDb();
  const now = new Date().toISOString();
  const model =
    input.model === undefined
      ? null
      : input.model === null || input.model.trim() === ''
        ? null
        : input.model.trim();
  const effort =
    input.reasoningEffort === undefined || input.reasoningEffort === null
      ? null
      : isReasoningEffort(input.reasoningEffort)
        ? input.reasoningEffort
        : null;

  db.prepare(
    `INSERT INTO user_agent_defaults (user_id, agent_role, model, reasoning_effort, updated_at)
          VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, agent_role) DO UPDATE SET
          model = excluded.model,
          reasoning_effort = excluded.reasoning_effort,
          updated_at = excluded.updated_at`,
  ).run(userId, role, model, effort, now);

  return { role, model, reasoningEffort: effort, updatedAt: now };
}

/** Delete a role's row entirely. Semantically equivalent to `setDefault(...,
 *  { model: null, reasoningEffort: null })` but produces a cleaner row state
 *  (row absent = "never configured"). */
export function deleteDefault(userId: string, role: AgentConfigRole): boolean {
  const db = getDb();
  const result = db
    .prepare(`DELETE FROM user_agent_defaults WHERE user_id = ? AND agent_role = ?`)
    .run(userId, role);
  return result.changes > 0;
}

/** Cheap reviewer / critic / rewriter defaults seeded on first profile access.
 *  We pick a small fast model because these stages are bounded, short, and
 *  don't need top-end reasoning. Idempotent — only inserts when the row is
 *  absent. */
const CHEAP_DEFAULTS: ReadonlyArray<{
  role: AgentConfigRole;
  model: string;
  reasoningEffort?: ReasoningEffort;
}> = [
  { role: 'rewriter', model: 'gpt-5-mini', reasoningEffort: 'medium' },
  { role: 'critic', model: 'gpt-5-mini', reasoningEffort: 'medium' },
  { role: 'reviewer', model: 'gpt-5-mini', reasoningEffort: 'medium' },
  // architect + coder are intentionally left unseeded so the user inherits the
  // server-side strong default. They tend to need higher reasoning.
];

/** Seed cheap defaults for a user that has NO rows yet. Returns true if any
 *  rows were inserted (i.e. this was the first time we saw this user). */
export function seedCheapDefaultsIfEmpty(userId: string): boolean {
  const existing = listDefaults(userId);
  if (existing.length > 0) return false;
  const now = new Date().toISOString();
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO user_agent_defaults (user_id, agent_role, model, reasoning_effort, updated_at)
          VALUES (?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction(() => {
    for (const d of CHEAP_DEFAULTS) {
      insert.run(userId, d.role, d.model, d.reasoningEffort ?? null, now);
    }
  });
  try {
    tx();
    logger.info({ userId, count: CHEAP_DEFAULTS.length }, 'Seeded cheap agent defaults for user');
    return true;
  } catch (err) {
    logger.warn({ err, userId }, 'seedCheapDefaultsIfEmpty failed — leaving user with server defaults');
    return false;
  }
}
