'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTasks } from '../../hooks/useTasks';
import PhaseStepper from '../../components/PhaseStepper';
import type { Task } from '@shared/types';

/**
 * "What's running right now" dashboard.
 *
 * Filters tasks to active phases and ranks by elapsed-in-current-phase
 * (longest-running first) so the user can spot stuck work at a glance.
 *
 * Polls every 4s — same cadence as the rest of the UI.
 */

const ACTIVE_STATUSES = new Set([
  'clarifying',
  'specifying',
  'building',
  'deploying',
  'shipping',
  'review',
]);

function elapsedMs(task: Task): number {
  const workingStart = task.agents
    .filter((a) => a.status === 'working' && a.startedAt)
    .map((a) => new Date(a.startedAt!).getTime())
    .sort((a, b) => a - b)[0];
  const ref = workingStart ?? new Date(task.updatedAt).getTime();
  return Date.now() - ref;
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export default function NowPage() {
  const { getTasks } = useTasks();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [, force] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const data = await getTasks();
        if (!cancelled) {
          setTasks(data);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    tick();
    const poll = setInterval(tick, 4000);
    const ticker = setInterval(() => force((x) => x + 1), 1000);
    return () => {
      cancelled = true;
      clearInterval(poll);
      clearInterval(ticker);
    };
  }, [getTasks]);

  const active = tasks
    .filter((t) => ACTIVE_STATUSES.has(t.status))
    .sort((a, b) => elapsedMs(b) - elapsedMs(a));

  return (
    <div className="min-h-screen bg-[#050510] text-gray-200 p-6">
      <header className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-gray-500 hover:text-gray-300 text-sm">
            ← Home
          </Link>
          <span className="text-gray-600">|</span>
          <h1 className="text-xl font-bold">
            <span className="text-cyan-400">⏱ Now</span>
            <span className="text-gray-500 ml-2 text-sm font-normal">
              ({active.length} active)
            </span>
          </h1>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <Link href="/requests" className="text-gray-400 hover:text-gray-200">
            All requests →
          </Link>
        </div>
      </header>

      {loading && <p className="text-gray-500">Loading…</p>}
      {error && (
        <p className="text-red-400 text-sm">Failed to load tasks: {error}</p>
      )}
      {!loading && !error && active.length === 0 && (
        <div className="text-center py-16 text-gray-500">
          <div className="text-5xl mb-4">😴</div>
          <p>No active work right now.</p>
          <Link
            href="/"
            className="inline-block mt-4 text-cyan-400 hover:text-cyan-300 text-sm"
          >
            Start a new task →
          </Link>
        </div>
      )}

      <div className="space-y-3">
        {active.map((task) => {
          const elapsed = elapsedMs(task);
          const isStalled = elapsed > 5 * 60 * 1000;
          const workingAgent = task.agents.find((a) => a.status === 'working');
          return (
            <Link
              key={task.id}
              href={`/task/${task.id}`}
              className={`block rounded-lg border p-4 hover:bg-[#0a0a14] transition ${
                isStalled
                  ? 'border-yellow-800/60 bg-yellow-950/10'
                  : 'border-[#1a1a2e] bg-[#0d0d14]'
              }`}
            >
              <div className="flex items-center justify-between mb-2 gap-3">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <span className="text-cyan-400 font-medium truncate">
                    {task.title}
                  </span>
                  {task.repository && (
                    <span className="text-xs text-gray-500 font-mono truncate">
                      📦 {task.repository}
                    </span>
                  )}
                </div>
                <div className="text-xs text-gray-400 whitespace-nowrap">
                  {isStalled && <span className="text-yellow-400 mr-2">⚠ stalled</span>}
                  ⏱ {fmtElapsed(elapsed)}
                </div>
              </div>
              <PhaseStepper task={task} agents={task.agents} />
              {workingAgent?.currentAction && (
                <p className="mt-2 text-xs text-gray-400 truncate">
                  <span className="text-gray-500">{workingAgent.name}:</span>{' '}
                  {workingAgent.currentAction}
                  {typeof workingAgent.toolCallCount === 'number' &&
                    workingAgent.toolCallCount > 0 && (
                      <span className="ml-2 text-gray-600">
                        · 🔧 {workingAgent.toolCallCount}
                      </span>
                    )}
                </p>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
