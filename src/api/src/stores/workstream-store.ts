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
  campaign_cycle_id: string | null;
  data: string;
  created_at: string;
  updated_at: string;
}

function now(): string {
  return new Date().toISOString();
}

function hydrate(row: WorkstreamRow): Workstream {
  const workstream = JSON.parse(row.data) as Workstream;
  if (row.campaign_cycle_id && !workstream.campaignCycleId) {
    workstream.campaignCycleId = row.campaign_cycle_id;
  }
  return workstream;
}

export function createWorkstream(
  repository: string,
  name: string,
  description?: string,
  options: { campaignCycleId?: string } = {},
): Workstream {
  const ts = now();
  const ws: Workstream = {
    id: uuid(),
    repository,
    name,
    ...(description ? { description } : {}),
    ...(options.campaignCycleId
      ? { campaignCycleId: options.campaignCycleId }
      : {}),
    createdAt: ts,
    updatedAt: ts,
  };
  getDb()
    .prepare(
      `INSERT INTO workstreams (
         id, repository, name, campaign_cycle_id, data, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ws.id,
      repository,
      name,
      ws.campaignCycleId ?? null,
      JSON.stringify(ws),
      ts,
      ts,
    );
  return ws;
}

export function getWorkstream(id: string): Workstream | undefined {
  const row = getDb().prepare('SELECT * FROM workstreams WHERE id = ?').get(id) as
    | WorkstreamRow
    | undefined;
  return row ? hydrate(row) : undefined;
}

export function getWorkstreamByCampaignCycleId(
  campaignCycleId: string,
): Workstream | undefined {
  const row = getDb()
    .prepare('SELECT * FROM workstreams WHERE campaign_cycle_id = ?')
    .get(campaignCycleId) as WorkstreamRow | undefined;
  return row ? hydrate(row) : undefined;
}

export interface EnsureCampaignWorkstreamResult {
  workstream: Workstream;
  created: boolean;
}

export function ensureCampaignWorkstream(input: {
  campaignCycleId: string;
  repository: string;
  name: string;
  description?: string;
}): EnsureCampaignWorkstreamResult {
  if (!input.campaignCycleId.trim()) {
    throw new Error('Campaign cycle ID is required');
  }
  const db = getDb();
  const ensure = db.transaction(() => {
    const existing = db
      .prepare('SELECT * FROM workstreams WHERE campaign_cycle_id = ?')
      .get(input.campaignCycleId) as WorkstreamRow | undefined;
    if (existing) {
      return { workstream: hydrate(existing), created: false };
    }
    return {
      workstream: createWorkstream(
        input.repository,
        input.name,
        input.description,
        { campaignCycleId: input.campaignCycleId },
      ),
      created: true,
    };
  });
  return ensure.immediate();
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

/**
 * Persist the GitHub label that groups every PM-emitted Feature issue for
 * this workstream. Writes both the indexed `github_label` column and the
 * `data` JSON blob so callers reading via `getWorkstream()` see the value.
 */
export function setGithubLabel(id: string, label: string): Workstream | undefined {
  const existing = getWorkstream(id);
  if (!existing) return undefined;
  const ts = now();
  const merged: Workstream = { ...existing, githubLabel: label, updatedAt: ts };
  getDb()
    .prepare(
      `UPDATE workstreams SET github_label = ?, data = ?, updated_at = ? WHERE id = ?`,
    )
    .run(label, JSON.stringify(merged), ts, id);
  return merged;
}

/** Persist the umbrella/tracker issue number for a workstream. */
export function setTrackerIssue(id: string, issueNumber: number): Workstream | undefined {
  const existing = getWorkstream(id);
  if (!existing) return undefined;
  const ts = now();
  const merged: Workstream = { ...existing, trackerIssueNumber: issueNumber, updatedAt: ts };
  getDb()
    .prepare(
      `UPDATE workstreams SET tracker_issue_number = ?, data = ?, updated_at = ? WHERE id = ?`,
    )
    .run(issueNumber, JSON.stringify(merged), ts, id);
  return merged;
}
