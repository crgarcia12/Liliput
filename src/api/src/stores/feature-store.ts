/**
 * Feature store — Features sit between Workstreams and Tasks.
 *
 * Hierarchy: Repo → Workstream → Feature → Task → Agent.
 *
 * Features are produced by the decomposer agent (PR-B1) at request creation:
 * one Workstream may yield N Features plus one synthetic "integration"
 * Feature. Each Feature owns its own spec slice, branch, dev namespace, and
 * Tasks that drive it through the autonomous loop.
 *
 * This module is the persistence layer only. Spawning Tasks per Feature and
 * orchestrating the fan-out is done by the engine in PR-B4.
 */

import { v4 as uuid } from 'uuid';
import type {
  Feature,
  FeatureStatus,
  FeatureKind,
} from '../../../shared/types/index.js';
import { getDb } from './db.js';

interface FeatureRow {
  id: string;
  workstream_id: string;
  name: string;
  slug: string;
  status: string;
  branch: string | null;
  namespace: string | null;
  spec_path: string | null;
  data: string;
  position: number;
  created_at: string;
  updated_at: string;
}

function now(): string {
  return new Date().toISOString();
}

function hydrate(row: FeatureRow): Feature {
  return JSON.parse(row.data) as Feature;
}

export interface CreateFeatureInput {
  workstreamId: string;
  name: string;
  slug: string;
  kind?: FeatureKind;
  description?: string;
  specPath?: string;
  position?: number;
  dependsOn?: string[];
}

export function createFeature(input: CreateFeatureInput): Feature {
  const ts = now();
  const feature: Feature = {
    id: uuid(),
    workstreamId: input.workstreamId,
    name: input.name,
    slug: input.slug,
    kind: input.kind ?? 'feature',
    status: 'pending',
    ...(input.description ? { description: input.description } : {}),
    ...(input.specPath ? { specPath: input.specPath } : {}),
    position: input.position ?? 0,
    ...(input.dependsOn?.length ? { dependsOn: input.dependsOn } : {}),
    createdAt: ts,
    updatedAt: ts,
  };
  getDb()
    .prepare(
      `INSERT INTO features
         (id, workstream_id, name, slug, status, branch, namespace, spec_path, data, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
    )
    .run(
      feature.id,
      feature.workstreamId,
      feature.name,
      feature.slug,
      feature.status,
      feature.specPath ?? null,
      JSON.stringify(feature),
      feature.position,
      ts,
      ts,
    );
  return feature;
}

export function getFeature(id: string): Feature | undefined {
  const row = getDb()
    .prepare('SELECT * FROM features WHERE id = ?')
    .get(id) as FeatureRow | undefined;
  return row ? hydrate(row) : undefined;
}

export function listFeaturesByWorkstream(workstreamId: string): Feature[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM features
         WHERE workstream_id = ?
         ORDER BY position ASC, created_at ASC`,
    )
    .all(workstreamId) as FeatureRow[];
  return rows.map(hydrate);
}

export interface UpdateFeatureInput {
  status?: FeatureStatus;
  branch?: string;
  namespace?: string;
  specPath?: string;
  description?: string;
  position?: number;
  dependsOn?: string[];
}

export function updateFeature(
  id: string,
  patch: UpdateFeatureInput,
): Feature | undefined {
  const existing = getFeature(id);
  if (!existing) return undefined;
  const ts = now();
  const merged: Feature = {
    ...existing,
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.branch !== undefined ? { branch: patch.branch } : {}),
    ...(patch.namespace !== undefined ? { namespace: patch.namespace } : {}),
    ...(patch.specPath !== undefined ? { specPath: patch.specPath } : {}),
    ...(patch.description !== undefined
      ? { description: patch.description }
      : {}),
    ...(patch.position !== undefined ? { position: patch.position } : {}),
    ...(patch.dependsOn !== undefined ? { dependsOn: patch.dependsOn } : {}),
    updatedAt: ts,
  };
  getDb()
    .prepare(
      `UPDATE features
          SET status = ?, branch = ?, namespace = ?, spec_path = ?, data = ?, position = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(
      merged.status,
      merged.branch ?? null,
      merged.namespace ?? null,
      merged.specPath ?? null,
      JSON.stringify(merged),
      merged.position,
      ts,
      id,
    );
  return merged;
}

export function deleteFeature(id: string): boolean {
  // Tasks reference feature_id (no FK) — caller is responsible for tearing
  // down child tasks first.
  const result = getDb().prepare('DELETE FROM features WHERE id = ?').run(id);
  return result.changes > 0;
}
