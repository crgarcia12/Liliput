'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import Link from 'next/link';
import { useTasks } from '../../hooks/useTasks';
import { useSocket } from '../../hooks/useSocket';
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

export default function DevEnvironmentsPage() {
  const { connected } = useSocket();
  const { getTasks } = useTasks();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await getTasks();
      setTasks(res ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [getTasks]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const envs = useMemo(
    () =>
      tasks
        .filter((t) => Boolean(t.devNamespace || t.devUrl))
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')),
    [tasks],
  );

  const byRepo = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of envs) {
      const key = t.repository ?? 'unknown';
      const arr = map.get(key) ?? [];
      arr.push(t);
      map.set(key, arr);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [envs]);

  return (
    <div className="min-h-screen bg-[#050510] text-gray-200 font-mono">
      <header className="flex items-center justify-between px-6 py-3 border-b border-[#1a1a2e] bg-[#0d0d14]">
        <div className="flex items-center gap-3">
          <span className="text-2xl">☁️</span>
          <h1 className="text-lg font-bold tracking-tight">
            <span className="text-cyan-400">Liliput</span>
            <span className="text-gray-500 font-normal"> — Dev Environments</span>
          </h1>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <Link href="/" className="text-gray-400 hover:text-cyan-300">🏰 Home</Link>
          <Link href="/requests" className="text-gray-400 hover:text-cyan-300">📋 Requests</Link>
          <span className={connected ? 'text-green-400' : 'text-red-400'}>
            {connected ? '● Connected' : '○ Disconnected'}
          </span>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-6 space-y-6">
        <section className="bg-[#0d0d14] border border-[#1a1a2e] rounded-lg p-4">
          <h2 className="text-sm font-semibold text-gray-300 mb-2">
            What's running on the cluster
          </h2>
          <p className="text-xs text-gray-500 leading-relaxed">
            Each task that builds successfully gets its own preview environment in AKS:
            a Kubernetes namespace, a deployment running the freshly-built image, and
            a public URL routed through the gateway. These environments live independently
            of the agent pod — restarting <code className="text-cyan-400">liliput-api</code> doesn&apos;t
            touch them. Click a task title to chat with the agent that owns it (the session
            will be resurrected if it was lost).
          </p>
        </section>

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-sm text-red-300">
            {error}
          </div>
        )}

        {loading && envs.length === 0 ? (
          <div className="text-gray-500 text-sm">Loading…</div>
        ) : envs.length === 0 ? (
          <div className="text-gray-500 text-sm border border-[#1a1a2e] rounded-lg p-6 text-center">
            No dev environments yet. Deployed previews will show up here.
          </div>
        ) : (
          byRepo.map(([repo, repoEnvs]) => (
            <section key={repo} className="space-y-3">
              <h2 className="text-sm font-semibold text-cyan-300 flex items-center gap-2">
                <span>📦</span>
                <span>{repo}</span>
                <span className="text-gray-500 font-normal">
                  ({repoEnvs.length} env{repoEnvs.length === 1 ? '' : 's'})
                </span>
              </h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {repoEnvs.map((t) => (
                  <DevEnvCard key={t.id} task={t} />
                ))}
              </div>
            </section>
          ))
        )}
      </main>
    </div>
  );
}

function DevEnvCard({ task }: { task: Task }) {
  const style = STATUS_STYLES[task.status];

  return (
    <div className="bg-[#0d0d14] border border-[#1a1a2e] rounded-lg p-4 hover:border-cyan-500/40 transition-colors">
      <div className="flex items-start justify-between gap-3 mb-3">
        <Link
          href={`/task/${task.id}`}
          className="text-sm font-semibold text-gray-100 hover:text-cyan-300 line-clamp-2 flex-1"
        >
          {task.title}
        </Link>
        <span
          className={`shrink-0 text-[10px] px-2 py-0.5 rounded-full border ${style.cls}`}
        >
          {style.label}
        </span>
      </div>

      <div className="mb-3 text-[10px] text-gray-500 space-y-1.5 border-l-2 border-cyan-500/20 pl-3">
        <Row icon="🌐" label="URL">
          {task.devUrl ? (
            <a
              href={task.devUrl}
              target="_blank"
              rel="noreferrer"
              className="text-cyan-300 hover:underline break-all"
            >
              {task.devUrl}
            </a>
          ) : (
            <span className="text-gray-600">—</span>
          )}
        </Row>
        <Row icon="📦" label="Namespace">
          {task.devNamespace ? (
            <code className="text-amber-300 break-all">{task.devNamespace}</code>
          ) : (
            <span className="text-gray-600">—</span>
          )}
        </Row>
        <Row icon="🐳" label="Image">
          {task.imageRef ? (
            <code className="text-purple-300 break-all">{task.imageRef}</code>
          ) : (
            <span className="text-gray-600">—</span>
          )}
        </Row>
        <Row icon="🌿" label="Branch">
          {task.branch ? (
            <code className="text-green-300">{task.branch}</code>
          ) : (
            <span className="text-gray-600">—</span>
          )}
          {task.commitSha && (
            <span className="text-gray-600 ml-2">@ {task.commitSha.substring(0, 7)}</span>
          )}
        </Row>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        {task.devUrl && (
          <a
            href={task.devUrl}
            target="_blank"
            rel="noreferrer"
            className="px-2 py-1 bg-cyan-600/20 hover:bg-cyan-600/40 border border-cyan-500/40 rounded text-cyan-200"
          >
            🔗 Open preview
          </a>
        )}
        {task.pullRequestUrl && (
          <a
            href={task.pullRequestUrl}
            target="_blank"
            rel="noreferrer"
            className="px-2 py-1 bg-purple-600/20 hover:bg-purple-600/40 border border-purple-500/40 rounded text-purple-200"
          >
            🔀 PR{task.pullRequestNumber ? ` #${task.pullRequestNumber}` : ''}
          </a>
        )}
        <Link
          href={`/task/${task.id}`}
          className="px-2 py-1 bg-gray-600/20 hover:bg-gray-600/40 border border-gray-500/40 rounded text-gray-200"
        >
          💬 Chat
        </Link>
      </div>
    </div>
  );
}

function Row({
  icon,
  label,
  children,
}: {
  icon: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="shrink-0 w-3">{icon}</span>
      <span className="shrink-0 w-16 text-gray-500">{label}</span>
      <span className="flex-1 min-w-0">{children}</span>
    </div>
  );
}
