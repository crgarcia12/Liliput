/**
 * Unit tests for the webhook dispatcher.
 *
 * We do NOT exercise the real `startBuild` / Copilot SDK / k8s engine — the
 * dispatcher accepts a `spawnDevTask` injection seam that we mock.
 *
 * Coverage:
 *   - issues.labeled(pm:ready) -> spawnDevTask called, job claimed
 *   - issues.labeled(other) ignored
 *   - issues.unlabeled ignored
 *   - PR `issue.pull_request` present -> ignored (PR labeling, not issue)
 *   - Unknown issue (no Feature mapping, no marker) -> no spawn, no job
 *   - Feature found via body marker -> mapping healed
 *   - Duplicate delivery (same state_key) -> spawn called once
 *   - pull_request.labeled(rm:review) on non-draft -> RM job queued
 *   - pull_request.labeled(rm:review) on DRAFT -> ignored
 *   - pull_request.synchronize on draft -> ignored
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetDb } from '../../src/stores/db.js';
import * as workstreamStore from '../../src/stores/workstream-store.js';
import * as featureStore from '../../src/stores/feature-store.js';
import * as taskStore from '../../src/stores/task-store.js';
import { createWebhookDispatcher } from '../../src/engine/webhook-dispatcher.js';
import { getDb } from '../../src/stores/db.js';

beforeEach(() => {
  resetDb();
});

interface JobRow {
  id: string;
  kind: string;
  state_key: string;
  status: string;
}

function listJobs(): JobRow[] {
  return getDb()
    .prepare(`SELECT id, kind, state_key, status FROM github_jobs ORDER BY created_at ASC`)
    .all() as JobRow[];
}

// Minimal SocketServer stub — never invoked because the test always passes a
// spawnDevTask override that doesn't touch socket.io.
const fakeIo = {} as unknown as import('socket.io').Server;

function seedFeature() {
  const ws = workstreamStore.createWorkstream('owner/repo', 'auth', 'Auth');
  const feature = featureStore.createFeature({
    workstreamId: ws.id,
    name: 'Login',
    slug: '01-login',
    kind: 'feature',
  });
  featureStore.updateFeature(feature.id, {
    githubIssueNumber: 7,
    githubIssueUrl: 'https://github.com/owner/repo/issues/7',
  });
  return { ws, feature: featureStore.getFeature(feature.id)! };
}

describe('createWebhookDispatcher', () => {
  describe('issues.labeled', () => {
    it('spawns a Dev task and claims a job on pm:ready', async () => {
      const { feature } = seedFeature();
      const spawn = vi.fn().mockResolvedValue({ taskId: 'task-1' });
      const dispatch = createWebhookDispatcher(fakeIo, { spawnDevTask: spawn });

      await dispatch({
        deliveryId: 'd1',
        event: 'issues',
        action: 'labeled',
        repository: 'owner/repo',
        payload: {
          action: 'labeled',
          label: { name: 'pm:ready' },
          issue: { number: 7, title: 'Login', body: 'desc', html_url: 'https://x/7' },
          repository: { full_name: 'owner/repo' },
        },
      });

      expect(spawn).toHaveBeenCalledTimes(1);
      const args = spawn.mock.calls[0][0];
      expect(args.featureId).toBe(feature.id);
      expect(args.issueNumber).toBe(7);
      expect(args.prompt).toContain('Login');

      const jobs = listJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].kind).toBe('dev-pickup');
      expect(jobs[0].state_key).toBe('dev-pickup:owner/repo#7');
      expect(jobs[0].status).toBe('completed');
    });

    it('does not spawn when label is not pm:ready', async () => {
      seedFeature();
      const spawn = vi.fn();
      const dispatch = createWebhookDispatcher(fakeIo, { spawnDevTask: spawn });
      await dispatch({
        deliveryId: 'd2',
        event: 'issues',
        action: 'labeled',
        repository: 'owner/repo',
        payload: { action: 'labeled', label: { name: 'documentation' }, issue: { number: 7 } },
      });
      expect(spawn).not.toHaveBeenCalled();
      expect(listJobs()).toHaveLength(0);
    });

    it('ignores PR labeling events (issue.pull_request present)', async () => {
      seedFeature();
      const spawn = vi.fn();
      const dispatch = createWebhookDispatcher(fakeIo, { spawnDevTask: spawn });
      await dispatch({
        deliveryId: 'd3',
        event: 'issues',
        action: 'labeled',
        repository: 'owner/repo',
        payload: {
          action: 'labeled',
          label: { name: 'pm:ready' },
          issue: { number: 7, pull_request: { url: '...' } },
        },
      });
      expect(spawn).not.toHaveBeenCalled();
    });

    it('ignores unknown issues with no marker (likely external)', async () => {
      seedFeature(); // feature has issue#7
      const spawn = vi.fn();
      const dispatch = createWebhookDispatcher(fakeIo, { spawnDevTask: spawn });
      await dispatch({
        deliveryId: 'd4',
        event: 'issues',
        action: 'labeled',
        repository: 'owner/repo',
        payload: {
          action: 'labeled',
          label: { name: 'pm:ready' },
          issue: { number: 999, body: 'unrelated' },
        },
      });
      expect(spawn).not.toHaveBeenCalled();
      expect(listJobs()).toHaveLength(0);
    });

    it('heals lost mapping via the body marker', async () => {
      const ws = workstreamStore.createWorkstream('owner/repo', 'orphan', 'ws');
      const feature = featureStore.createFeature({
        workstreamId: ws.id,
        name: 'X',
        slug: '01-x',
        kind: 'feature',
      });
      // Feature has NO githubIssueNumber persisted (simulating PM crash
      // between issue create and DB write).
      const spawn = vi.fn().mockResolvedValue({ taskId: 'task-2' });
      const dispatch = createWebhookDispatcher(fakeIo, { spawnDevTask: spawn });

      await dispatch({
        deliveryId: 'd5',
        event: 'issues',
        action: 'labeled',
        repository: 'owner/repo',
        payload: {
          action: 'labeled',
          label: { name: 'pm:ready' },
          issue: {
            number: 42,
            body: `<!-- liliput:feature-id=${feature.id} -->\n\nbody`,
            html_url: 'https://github.com/owner/repo/issues/42',
          },
        },
      });

      expect(spawn).toHaveBeenCalledTimes(1);
      // Mapping was healed.
      const healed = featureStore.getFeature(feature.id)!;
      expect(healed.githubIssueNumber).toBe(42);
      expect(healed.githubIssueUrl).toBe('https://github.com/owner/repo/issues/42');
    });

    it('is idempotent across duplicate deliveries (UNIQUE state_key)', async () => {
      seedFeature();
      const spawn = vi.fn().mockResolvedValue({ taskId: 'task-3' });
      const dispatch = createWebhookDispatcher(fakeIo, { spawnDevTask: spawn });

      const payload = {
        action: 'labeled',
        label: { name: 'pm:ready' },
        issue: { number: 7, title: 't', body: 'b', html_url: 'https://x/7' },
      };
      await dispatch({
        deliveryId: 'first',
        event: 'issues',
        action: 'labeled',
        repository: 'owner/repo',
        payload,
      });
      await dispatch({
        deliveryId: 'second',
        event: 'issues',
        action: 'labeled',
        repository: 'owner/repo',
        payload,
      });

      // Only spawned once — second call hit UNIQUE constraint on
      // `dev-pickup:owner/repo#7`.
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(listJobs()).toHaveLength(1);
    });
  });

  describe('pull_request events (RM stub)', () => {
    function seedFeatureWithPr() {
      const { ws, feature } = seedFeature();
      featureStore.updateFeature(feature.id, { githubPrNumber: 33 });
      return { ws, feature };
    }

    it('queues an rm-review job on labeled(rm:review) non-draft', async () => {
      seedFeatureWithPr();
      const spawn = vi.fn();
      const rm = vi.fn().mockResolvedValue({ action: 'merge' });
      const dispatch = createWebhookDispatcher(fakeIo, { spawnDevTask: spawn, runRmReview: rm });
      await dispatch({
        deliveryId: 'd6',
        event: 'pull_request',
        action: 'labeled',
        repository: 'owner/repo',
        payload: {
          action: 'labeled',
          label: { name: 'rm:review' },
          pull_request: {
            number: 33,
            draft: false,
            html_url: 'https://x/pr/33',
            head: { sha: 'abc123def456' },
          },
        },
      });
      const jobs = listJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].kind).toBe('rm-review');
      expect(jobs[0].state_key).toBe('rm-review:owner/repo#33@abc123def456');
      expect(jobs[0].status).toBe('completed');
      expect(rm).toHaveBeenCalledWith('owner/repo', 33);
      // No spawnDevTask call on RM events.
      expect(spawn).not.toHaveBeenCalled();
    });

    it('ignores labeled(rm:review) on draft PRs', async () => {
      seedFeatureWithPr();
      const dispatch = createWebhookDispatcher(fakeIo, {
        spawnDevTask: vi.fn(),
        runRmReview: vi.fn(),
      });
      await dispatch({
        deliveryId: 'd7',
        event: 'pull_request',
        action: 'labeled',
        repository: 'owner/repo',
        payload: {
          action: 'labeled',
          label: { name: 'rm:review' },
          pull_request: { number: 33, draft: true, head: { sha: 'aaa' } },
        },
      });
      expect(listJobs()).toHaveLength(0);
    });

    it('queues on ready_for_review even without explicit label', async () => {
      seedFeatureWithPr();
      const rm = vi.fn().mockResolvedValue({ action: 'merge' });
      const dispatch = createWebhookDispatcher(fakeIo, {
        spawnDevTask: vi.fn(),
        runRmReview: rm,
      });
      await dispatch({
        deliveryId: 'd8',
        event: 'pull_request',
        action: 'ready_for_review',
        repository: 'owner/repo',
        payload: {
          action: 'ready_for_review',
          pull_request: { number: 33, draft: false, head: { sha: 'bbb' } },
        },
      });
      expect(listJobs()).toHaveLength(1);
      expect(rm).toHaveBeenCalledWith('owner/repo', 33);
    });

    it('ignores synchronize on draft PRs', async () => {
      seedFeatureWithPr();
      const dispatch = createWebhookDispatcher(fakeIo, {
        spawnDevTask: vi.fn(),
        runRmReview: vi.fn(),
      });
      await dispatch({
        deliveryId: 'd9',
        event: 'pull_request',
        action: 'synchronize',
        repository: 'owner/repo',
        payload: {
          action: 'synchronize',
          pull_request: { number: 33, draft: true, head: { sha: 'ccc' } },
        },
      });
      expect(listJobs()).toHaveLength(0);
    });

    it('does nothing when PR cannot be mapped to a Feature', async () => {
      seedFeature(); // no PR mapping
      const dispatch = createWebhookDispatcher(fakeIo, {
        spawnDevTask: vi.fn(),
        runRmReview: vi.fn(),
      });
      await dispatch({
        deliveryId: 'd10',
        event: 'pull_request',
        action: 'labeled',
        repository: 'owner/repo',
        payload: {
          action: 'labeled',
          label: { name: 'rm:review' },
          pull_request: { number: 999, draft: false, head: { sha: 'ddd' } },
        },
      });
      expect(listJobs()).toHaveLength(0);
    });

    it('skips campaign-managed pull requests even if RM labels are present', async () => {
      seedFeatureWithPr();
      const task = taskStore.createTask(
        'Campaign delivery',
        'Autonomous delivery',
        'owner/repo',
        { campaignCycleId: 'campaign-cycle-1' },
      );
      taskStore.updateTask(task.id, { pullRequestNumber: 33 });
      const rm = vi.fn();
      const dispatch = createWebhookDispatcher(fakeIo, {
        spawnDevTask: vi.fn(),
        runRmReview: rm,
      });

      await dispatch({
        deliveryId: 'campaign-pr',
        event: 'pull_request',
        action: 'labeled',
        repository: 'owner/repo',
        payload: {
          action: 'labeled',
          label: { name: 'rm:review' },
          pull_request: {
            number: 33,
            draft: false,
            head: { sha: 'campaignsha' },
          },
        },
      });

      expect(rm).not.toHaveBeenCalled();
      expect(listJobs()).toHaveLength(0);
    });

    it('marks job failed when RM review throws', async () => {
      seedFeatureWithPr();
      const rm = vi.fn().mockRejectedValue(new Error('boom'));
      const dispatch = createWebhookDispatcher(fakeIo, {
        spawnDevTask: vi.fn(),
        runRmReview: rm,
      });
      await dispatch({
        deliveryId: 'd6b',
        event: 'pull_request',
        action: 'labeled',
        repository: 'owner/repo',
        payload: {
          action: 'labeled',
          label: { name: 'rm:review' },
          pull_request: { number: 33, draft: false, head: { sha: 'eee' } },
        },
      });
      const jobs = listJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].status).toBe('failed');
    });
  });

  describe('other events', () => {
    it('ignores events without a repository', async () => {
      const spawn = vi.fn();
      const dispatch = createWebhookDispatcher(fakeIo, { spawnDevTask: spawn });
      await dispatch({
        deliveryId: 'd11',
        event: 'issues',
        action: 'labeled',
        repository: undefined,
        payload: { action: 'labeled', label: { name: 'pm:ready' }, issue: { number: 7 } },
      });
      expect(spawn).not.toHaveBeenCalled();
    });

    it('is a no-op for unrelated events', async () => {
      const spawn = vi.fn();
      const dispatch = createWebhookDispatcher(fakeIo, { spawnDevTask: spawn });
      await dispatch({
        deliveryId: 'd12',
        event: 'star',
        action: 'created',
        repository: 'owner/repo',
        payload: {},
      });
      expect(spawn).not.toHaveBeenCalled();
      expect(listJobs()).toHaveLength(0);
    });
  });
});
