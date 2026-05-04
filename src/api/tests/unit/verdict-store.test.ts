import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordVerdict,
  captureFromText,
  listVerdicts,
  latestVerdictForTask,
} from '../../src/stores/verdict-store.js';
import { resetStore, createTask } from '../../src/stores/task-store.js';

beforeEach(() => {
  resetStore();
});

describe('verdict-store', () => {
  it('records a verdict and lists it back', () => {
    const t = createTask({ title: 'T', description: 'D' });
    const v = recordVerdict(t.id, 'agent-1', 'done', 'all green', 'VERDICT: done — all green');
    expect(v?.status).toBe('done');
    expect(v?.reason).toBe('all green');
    expect(listVerdicts()).toHaveLength(1);
    expect(listVerdicts(t.id)).toHaveLength(1);
  });

  it('dedupes within the same minute for the same (task, agent, status)', () => {
    const t = createTask({ title: 'T', description: 'D' });
    expect(recordVerdict(t.id, 'a1', 'continue', 'still iterating', null)).not.toBeNull();
    expect(recordVerdict(t.id, 'a1', 'continue', 'still iterating', null)).toBeNull();
    expect(listVerdicts(t.id)).toHaveLength(1);
  });

  it('does NOT dedupe across different statuses', () => {
    const t = createTask({ title: 'T', description: 'D' });
    recordVerdict(t.id, 'a1', 'continue', null, null);
    recordVerdict(t.id, 'a1', 'done', null, null);
    expect(listVerdicts(t.id)).toHaveLength(2);
  });

  it('captureFromText parses and records', () => {
    const t = createTask({ title: 'T', description: 'D' });
    const v = captureFromText(t.id, 'a1', 'doing stuff\nVERDICT: blocked — no creds');
    expect(v?.status).toBe('blocked');
    expect(v?.reason).toContain('no creds');
  });

  it('captureFromText returns null on text without a verdict', () => {
    const t = createTask({ title: 'T', description: 'D' });
    expect(captureFromText(t.id, 'a1', 'just thinking out loud')).toBeNull();
    expect(listVerdicts(t.id)).toHaveLength(0);
  });

  it('captureFromText keeps only the LAST verdict in a stream', () => {
    const t = createTask({ title: 'T', description: 'D' });
    captureFromText(
      t.id,
      'a1',
      'VERDICT: continue\n... work ...\nVERDICT: done — finished',
    );
    const list = listVerdicts(t.id);
    expect(list).toHaveLength(1);
    expect(list[0]?.status).toBe('done');
  });

  it('latestVerdictForTask returns the newest', () => {
    const t = createTask({ title: 'T', description: 'D' });
    recordVerdict(t.id, 'a1', 'continue', null, null);
    // Wait one minute? No — fake-out by directly writing different status
    // (the store dedupes only on status+minute, so different status is fine).
    recordVerdict(t.id, 'a1', 'done', 'wrap up', null);
    expect(latestVerdictForTask(t.id)?.status).toBe('done');
  });

  it('latestVerdictForTask returns undefined when no verdicts', () => {
    const t = createTask({ title: 'T', description: 'D' });
    expect(latestVerdictForTask(t.id)).toBeUndefined();
  });

  it('isolates verdicts per task', () => {
    const t1 = createTask({ title: 'T1', description: 'D' });
    const t2 = createTask({ title: 'T2', description: 'D' });
    recordVerdict(t1.id, null, 'done', null, null);
    recordVerdict(t2.id, null, 'continue', null, null);
    expect(listVerdicts(t1.id)).toHaveLength(1);
    expect(listVerdicts(t2.id)).toHaveLength(1);
    expect(listVerdicts()).toHaveLength(2);
  });
});
