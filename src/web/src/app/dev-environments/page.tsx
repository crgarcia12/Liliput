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

type ViewMode = 'cards' | 'list';
type LifecycleAction = 'stop' | 'start' | 'delete';

async function responseError(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  if (body !== null && typeof body === 'object') {
    if ('details' in body && typeof body.details === 'string') return body.details;
    if ('error' in body && typeof body.error === 'string') return body.error;
  }
  return `HTTP ${response.status}`;
}

async function requestDevEnvLifecycle(taskId: string, action: LifecycleAction): Promise<void> {
  const url = `/api/tasks/${taskId}/dev-env${action === 'delete' ? '' : `/${action}`}`;
  const response = await fetch(url, { method: action === 'delete' ? 'DELETE' : 'POST' });
  if (!response.ok) throw new Error(await responseError(response));
}

export default function DevEnvironmentsPage() {
  const { connected } = useSocket();
  const { getTasks } = useTasks();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('cards');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkResult, setBulkResult] = useState<string | null>(null);

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

  const selectableEnvs = useMemo(
    () => envs.filter((task) => (task.devEnvState ?? 'active') !== 'deleted'),
    [envs],
  );
  const selectedEnvs = useMemo(
    () => selectableEnvs.filter((task) => selectedIds.has(task.id)),
    [selectableEnvs, selectedIds],
  );
  const allSelected =
    selectableEnvs.length > 0 && selectedEnvs.length === selectableEnvs.length;
  const someSelected = selectedEnvs.length > 0 && !allSelected;

  const toggleSelection = useCallback((taskId: string, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(taskId);
      else next.delete(taskId);
      return next;
    });
    setBulkError(null);
    setBulkResult(null);
  }, []);

  const toggleAll = useCallback(
    (checked: boolean) => {
      setSelectedIds((current) => {
        const next = new Set(current);
        for (const task of selectableEnvs) {
          if (checked) next.add(task.id);
          else next.delete(task.id);
        }
        return next;
      });
      setBulkError(null);
      setBulkResult(null);
    },
    [selectableEnvs],
  );

  const deleteSelected = useCallback(async () => {
    if (selectedEnvs.length === 0) return;
    if (
      !confirm(
        `Delete ${selectedEnvs.length} dev environments?\n\nThis removes their Kubernetes deployments and routes. Images stay in ACR, and chat can recreate each environment.`,
      )
    ) {
      return;
    }

    setBulkDeleting(true);
    setBulkError(null);
    setBulkResult(null);
    try {
      const results = await Promise.allSettled(
        selectedEnvs.map(async (task) => {
          await requestDevEnvLifecycle(task.id, 'delete');
          return task;
        }),
      );
      const deletedIds = new Set(
        results.flatMap((result) =>
          result.status === 'fulfilled' ? [result.value.id] : [],
        ),
      );
      const failures = results.flatMap((result, index) => {
        if (result.status === 'fulfilled') return [];
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        return [`${selectedEnvs[index]!.title}: ${reason}`];
      });

      if (deletedIds.size > 0) {
        setTasks((current) =>
          current.map((task) =>
            deletedIds.has(task.id) ? { ...task, devEnvState: 'deleted' } : task,
          ),
        );
        setSelectedIds((current) => {
          const next = new Set(current);
          for (const taskId of deletedIds) next.delete(taskId);
          return next;
        });
        setBulkResult(
          `Deleted ${deletedIds.size} ${deletedIds.size === 1 ? 'environment' : 'environments'}.`,
        );
      }

      if (failures.length > 0) {
        setBulkError(
          `Failed to delete ${failures.length} ${failures.length === 1 ? 'environment' : 'environments'}: ${failures.join('; ')}`,
        );
      }

      await refresh();
    } finally {
      setBulkDeleting(false);
    }
  }, [refresh, selectedEnvs]);

  return (
    <div className="min-h-screen bg-[#050510] text-gray-200 font-mono">
      <TopBar subtitle="Dev environments" connected={connected} />

      <main className="max-w-6xl mx-auto px-6 py-6 space-y-6">
        <section className="bg-[#0d0d14] border border-[#1a1a2e] rounded-lg p-4">
          <h2 className="text-sm font-semibold text-gray-300 mb-2">
            What&apos;s running on the cluster
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

        {envs.length > 0 && (
          <section className="flex flex-wrap items-center justify-between gap-3 bg-[#0d0d14] border border-[#1a1a2e] rounded-lg p-3">
            <div
              role="group"
              aria-label="Environment view"
              className="inline-flex rounded-md border border-[#2a2a3e] p-0.5"
            >
              <button
                type="button"
                data-testid="dev-env-view-cards"
                aria-pressed={viewMode === 'cards'}
                onClick={() => setViewMode('cards')}
                className={`px-3 py-1.5 rounded text-xs transition-colors ${
                  viewMode === 'cards'
                    ? 'bg-cyan-600 text-white'
                    : 'text-gray-400 hover:text-gray-100 hover:bg-[#1a1a2e]'
                }`}
              >
                ▦ Cards
              </button>
              <button
                type="button"
                data-testid="dev-env-view-list"
                aria-pressed={viewMode === 'list'}
                onClick={() => setViewMode('list')}
                className={`px-3 py-1.5 rounded text-xs transition-colors ${
                  viewMode === 'list'
                    ? 'bg-cyan-600 text-white'
                    : 'text-gray-400 hover:text-gray-100 hover:bg-[#1a1a2e]'
                }`}
              >
                ☷ List
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-3 text-xs">
              <label className="flex items-center gap-2 text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  data-testid="dev-env-select-all"
                  aria-label="Select all deletable environments"
                  aria-checked={someSelected ? 'mixed' : allSelected}
                  checked={allSelected}
                  ref={(input) => {
                    if (input) input.indeterminate = someSelected;
                  }}
                  onChange={(event) => toggleAll(event.target.checked)}
                  disabled={selectableEnvs.length === 0 || bulkDeleting}
                  className="accent-cyan-500"
                />
                Select all
              </label>
              <span className="text-gray-500">
                {selectedEnvs.length} selected
              </span>
              <button
                type="button"
                data-testid="dev-env-bulk-delete"
                onClick={() => void deleteSelected()}
                disabled={selectedEnvs.length === 0 || bulkDeleting}
                className="px-3 py-1.5 bg-red-600/20 hover:bg-red-600/40 border border-red-500/40 rounded text-red-200 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {bulkDeleting
                  ? `Deleting ${selectedEnvs.length}…`
                  : `Delete selected (${selectedEnvs.length})`}
              </button>
            </div>
          </section>
        )}

        {bulkResult && (
          <div
            role="status"
            data-testid="dev-env-bulk-result"
            className="bg-green-500/10 border border-green-500/30 rounded-lg p-3 text-sm text-green-300"
          >
            {bulkResult}
          </div>
        )}

        {bulkError && (
          <div
            role="alert"
            className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-sm text-red-300"
          >
            {bulkError}
          </div>
        )}

        {loading && envs.length === 0 ? (
          <div className="text-gray-500 text-sm">Loading…</div>
        ) : envs.length === 0 ? (
          <div className="text-gray-500 text-sm border border-[#1a1a2e] rounded-lg p-6 text-center">
            No dev environments yet. Deployed previews will show up here.
          </div>
        ) : viewMode === 'cards' ? (
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
                  <DevEnvCard
                    key={t.id}
                    task={t}
                    selected={selectedIds.has(t.id)}
                    onSelectionChange={toggleSelection}
                  />
                ))}
              </div>
            </section>
          ))
        ) : (
          <DevEnvList
           tasks={envs}
           selectedIds={selectedIds}
           onSelectionChange={toggleSelection}
          />
        )}
      </main>
    </div>
  );
}

function DevEnvList({
  tasks,
  selectedIds,
  onSelectionChange,
}: {
  tasks: Task[];
  selectedIds: ReadonlySet<string>;
  onSelectionChange: (taskId: string, checked: boolean) => void;
}) {
  return (
    <div className="overflow-x-auto bg-[#0d0d14] border border-[#1a1a2e] rounded-lg">
      <table
        data-testid="dev-env-list"
        aria-label="Dev environments list"
        className="w-full min-w-[900px] text-left text-xs"
      >
        <thead className="bg-[#12121d] text-gray-500 uppercase tracking-wide">
          <tr>
           <th scope="col" className="w-10 px-3 py-2">
             <span className="sr-only">Select</span>
           </th>
           <th scope="col" className="px-3 py-2">Environment</th>
           <th scope="col" className="px-3 py-2">Repository</th>
           <th scope="col" className="px-3 py-2">State</th>
           <th scope="col" className="px-3 py-2">Namespace</th>
           <th scope="col" className="px-3 py-2">Branch</th>
           <th scope="col" className="px-3 py-2">Updated</th>
           <th scope="col" className="px-3 py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#1a1a2e]">
          {tasks.map((task) => {
           const devEnvState = task.devEnvState ?? 'active';
           const selectable = devEnvState !== 'deleted';
           const style = STATUS_STYLES[task.status];
           return (
             <tr
               key={task.id}
               className={`hover:bg-[#12121d] ${
                 selectedIds.has(task.id) ? 'bg-cyan-500/5' : ''
               }`}
             >
               <td className="px-3 py-3">
                 <input
                   type="checkbox"
                   aria-label={`Select ${task.title}`}
                   checked={selectable && selectedIds.has(task.id)}
                   onChange={(event) => onSelectionChange(task.id, event.target.checked)}
                   disabled={!selectable}
                   className="accent-cyan-500 disabled:opacity-30"
                 />
               </td>
               <th scope="row" className="px-3 py-3 font-medium">
                 <Link href={`/task/${task.id}`} className="text-gray-100 hover:text-cyan-300">
                   {task.title}
                 </Link>
                 {task.devUrl && (
                   <a
                     href={task.devUrl}
                     target="_blank"
                     rel="noreferrer"
                     className="block mt-1 max-w-52 truncate text-[10px] font-normal text-cyan-400 hover:underline"
                     title={task.devUrl}
                   >
                     {task.devUrl}
                   </a>
                 )}
               </th>
               <td className="px-3 py-3 text-gray-300">{task.repository ?? 'unknown'}</td>
               <td className="px-3 py-3">
                 <div className="flex flex-wrap gap-1">
                   <span className={`text-[10px] px-2 py-0.5 rounded-full border ${style.cls}`}>
                     {style.label}
                   </span>
                   <span
                     className={`text-[10px] px-2 py-0.5 rounded-full border ${
                       devEnvState === 'active'
                         ? 'bg-green-500/15 text-green-300 border-green-500/30'
                         : devEnvState === 'stopped'
                           ? 'bg-gray-500/15 text-gray-300 border-gray-500/30'
                           : 'bg-red-500/15 text-red-300 border-red-500/30'
                     }`}
                   >
                     {devEnvState === 'active' ? 'Active' : devEnvState === 'stopped' ? 'Stopped' : 'Deleted'}
                   </span>
                 </div>
               </td>
               <td className="px-3 py-3">
                 <code className="text-amber-300">{task.devNamespace ?? '—'}</code>
               </td>
               <td className="px-3 py-3">
                 <code className="text-green-300">{task.branch ?? '—'}</code>
                 {task.commitSha && (
                   <span className="block mt-1 text-[10px] text-gray-600">
                     @ {task.commitSha.substring(0, 7)}
                   </span>
                 )}
               </td>
               <td className="px-3 py-3 text-gray-500">
                 <time dateTime={task.updatedAt}>{task.updatedAt.slice(0, 10)}</time>
               </td>
               <td className="px-3 py-3">
                 <div className="flex justify-end gap-2">
                   {task.devUrl && (
                     <a
                       href={task.devUrl}
                       target="_blank"
                       rel="noreferrer"
                       className="text-cyan-300 hover:underline"
                     >
                       Open
                     </a>
                   )}
                   <Link href={`/task/${task.id}`} className="text-gray-300 hover:text-white">
                     Chat
                   </Link>
                 </div>
               </td>
             </tr>
           );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DevEnvCard({
  task,
  selected,
  onSelectionChange,
}: {
  task: Task;
  selected: boolean;
  onSelectionChange: (taskId: string, checked: boolean) => void;
}) {
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
        await requestDevEnvLifecycle(task.id, action);
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
        {devEnvState !== 'deleted' && (
          <input
            type="checkbox"
            aria-label={`Select ${task.title}`}
            checked={selected}
            onChange={(event) => onSelectionChange(task.id, event.target.checked)}
            className="mt-0.5 accent-cyan-500"
          />
        )}
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
