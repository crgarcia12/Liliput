import { describe, it, expect, beforeEach } from 'vitest';
import {
  createFeature,
  getFeature,
  listFeaturesByWorkstream,
  updateFeature,
  deleteFeature,
} from '../../src/stores/feature-store.js';
import { resetStore } from '../../src/stores/task-store.js';
import { createWorkstream } from '../../src/stores/workstream-store.js';

beforeEach(() => {
  resetStore();
});

describe('feature-store', () => {
  it('creates a feature with default kind=feature and status=pending', () => {
    const ws = createWorkstream('owner/repo', 'autopilot');
    const f = createFeature({
      workstreamId: ws.id,
      name: 'User Login',
      slug: '01-user-login',
      specPath: 'specs/features/01-user-login.feature.md',
      position: 1,
    });
    expect(f.id).toBeTruthy();
    expect(f.workstreamId).toBe(ws.id);
    expect(f.kind).toBe('feature');
    expect(f.status).toBe('pending');
    expect(f.specPath).toBe('specs/features/01-user-login.feature.md');
    expect(f.position).toBe(1);
  });

  it('creates an integration feature when kind=integration', () => {
    const ws = createWorkstream('owner/repo', 'autopilot');
    const f = createFeature({
      workstreamId: ws.id,
      name: 'Integration',
      slug: '99-integration',
      kind: 'integration',
    });
    expect(f.kind).toBe('integration');
  });

  it('round-trips through getFeature', () => {
    const ws = createWorkstream('owner/repo', 'autopilot');
    const f = createFeature({
      workstreamId: ws.id,
      name: 'Search',
      slug: '02-search',
      description: 'Full-text search',
      dependsOn: ['feat-1'],
    });
    const back = getFeature(f.id);
    expect(back?.name).toBe('Search');
    expect(back?.description).toBe('Full-text search');
    expect(back?.dependsOn).toEqual(['feat-1']);
  });

  it('lists features for a workstream ordered by position', () => {
    const ws = createWorkstream('owner/repo', 'autopilot');
    createFeature({ workstreamId: ws.id, name: 'B', slug: 'b', position: 2 });
    createFeature({ workstreamId: ws.id, name: 'A', slug: 'a', position: 1 });
    createFeature({ workstreamId: ws.id, name: 'C', slug: 'c', position: 3 });
    const list = listFeaturesByWorkstream(ws.id);
    expect(list.map((f) => f.name)).toEqual(['A', 'B', 'C']);
  });

  it('isolates features per workstream', () => {
    const ws1 = createWorkstream('owner/repo1', 'autopilot');
    const ws2 = createWorkstream('owner/repo2', 'autopilot');
    createFeature({ workstreamId: ws1.id, name: 'F1', slug: 'f1' });
    createFeature({ workstreamId: ws2.id, name: 'F2', slug: 'f2' });
    expect(listFeaturesByWorkstream(ws1.id)).toHaveLength(1);
    expect(listFeaturesByWorkstream(ws2.id)).toHaveLength(1);
  });

  it('updates status, branch, and namespace', () => {
    const ws = createWorkstream('owner/repo', 'autopilot');
    const f = createFeature({ workstreamId: ws.id, name: 'F', slug: 'f' });
    const updated = updateFeature(f.id, {
      status: 'in-progress',
      branch: 'feat/01-f',
      namespace: 'dev-owner-repo-f',
    });
    expect(updated?.status).toBe('in-progress');
    expect(updated?.branch).toBe('feat/01-f');
    expect(updated?.namespace).toBe('dev-owner-repo-f');
    // Persisted
    expect(getFeature(f.id)?.status).toBe('in-progress');
  });

  it('preserves unrelated fields on partial update', () => {
    const ws = createWorkstream('owner/repo', 'autopilot');
    const f = createFeature({
      workstreamId: ws.id,
      name: 'F',
      slug: 'f',
      description: 'keep me',
    });
    updateFeature(f.id, { status: 'done' });
    const back = getFeature(f.id);
    expect(back?.description).toBe('keep me');
    expect(back?.status).toBe('done');
  });

  it('returns undefined when updating a missing feature', () => {
    expect(updateFeature('nope', { status: 'done' })).toBeUndefined();
  });

  it('deletes a feature', () => {
    const ws = createWorkstream('owner/repo', 'autopilot');
    const f = createFeature({ workstreamId: ws.id, name: 'F', slug: 'f' });
    expect(deleteFeature(f.id)).toBe(true);
    expect(getFeature(f.id)).toBeUndefined();
  });

  it('cascades delete when workstream is removed (FK ON DELETE CASCADE)', async () => {
    const ws = createWorkstream('owner/repo', 'autopilot');
    const f = createFeature({ workstreamId: ws.id, name: 'F', slug: 'f' });
    const { deleteWorkstream } = await import(
      '../../src/stores/workstream-store.js'
    );
    deleteWorkstream(ws.id);
    expect(getFeature(f.id)).toBeUndefined();
  });
});
