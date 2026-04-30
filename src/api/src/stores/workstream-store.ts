/**
 * Workstream store — workstreams group multiple Tasks under a single repo.
 *
 * Hierarchy: Repo → Workstream → Task → Agent.
 *
 * One default workstream is auto-created per repo on demand so existing call
 * sites that create tasks without an explicit workstreamId keep working.
 */

import { v4 as uuid } from 'uuid';
import type { Workstream } from '../../../shared/types/index.js';
import { getDb } from './db.js';

const DEFAULT_NAME = '(default)';

interface WorkstreamRow {
  id: string;
  repository: string;
  name: string;
  data: string;
  created_at: string;
  updated_at: string;
}

function now(): string {
  return new Date().toISOString();
}

function hydrate(row: WorkstreamRow): Workstream {
  return JSON.parse(row.data) as Workstream;
}

export function createWorkstream(
  repository: string,
  name: string,
  description?: string,
): Workstream {
  const ts = now();
  const ws: Workstream = {
    id: uuid(),
    repository,
    name,
    ...(description ? { description } : {}),
    createdAt: ts,
    updatedAt: ts,
  };
  getDb()
    .prepare(
      `INSERT INTO workstreams (id, repository, name, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(ws.id, repository, name, JSON.stringify(ws), ts, ts);
  return ws;
}

export function getWorkstream(id: string): Workstream | undefined {
  const row = getDb().prepare('SELECT * FROM workstreams WHERE id = ?').get(id) as
    | WorkstreamRow
    | undefined;
  return row ? hydrate(row) : undefined;
}

export function listWorkstreams(repository?: string): Workstream[] {
  const db = getDb();
  const rows = repository
    ? (db
        .prepare('SELECT * FROM workstreams WHERE repository = ? ORDER BY name ASC')
        .all(repository) as WorkstreamRow[])
    : (db
        .prepare('SELECT * FROM workstreams ORDER BY repository ASC, name ASC')
        .all() as WorkstreamRow[]);
  return rows.map(hydrate);
}

/** Find or create the default workstream for a repository. */
export function ensureDefaultWorkstream(repository: string): Workstream {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM workstreams WHERE repository = ? AND name = ?')
    .get(repository, DEFAULT_NAME) as WorkstreamRow | undefined;
  if (row) return hydrate(row);
  return createWorkstream(repository, DEFAULT_NAME, 'Default workstream');
}

export function deleteWorkstream(id: string): boolean {
  // Tasks reference workstream_id with ON DELETE SET NULL — orphaned tasks are
  // backfilled by callers. Caller is responsible for tearing down child tasks
  // *before* dropping the workstream.
  const result = getDb().prepare('DELETE FROM workstreams WHERE id = ?').run(id);
  return result.changes > 0;
}

/** List workstream IDs that belong to a repo. */
export function listWorkstreamIdsForRepo(repository: string): string[] {
  const rows = getDb()
    .prepare('SELECT id FROM workstreams WHERE repository = ?')
    .all(repository) as { id: string }[];
  return rows.map((r) => r.id);
}
