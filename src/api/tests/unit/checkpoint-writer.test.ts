import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CheckpointWriter } from '../../src/engine/checkpoint-writer.js';
import * as git from '../../src/engine/git-client.js';
import type { ToolEvent } from '../../src/engine/agent-loop.js';

function evt(tool: string | undefined, summary = ''): ToolEvent {
  return {
    callId: Math.random().toString(36).slice(2),
    kind: 'tool-complete',
    tool,
    summary,
    timestamp: new Date().toISOString(),
  };
}

const handle = { repo: 'o/r', branch: 'liliput/task-x', cwd: '/tmp/x' } as git.RepoHandle;

describe('CheckpointWriter', () => {
  let commitSpy: ReturnType<typeof vi.spyOn>;
  let pushSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    commitSpy = vi
      .spyOn(git, 'commitAllIfChanges')
      .mockResolvedValue('abcdef1234567890abcdef1234567890abcdef12');
    pushSpy = vi.spyOn(git, 'push').mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('debounces a burst of edits into one commit', async () => {
    const w = new CheckpointWriter({ handle, debounceMs: 1000, maxIntervalMs: 60_000 });
    w.observe(evt('edit'));
    w.observe(evt('create'));
    w.observe(evt('write'));
    expect(commitSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(commitSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  it('ignores non-mutating tools', async () => {
    const w = new CheckpointWriter({ handle, debounceMs: 1000 });
    w.observe(evt('view'));
    w.observe(evt('grep'));
    w.observe(evt(undefined, 'ok'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(commitSpy).not.toHaveBeenCalled();
  });

  it('skips push when working tree is clean', async () => {
    commitSpy.mockResolvedValueOnce(null);
    const w = new CheckpointWriter({ handle, debounceMs: 100 });
    w.observe(evt('edit'));
    await vi.advanceTimersByTimeAsync(100);
    expect(commitSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it('flush() forces an immediate final commit and stops further work', async () => {
    const w = new CheckpointWriter({ handle, debounceMs: 60_000 });
    w.observe(evt('edit'));
    await w.flush();
    expect(commitSpy).toHaveBeenCalledTimes(1);
    // Subsequent events are ignored after flush().
    w.observe(evt('edit'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(commitSpy).toHaveBeenCalledTimes(1);
  });

  it('swallows commit errors as warnings (never throws)', async () => {
    commitSpy.mockRejectedValueOnce(new Error('disk full'));
    const warnings: string[] = [];
    const w = new CheckpointWriter({
      handle,
      debounceMs: 100,
      onLog: (level, msg) => {
        if (level === 'warn') warnings.push(msg);
      },
    });
    w.observe(evt('edit'));
    await vi.advanceTimersByTimeAsync(100);
    expect(warnings.some((m) => m.includes('disk full'))).toBe(true);
  });

  it('forces a checkpoint after maxIntervalMs even if events keep arriving', async () => {
    const w = new CheckpointWriter({ handle, debounceMs: 10_000, maxIntervalMs: 5_000 });
    w.observe(evt('edit'));
    // Each subsequent edit before maxInterval would normally reset the
    // debounce — but once 5s have passed since the first pending event, the
    // next observe should fire immediately.
    await vi.advanceTimersByTimeAsync(4000);
    w.observe(evt('edit'));
    await vi.advanceTimersByTimeAsync(2000);
    w.observe(evt('edit')); // now > maxIntervalMs since first pending event
    await vi.advanceTimersByTimeAsync(0);
    expect(commitSpy).toHaveBeenCalled();
  });
});
