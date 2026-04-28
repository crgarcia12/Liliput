'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import Link from 'next/link';
import { useSocket } from '../../hooks/useSocket';
import { useTasks } from '../../hooks/useTasks';
import type { Task, TaskStatus } from '@shared/types';

const STATUS_STYLES: Record<TaskStatus, { label: string; cls: string }> = {
  clarifying:  { label: 'Clarifying',  cls: 'bg-blue-500/15 text-blue-300 border-blue-500/30' },
  specifying:  { label: 'Specifying',  cls: 'bg-blue-500/15 text-blue-300 border-blue-500/30' },
  building:    { label: 'Building',    cls: 'bg-yellow-500/15 text-yellow-300 border-yellow-500/30' },
  deploying:   { label: 'Deploying',   cls: 'bg-yellow-500/15 text-yellow-300 border-yellow-500/30' },
  review:      { label: 'Review',      cls: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30' },
  shipping:    { label: 'Shipping',    cls: 'bg-purple-500/15 text-purple-300 border-purple-500/30' },
  completed:   { label: 'Completed',   cls: 'bg-green-500/15 text-green-300 border-green-500/30' },
  discarded:   { label: 'Discarded',   cls: 'bg-gray-500/15 text-gray-400 border-gray-500/30' },
  failed:      { label: 'Failed',      cls: 'bg-red-500/15 text-red-300 border-red-500/30' },
};

const ACTIVE_STATUSES: TaskStatus[] = [
  'clarifying',
  'specifying',
  'building',
  'deploying',
  'review',
  'shipping',
];

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export default function RequestsPage() {
  const { connected } = useSocket();
  const { getTasks } = useTasks();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async () => {
    try {
      const list = await getTasks();
      setTasks(list);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load requests');
    } finally {
      setLoading(false);
    }
  }, [getTasks]);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  // Tick once per minute so "5m ago" labels stay fresh.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const grouped = useMemo(() => {
    const filtered = showInactive
      ? tasks
      : tasks.filter((t) => ACTIVE_STATUSES.includes(t.status));
    const byRepo = new Map<string, Task[]>();
    for (const t of filtered) {
      const repo = t.repository ?? '(no repo)';
      const arr = byRepo.get(repo) ?? [];
      arr.push(t);
      byRepo.set(repo, arr);
    }
    for (const arr of byRepo.values()) {
      arr.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    return Array.from(byRepo.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [tasks, showInactive]);

  const activeCount = tasks.filter((t) => ACTIVE_STATUSES.includes(t.status)).length;

  return (
    <div className="flex flex-col h-screen">
      <header className="flex items-center justify-between px-6 py-3 border-b border-[#1a1a2e] bg-[#0d0d14]">
        <div className="flex items-center gap-3">
          <span className="text-2xl">🏰</span>
          <h1 className="text-lg font-bold tracking-tight">
            <Link href="/" className="text-cyan-400 hover:text-cyan-300">Liliput</Link>
            <span className="text-gray-500 font-normal"> — Requests</span>
          </h1>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <span className={connected ? 'text-green-400' : 'text-red-400'}>
            {connected ? '● Connected' : '○ Disconnected'}
          </span>
          <Link
            href="/"
            className="px-3 py-1 bg-cyan-600 hover:bg-cyan-500 text-white rounded text-xs font-semibold"
          >
            + New request
          </Link>
        </div>
      </header>

      <div className="px-6 py-3 border-b border-[#1a1a2e] bg-[#0d0d14] flex items-center gap-4 text-xs">
        <span className="text-gray-400">
          {activeCount} active · {tasks.length} total · {grouped.length} repo{grouped.length === 1 ? '' : 's'}
        </span>
        <label className="flex items-center gap-2 text-gray-400 cursor-pointer">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
            className="accent-cyan-500"
          />
          Show completed / discarded / failed
        </label>
        <span className="ml-auto text-gray-600">Auto-refreshes every 5s</span>
      </div>

      <main className="flex-1 overflow-y-auto px-6 py-4">
        {loading && (
          <div className="text-gray-500 text-sm">Loading requests…</div>
        )}
        {error && (
          <div className="text-red-400 text-sm border border-red-500/30 bg-red-500/10 rounded px-3 py-2">
            {error}
          </div>
        )}
        {!loading && !error && grouped.length === 0 && (
          <div className="text-gray-500 text-sm">
            No {showInactive ? '' : 'active '}requests yet.{' '}
            <Link href="/" className="text-cyan-400 hover:text-cyan-300">Create one →</Link>
          </div>
        )}

        <div className="space-y-6">
          {grouped.map(([repo, repoTasks]) => (
            <section key={repo}>
              <h2 className="text-sm font-semibold text-gray-300 mb-2 flex items-center gap-2">
                <span className="text-cyan-400">📁</span>
                <span>{repo}</span>
                <span className="text-gray-600 font-normal">
                  · {repoTasks.length} request{repoTasks.length === 1 ? '' : 's'}
                </span>
              </h2>
              <ul className="space-y-2">
                {repoTasks.map((t) => (
                  <li key={t.id}>
                    <RequestCard task={t} now={now} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}

function RequestCard({ task, now }: { task: Task; now: number }) {
  void now; // re-render trigger for relative timestamps
  const style = STATUS_STYLES[task.status];
  return (
    <Link
      href={`/task/${task.id}`}
      className="block bg-[#0d0d14] border border-[#1a1a2e] rounded-lg p-3 hover:border-cyan-500/50 hover:bg-[#10101a] transition"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span
              className={`px-2 py-0.5 text-[10px] uppercase tracking-wide border rounded ${style.cls}`}
            >
              {style.label}
            </span>
            {task.branch && (
              <span className="text-[10px] text-gray-500 font-mono truncate">
                ⎇ {task.branch}
              </span>
            )}
            {task.pullRequestNumber !== undefined && (
              <span className="text-[10px] text-purple-300 font-mono">
                #{task.pullRequestNumber}
              </span>
            )}
          </div>
          <div className="text-sm text-gray-100 font-medium truncate">{task.title}</div>
          {task.description && task.description !== task.title && (
            <div className="text-xs text-gray-500 truncate mt-0.5">{task.description}</div>
          )}
        </div>
        <div className="text-right text-[10px] text-gray-500 shrink-0">
          <div>updated {formatRelative(task.updatedAt)}</div>
          <div className="text-gray-600">created {formatRelative(task.createdAt)}</div>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px]">
        {task.devUrl && (
          <a
            href={task.devUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-cyan-400 hover:text-cyan-300"
          >
            🌐 Preview
          </a>
        )}
        {task.pullRequestUrl && (
          <a
            href={task.pullRequestUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-purple-300 hover:text-purple-200"
          >
            🔗 PR
          </a>
        )}
        {task.commitSha && (
          <span className="text-gray-500 font-mono">{task.commitSha.substring(0, 7)}</span>
        )}
        {task.agents && task.agents.length > 0 && (
          <span className="text-gray-500">
            {task.agents.length} agent{task.agents.length === 1 ? '' : 's'}
          </span>
        )}
        {task.errorMessage && (
          <span className="text-red-400 truncate">⚠ {task.errorMessage}</span>
        )}
      </div>
    </Link>
  );
}
