'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import Link from 'next/link';
import TopBar from '../../components/TopBar';
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
  deleting:    { label: 'Deleting',    cls: 'bg-gray-500/15 text-gray-400 border-gray-500/30' },
};

type ViewMode = 'card' | 'list';

export default function DevEnvironmentsPage() {
  const { connected } = useSocket();
  const { getTasks } = useTasks();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>('card');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

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

  // Drop selections for tasks that no longer exist or are already deleted.
  useEffect(() => {
    setSelected((prev) => {
      const validIds = new Set(
        envs.filter((t) => (t.devEnvState ?? 'active') !== 'deleted').map((t) => t.id),
      );
      const next = new Set<string>();
      for (const id of prev) {
        if (validIds.has(id)) next.add(id);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [envs]);

  const toggleOne = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const deletableEnvs = useMemo(
    () => envs.filter((t) => (t.devEnvState ?? 'active') !== 'deleted'),
    [envs],
  );

  const allSelected = deletableEnvs.length > 0 && selected.size === deletableEnvs.length;

  const toggleAll = useCallback(() => {
    setSelected((prev) =>
      prev.size === deletableEnvs.length ? new Set() : new Set(deletableEnvs.map((t) => t.id)),
    );
  }, [deletableEnvs]);

  const bulkDelete = useCallback(async () => {
    if (selected.size === 0) return;
    const ids = Array.from(selected);
    if (
      !confirm(
        `Delete ${ids.length} dev environment${ids.length === 1 ? '' : 's'}?\n\nThis removes the k8s deployment and route for each. Images stay in ACR — chat will recreate them.`,
      )
    ) {
      return;
    }
    setBulkDeleting(true);
    setBulkError(null);
    try {
      const response = await fetch('/api/tasks/dev-env/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskIds: ids }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.details ?? err.error ?? `HTTP ${response.status}`);
      }
      const result = (await response.json()) as {
        failures?: Array<{ taskId: string; error: string }>;
      };
      if (result.failures && result.failures.length > 0) {
        setBulkError(
          `${result.failures.length} of ${ids.length} deletions failed: ${result.failures[0]?.error ?? 'unknown error'}`,
        );
      }
      setSelected(new Set());
      await refresh();
    } finally {
      setBulkDeleting(false);
    }
  }, [selected, refresh]);

  return (
    <div className="min-h-screen bg-[#050510] text-gray-200 font-mono">
      <TopBar subtitle="Dev environments" connected={connected} />

      <main className="max-w-6xl mx-auto px-6 py-6 space-y-6">
        <section className="bg-[#0d0d14] border border-[#1a1a2e] rounded-lg p-4">
          <div className="flex items-start justify-between gap-3 mb-2">
            <h2 className="text-sm font-semibold text-gray-300">
              What&apos;s running on the cluster
            </h2>
            <div className="shrink-0 flex items-center gap-1 bg-black/30 border border-[#1a1a2e] rounded-lg p-0.5">
              <button
                onClick={() => setView('card')}
                className={`px-2 py-1 rounded text-[11px] ${
                  view === 'card'
                    ? 'bg-cyan-600/30 text-cyan-200 border border-cyan-500/40'
                    : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                ▦ Cards
              </button>
              <button
                onClick={() => setView('list')}
                className={`px-2 py-1 rounded text-[11px] ${
                  view === 'list'
                    ? 'bg-cyan-600/30 text-cyan-200 border border-cyan-500/40'
                    : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                ☰ List
              </button>
            </div>
          </div>
          <p className="text-xs text-gray-500 leading-relaxed">
            Each task that builds successfully gets its own preview environment in AKS:
            a Kubernetes namespace, a deployment running the freshly-built image, and
            a public URL routed through the gateway. These environments live independently
            of the agent pod — restarting <code className="text-cyan-400">liliput-api</code> doesn&apos;t
            touch them. Click a task title to chat with the agent that owns it (the session
            will be resurrected if it was lost). Use the List view to select multiple
            environments and delete them together.
          </p>
        </section>

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-sm text-red-300">
            {error}
          </div>
        )}

        {view === 'list' && selected.size > 0 && (
          <div className="sticky top-0 z-10 flex items-center justify-between gap-3 bg-cyan-950/40 border border-cyan-500/40 rounded-lg px-4 py-2">
            <span className="text-xs text-cyan-200">
              {selected.size} environment{selected.size === 1 ? '' : 's'} selected
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setSelected(new Set())}
                className="px-2 py-1 text-[11px] text-gray-400 hover:text-gray-200"
              >
                Clear
              </button>
              <button
                onClick={() => void bulkDelete()}
                disabled={bulkDeleting}
                className="px-3 py-1 bg-red-600/30 hover:bg-red-600/50 border border-red-500/50 rounded text-[11px] text-red-200 disabled:opacity-50"
              >
                {bulkDeleting ? '⏳ Deleting…' : `🗑 Delete selected (${selected.size})`}
              </button>
            </div>
          </div>
        )}

        {bulkError && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-sm text-red-300">
            {bulkError}
          </div>
        )}

        {loading && envs.length === 0 ? (
          <div className="text-gray-500 text-sm">Loading…</div>
        ) : envs.length === 0 ? (
          <div className="text-gray-500 text-sm border border-[#1a1a2e] rounded-lg p-6 text-center">
            No dev environments yet. Deployed previews will show up here.
          </div>
        ) : view === 'list' ? (
          <DevEnvTable
            envs={envs}
            selected={selected}
            onToggleOne={toggleOne}
            onToggleAll={toggleAll}
            allSelected={allSelected}
            deletableCount={deletableEnvs.length}
          />
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

function DevEnvTable({
  envs,
  selected,
  onToggleOne,
  onToggleAll,
  allSelected,
  deletableCount,
}: {
  envs: Task[];
  selected: Set<string>;
  onToggleOne: (id: string) => void;
  onToggleAll: () => void;
  allSelected: boolean;
  deletableCount: number;
}) {
  return (
    <div className="border border-[#1a1a2e] rounded-lg overflow-hidden">
      <table className="w-full text-[11px]">
        <thead className="bg-[#0d0d14] text-gray-500">
          <tr>
            <th className="w-8 px-3 py-2 text-left">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={onToggleAll}
                disabled={deletableCount === 0}
                className="accent-cyan-500"
                aria-label="Select all"
              />
            </th>
            <th className="px-3 py-2 text-left">Task</th>
            <th className="px-3 py-2 text-left">Repository</th>
            <th className="px-3 py-2 text-left">Status</th>
            <th className="px-3 py-2 text-left">Namespace</th>
            <th className="px-3 py-2 text-left">Branch</th>
            <th className="px-3 py-2 text-left">URL</th>
            <th className="px-3 py-2 text-left">Updated</th>
          </tr>
        </thead>
        <tbody>
          {envs.map((t) => {
            const style = STATUS_STYLES[t.status];
            const devEnvState = t.devEnvState ?? 'active';
            const deleted = devEnvState === 'deleted';
            return (
              <tr
                key={t.id}
                className={`border-t border-[#1a1a2e] ${
                  selected.has(t.id) ? 'bg-cyan-500/5' : 'hover:bg-white/[0.02]'
                }`}
              >
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    checked={selected.has(t.id)}
                    onChange={() => onToggleOne(t.id)}
                    disabled={deleted}
                    className="accent-cyan-500"
                    aria-label={`Select ${t.title}`}
                  />
                </td>
                <td className="px-3 py-2">
                  <Link href={`/task/${t.id}`} className="text-gray-100 hover:text-cyan-300">
                    {t.title}
                  </Link>
                </td>
                <td className="px-3 py-2 text-gray-400">{t.repository ?? '—'}</td>
                <td className="px-3 py-2">
                  <span className={`text-[10px] px-2 py-0.5 rounded-full border ${style.cls}`}>
                    {style.label}
                  </span>
                  {devEnvState !== 'active' && (
                    <span
                      className={`ml-1 text-[10px] px-2 py-0.5 rounded-full border ${
                        deleted
                          ? 'bg-red-500/15 text-red-300 border-red-500/30'
                          : 'bg-gray-500/15 text-gray-300 border-gray-500/30'
                      }`}
                    >
                      {deleted ? '🗑 Deleted' : '⏸ Stopped'}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {t.devNamespace ? (
                    <code className="text-amber-300">{t.devNamespace}</code>
                  ) : (
                    <span className="text-gray-600">—</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {t.branch ? <code className="text-green-300">{t.branch}</code> : <span className="text-gray-600">—</span>}
                </td>
                <td className="px-3 py-2 max-w-[220px]">
                  {t.devUrl ? (
                    <a
                      href={t.devUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-cyan-300 hover:underline truncate block"
                      title={t.devUrl}
                    >
                      {t.devUrl}
                    </a>
                  ) : (
                    <span className="text-gray-600">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-gray-500 whitespace-nowrap">
                  {t.updatedAt ? new Date(t.updatedAt).toLocaleString() : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
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
  const [lifecycleBusy, setLifecycleBusy] = useState<null | 'stop' | 'start' | 'delete'>(null);
  const [lifecycleErr, setLifecycleErr] = useState<string | null>(null);

  const devEnvState = task.devEnvState ?? 'active';

  const callLifecycle = useCallback(
    async (action: 'stop' | 'start' | 'delete') => {
      if (action === 'delete' && !confirm(`Delete the dev environment for "${task.title}"?\n\nThis removes the k8s deployment and route. The image stays in ACR — chat will recreate it.`)) {
        return;
      }
      setLifecycleBusy(action);
      setLifecycleErr(null);
      try {
        const url = `/api/tasks/${task.id}/dev-env${action === 'delete' ? '' : `/${action}`}`;
        const r = await fetch(url, { method: action === 'delete' ? 'DELETE' : 'POST' });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          throw new Error(err.details ?? err.error ?? `HTTP ${r.status}`);
        }
      } catch (e) {
        setLifecycleErr(e instanceof Error ? e.message : String(e));
      } finally {
        setLifecycleBusy(null);
      }
    },
    [task.id, task.title],
  );

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
        {devEnvState !== 'active' && (
          <span
            className={`shrink-0 text-[10px] px-2 py-0.5 rounded-full border ${
              devEnvState === 'stopped'
                ? 'bg-gray-500/15 text-gray-300 border-gray-500/30'
                : 'bg-red-500/15 text-red-300 border-red-500/30'
            }`}
            title={devEnvState === 'stopped' ? 'Deployment scaled to 0 + nginx route removed' : 'k8s resources deleted (image preserved in ACR)'}
          >
            {devEnvState === 'stopped' ? '⏸ Stopped' : '🗑 Deleted'}
          </span>
        )}
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
        {devEnvState === 'active' && (
          <button
            onClick={() => void callLifecycle('stop')}
            disabled={lifecycleBusy !== null}
            className="px-2 py-1 bg-amber-600/20 hover:bg-amber-600/40 border border-amber-500/40 rounded text-amber-200 disabled:opacity-50"
            title="Scale deployment to 0 and remove route — preserves namespace + image"
          >
            {lifecycleBusy === 'stop' ? '⏳ Stopping…' : '⏸ Stop'}
          </button>
        )}
        {devEnvState !== 'active' && task.imageRef && (
          <button
            onClick={() => void callLifecycle('start')}
            disabled={lifecycleBusy !== null}
            className="px-2 py-1 bg-green-600/20 hover:bg-green-600/40 border border-green-500/40 rounded text-green-200 disabled:opacity-50"
            title="Redeploy from cached image and restore route"
          >
            {lifecycleBusy === 'start' ? '⏳ Starting…' : '▶ Start'}
          </button>
        )}
        {devEnvState !== 'deleted' && (
          <button
            onClick={() => void callLifecycle('delete')}
            disabled={lifecycleBusy !== null}
            className="px-2 py-1 bg-red-600/20 hover:bg-red-600/40 border border-red-500/40 rounded text-red-200 disabled:opacity-50"
            title="Delete k8s deployment + route (image stays in ACR — chat will recreate)"
          >
            {lifecycleBusy === 'delete' ? '⏳ Deleting…' : '🗑 Delete'}
          </button>
        )}
      </div>

      {lifecycleErr && (
        <div className="mt-2 text-[10px] text-red-300 bg-red-500/10 border border-red-500/30 rounded px-2 py-1">
          {lifecycleErr}
        </div>
      )}

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
