'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import Link from 'next/link';
import { useTasks } from '../../hooks/useTasks';
import { useSocket } from '../../hooks/useSocket';
import type { Task, TaskStatus } from '@shared/types';

interface PodInfo {
  name: string;
  phase: string;
  ready: boolean;
  restarts: number;
  containers: string[];
  startedAt: string | null;
  reason: string | null;
  message: string | null;
}

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
  const [open, setOpen] = useState(false);
  const [pods, setPods] = useState<PodInfo[] | null>(null);
  const [podsErr, setPodsErr] = useState<string | null>(null);
  const [selectedPod, setSelectedPod] = useState<string | null>(null);
  const [logs, setLogs] = useState<string>('');
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsErr, setLogsErr] = useState<string | null>(null);
  const [previous, setPrevious] = useState(false);

  const loadPods = useCallback(async () => {
    if (!task.devNamespace) return;
    try {
      setPodsErr(null);
      const r = await fetch(`/api/tasks/${task.id}/dev-pods`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const list: PodInfo[] = data.pods ?? [];
      setPods(list);
      if (list.length > 0 && !selectedPod) setSelectedPod(list[0]!.name);
    } catch (e) {
      setPodsErr(e instanceof Error ? e.message : String(e));
    }
  }, [task.id, task.devNamespace, selectedPod]);

  const loadLogs = useCallback(async (pod: string, prev: boolean) => {
    setLogsLoading(true);
    setLogsErr(null);
    try {
      const params = new URLSearchParams({ pod, tail: '500' });
      if (prev) params.set('previous', '1');
      const r = await fetch(`/api/tasks/${task.id}/dev-logs?${params}`);
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.details ?? err.error ?? `HTTP ${r.status}`);
      }
      const data = await r.json();
      setLogs(data.logs ?? '(no output)');
    } catch (e) {
      setLogsErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLogsLoading(false);
    }
  }, [task.id]);

  useEffect(() => {
    if (open && task.devNamespace) void loadPods();
  }, [open, task.devNamespace, loadPods]);

  useEffect(() => {
    if (open && selectedPod) void loadLogs(selectedPod, previous);
  }, [open, selectedPod, previous, loadLogs]);

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
        {task.devNamespace && (
          <button
            onClick={() => setOpen((v) => !v)}
            className="px-2 py-1 bg-yellow-600/20 hover:bg-yellow-600/40 border border-yellow-500/40 rounded text-yellow-200"
          >
            {open ? '▼ Hide pods/logs' : '▶ Pods & logs'}
          </button>
        )}
      </div>

      {open && task.devNamespace && (
        <div className="mt-3 border-t border-[#1a1a2e] pt-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-gray-400">Pods in {task.devNamespace}</span>
            <button
              onClick={() => void loadPods()}
              className="text-[10px] text-cyan-400 hover:text-cyan-200"
            >
              ↻ refresh
            </button>
          </div>
          {podsErr && (
            <div className="text-[11px] text-red-400">Failed: {podsErr}</div>
          )}
          {pods === null ? (
            <div className="text-[11px] text-gray-500">Loading pods…</div>
          ) : pods.length === 0 ? (
            <div className="text-[11px] text-gray-500">No pods in namespace.</div>
          ) : (
            <div className="space-y-1">
              {pods.map((p) => {
                const phaseColor =
                  p.phase === 'Running' && p.ready ? 'text-green-400'
                  : p.phase === 'Pending' || (p.phase === 'Running' && !p.ready) ? 'text-yellow-400'
                  : p.phase === 'Failed' || p.reason ? 'text-red-400'
                  : 'text-gray-400';
                return (
                  <button
                    key={p.name}
                    onClick={() => setSelectedPod(p.name)}
                    className={`w-full text-left px-2 py-1 rounded border text-[11px] ${
                      selectedPod === p.name
                        ? 'border-cyan-500/60 bg-cyan-500/10'
                        : 'border-[#1a1a2e] hover:border-gray-600'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <code className="text-gray-300 truncate">{p.name}</code>
                      <span className={`shrink-0 ${phaseColor}`}>
                        {p.phase}{p.ready ? ' • ready' : ''}{p.restarts > 0 ? ` • ${p.restarts} restart${p.restarts === 1 ? '' : 's'}` : ''}
                      </span>
                    </div>
                    {p.reason && (
                      <div className="text-red-300 text-[10px] mt-0.5 truncate" title={p.message ?? p.reason}>
                        {p.reason}{p.message ? `: ${p.message}` : ''}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {selectedPod && (
            <div className="mt-2 space-y-1">
              <div className="flex items-center gap-3 text-[11px]">
                <span className="text-gray-400">Logs: <code className="text-cyan-300">{selectedPod}</code></span>
                <label className="flex items-center gap-1 text-gray-500">
                  <input
                    type="checkbox"
                    checked={previous}
                    onChange={(e) => setPrevious(e.target.checked)}
                    className="accent-cyan-500"
                  />
                  previous container
                </label>
                <button
                  onClick={() => void loadLogs(selectedPod, previous)}
                  className="text-cyan-400 hover:text-cyan-200"
                >
                  ↻ refresh
                </button>
              </div>
              {logsErr && (
                <div className="text-[11px] text-red-400">Failed: {logsErr}</div>
              )}
              <pre className="bg-black/60 border border-[#1a1a2e] rounded p-2 text-[10px] text-gray-300 overflow-auto max-h-80 whitespace-pre-wrap">
                {logsLoading ? 'Loading logs…' : (logs || '(empty)')}
              </pre>
            </div>
          )}
        </div>
      )}
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
