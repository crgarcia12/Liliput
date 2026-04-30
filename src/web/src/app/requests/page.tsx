'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import Link from 'next/link';
import LogList from '../../components/LogList';
import { useSocket } from '../../hooks/useSocket';
import { useTasks } from '../../hooks/useTasks';
import type {
  Task,
  TaskStatus,
  Agent,
  AgentLogEntry,
  Workstream,
  DeletePreview,
} from '@shared/types';

const STATUS_STYLES: Record<TaskStatus, { label: string; cls: string }> = {
  clarifying: { label: 'Clarifying', cls: 'bg-blue-500/15 text-blue-300 border-blue-500/30' },
  specifying: { label: 'Specifying', cls: 'bg-blue-500/15 text-blue-300 border-blue-500/30' },
  building: { label: 'Building', cls: 'bg-yellow-500/15 text-yellow-300 border-yellow-500/30' },
  deploying: { label: 'Deploying', cls: 'bg-yellow-500/15 text-yellow-300 border-yellow-500/30' },
  review: { label: 'Review', cls: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30' },
  shipping: { label: 'Shipping', cls: 'bg-purple-500/15 text-purple-300 border-purple-500/30' },
  completed: { label: 'Completed', cls: 'bg-green-500/15 text-green-300 border-green-500/30' },
  discarded: { label: 'Discarded', cls: 'bg-gray-500/15 text-gray-400 border-gray-500/30' },
  failed: { label: 'Failed', cls: 'bg-red-500/15 text-red-300 border-red-500/30' },
};

const ROLE_ICON: Record<string, string> = {
  architect: '📐',
  coder: '💻',
  builder: '🔨',
  tester: '🧪',
  deployer: '🚀',
  reviewer: '👁️',
  researcher: '🔍',
};

const AGENT_STATUS_DOT: Record<string, string> = {
  idle: 'bg-gray-500',
  working: 'bg-yellow-400 animate-pulse',
  completed: 'bg-green-400',
  failed: 'bg-red-400',
  waiting: 'bg-blue-400',
};

const UNASSIGNED_KEY = '__unassigned__';

type SelKind = 'repo' | 'workstream' | 'task' | 'agent';
interface Selection {
  kind: SelKind;
  repo: string;
  workstreamKey?: string; // workstream id, or UNASSIGNED_KEY
  taskId?: string;
  agentId?: string;
}

interface DeleteTarget {
  scope: 'task' | 'workstream' | 'repo';
  /** API path for preview/delete (without /delete-preview suffix). */
  endpoint: string;
  label: string;
}

export default function RequestsPage() {
  const { connected } = useSocket();
  const { getTasks } = useTasks();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [workstreams, setWorkstreams] = useState<Workstream[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(new Set());
  const [collapsedWorkstreams, setCollapsedWorkstreams] = useState<Set<string>>(new Set());
  const [collapsedTasks, setCollapsedTasks] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<Selection | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [list, wsRes] = await Promise.all([
        getTasks(),
        fetch('/api/workstreams').then((r) =>
          r.ok ? (r.json() as Promise<{ workstreams: Workstream[] }>) : { workstreams: [] },
        ),
      ]);
      setTasks(list);
      setWorkstreams(wsRes.workstreams);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load requests');
    } finally {
      setLoading(false);
    }
  }, [getTasks]);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [refresh]);

  // Tree shape: repo → workstream → tasks. Workstreams with zero tasks still
  // render so the user can delete empty ones. Tasks without a workstreamId
  // bucket under a synthetic "(unassigned)" workstream per repo.
  interface WsBucket {
    key: string;
    name: string;
    workstream?: Workstream;
    tasks: Task[];
  }
  interface RepoBucket {
    repo: string;
    workstreams: WsBucket[];
    taskCount: number;
  }

  const tree: RepoBucket[] = useMemo(() => {
    const filtered = showInactive
      ? tasks
      : tasks.filter((t) =>
          ['clarifying', 'specifying', 'building', 'deploying', 'review', 'shipping'].includes(
            t.status,
          ),
        );

    const wsById = new Map(workstreams.map((w) => [w.id, w]));
    const wsByRepo = new Map<string, Workstream[]>();
    for (const w of workstreams) {
      const arr = wsByRepo.get(w.repository) ?? [];
      arr.push(w);
      wsByRepo.set(w.repository, arr);
    }

    const byRepo = new Map<string, Map<string, WsBucket>>();
    const ensureRepo = (repo: string): Map<string, WsBucket> => {
      let m = byRepo.get(repo);
      if (!m) {
        m = new Map();
        for (const w of wsByRepo.get(repo) ?? []) {
          m.set(w.id, { key: w.id, name: w.name, workstream: w, tasks: [] });
        }
        byRepo.set(repo, m);
      }
      return m;
    };

    for (const t of filtered) {
      const repo = t.repository ?? '(no repo)';
      const wsMap = ensureRepo(repo);
      const wsId = t.workstreamId;
      if (wsId && wsById.has(wsId)) {
        const bucket = wsMap.get(wsId)!;
        bucket.tasks.push(t);
      } else {
        let bucket = wsMap.get(UNASSIGNED_KEY);
        if (!bucket) {
          bucket = { key: UNASSIGNED_KEY, name: '(unassigned)', tasks: [] };
          wsMap.set(UNASSIGNED_KEY, bucket);
        }
        bucket.tasks.push(t);
      }
    }

    if (showInactive) {
      for (const repo of wsByRepo.keys()) ensureRepo(repo);
    }

    const result: RepoBucket[] = [];
    for (const [repo, wsMap] of byRepo) {
      const buckets = Array.from(wsMap.values());
      for (const b of buckets) b.tasks.sort((a, c) => c.updatedAt.localeCompare(a.updatedAt));
      buckets.sort((a, b) => {
        if (a.key === UNASSIGNED_KEY) return -1;
        if (b.key === UNASSIGNED_KEY) return 1;
        return a.name.localeCompare(b.name);
      });
      const taskCount = buckets.reduce((sum, b) => sum + b.tasks.length, 0);
      if (taskCount === 0 && !buckets.some((b) => b.key !== UNASSIGNED_KEY)) continue;
      result.push({ repo, workstreams: buckets, taskCount });
    }
    result.sort((a, b) => a.repo.localeCompare(b.repo));
    return result;
  }, [tasks, workstreams, showInactive]);

  // Auto-select first node on first load.
  useEffect(() => {
    if (sel || tree.length === 0) return;
    const first = tree[0]!;
    const firstWs = first.workstreams[0];
    const firstTask = firstWs?.tasks[0];
    if (firstTask && firstWs) {
      setSel({
        kind: 'task',
        repo: first.repo,
        workstreamKey: firstWs.key,
        taskId: firstTask.id,
      });
    } else {
      setSel({ kind: 'repo', repo: first.repo });
    }
  }, [tree, sel]);

  const toggleSet = (s: Set<string>, k: string): Set<string> => {
    const next = new Set(s);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    return next;
  };

  const requestDelete = (target: DeleteTarget) => setDeleteTarget(target);
  const handleDeleted = useCallback(() => {
    setDeleteTarget(null);
    setSel(null);
    void refresh();
  }, [refresh]);

  return (
    <div className="flex flex-col h-screen bg-[#050510] text-gray-100">
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
          <label className="flex items-center gap-2 text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="accent-cyan-500"
            />
            Show inactive
          </label>
          <Link
            href="/dev-environments"
            className="text-gray-400 hover:text-cyan-300 text-xs"
          >
            ☁️ Dev envs
          </Link>
          <Link
            href="/"
            className="px-3 py-1 bg-cyan-600 hover:bg-cyan-500 text-white rounded text-xs font-semibold"
          >
            + New
          </Link>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Left: tree */}
        <aside className="w-96 shrink-0 border-r border-[#1a1a2e] bg-[#0a0a12] overflow-y-auto">
          {loading && <div className="p-4 text-xs text-gray-500">Loading…</div>}
          {error && <div className="p-4 text-xs text-red-400">{error}</div>}
          {!loading && !error && tree.length === 0 && (
            <div className="p-4 text-xs text-gray-500">
              No {showInactive ? '' : 'active '}requests.{' '}
              <Link href="/" className="text-cyan-400">New →</Link>
            </div>
          )}
          {tree.map(({ repo, workstreams: wsBuckets, taskCount }) => {
            const repoCollapsed = collapsedRepos.has(repo);
            const isRepoSel = sel?.kind === 'repo' && sel.repo === repo;
            const isRealRepo = repo !== '(no repo)';
            return (
              <div key={repo} className="mb-1">
                <div
                  className={`group flex items-center gap-1 px-2 py-1 text-xs hover:bg-[#10101a] ${
                    isRepoSel ? 'bg-cyan-900/30 text-cyan-200' : 'text-gray-300'
                  }`}
                >
                  <button
                    onClick={() => {
                      setCollapsedRepos((s) => toggleSet(s, repo));
                      setSel({ kind: 'repo', repo });
                    }}
                    className="flex items-center gap-1 flex-1 min-w-0 text-left"
                  >
                    <span className="text-gray-500 w-3 text-center">{repoCollapsed ? '▶' : '▼'}</span>
                    <span>📁</span>
                    <span className="truncate flex-1 font-medium">{repo}</span>
                    <span className="text-[10px] text-gray-500">{taskCount}</span>
                  </button>
                  {isRealRepo && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        requestDelete({
                          scope: 'repo',
                          endpoint: `/api/repo-groups/${encodeURIComponent(repo)}`,
                          label: repo,
                        });
                      }}
                      className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 px-1"
                      title="Delete this repo group (cascades to all tasks)"
                    >
                      🗑
                    </button>
                  )}
                </div>
                {!repoCollapsed &&
                  wsBuckets.map((bucket) => {
                    const wsCollapsedKey = `${repo}::${bucket.key}`;
                    const wsCollapsed = collapsedWorkstreams.has(wsCollapsedKey);
                    const isWsSel =
                      sel?.kind === 'workstream' &&
                      sel.repo === repo &&
                      sel.workstreamKey === bucket.key;
                    const isUnassigned = bucket.key === UNASSIGNED_KEY;
                    return (
                      <div key={bucket.key}>
                        <div
                          className={`group flex items-center gap-1 pl-5 pr-2 py-0.5 text-[11px] hover:bg-[#10101a] ${
                            isWsSel ? 'bg-cyan-900/30 text-cyan-200' : 'text-gray-300'
                          }`}
                        >
                          <button
                            onClick={() => {
                              setCollapsedWorkstreams((s) => toggleSet(s, wsCollapsedKey));
                              setSel({
                                kind: 'workstream',
                                repo,
                                workstreamKey: bucket.key,
                              });
                            }}
                            className="flex items-center gap-1 flex-1 min-w-0 text-left"
                          >
                            <span className="text-gray-500 w-3 text-center">
                              {bucket.tasks.length > 0 ? (wsCollapsed ? '▶' : '▼') : ' '}
                            </span>
                            <span>{isUnassigned ? '🗂' : '📑'}</span>
                            <span
                              className={`truncate flex-1 ${isUnassigned ? 'italic text-gray-500' : ''}`}
                            >
                              {bucket.name}
                            </span>
                            <span className="text-[10px] text-gray-600">
                              {bucket.tasks.length}
                            </span>
                          </button>
                          {!isUnassigned && bucket.workstream && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                requestDelete({
                                  scope: 'workstream',
                                  endpoint: `/api/workstreams/${bucket.workstream!.id}`,
                                  label: `${repo} / ${bucket.name}`,
                                });
                              }}
                              className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 px-1"
                              title="Delete this workstream (cascades to its tasks)"
                            >
                              🗑
                            </button>
                          )}
                        </div>
                        {!wsCollapsed && (
                          <ul>
                            {bucket.tasks.map((t) => {
                              const taskCollapsed = collapsedTasks.has(t.id);
                              const isTaskSel = sel?.kind === 'task' && sel.taskId === t.id;
                              const style = STATUS_STYLES[t.status];
                              return (
                                <li key={t.id}>
                                  <div
                                    className={`group flex items-center gap-1 pl-10 pr-2 py-1 text-xs hover:bg-[#10101a] ${
                                      isTaskSel ? 'bg-cyan-900/30 text-cyan-200' : 'text-gray-300'
                                    }`}
                                  >
                                    <button
                                      onClick={() => {
                                        setCollapsedTasks((s) => toggleSet(s, t.id));
                                        setSel({
                                          kind: 'task',
                                          repo,
                                          workstreamKey: bucket.key,
                                          taskId: t.id,
                                        });
                                      }}
                                      className="flex items-center gap-1 flex-1 min-w-0 text-left"
                                      title={t.title}
                                    >
                                      <span className="text-gray-500 w-3 text-center">
                                        {(t.agents?.length ?? 0) > 0
                                          ? taskCollapsed
                                            ? '▶'
                                            : '▼'
                                          : ' '}
                                      </span>
                                      <span
                                        className={`px-1.5 py-0 text-[9px] uppercase tracking-wide border rounded ${style.cls}`}
                                      >
                                        {style.label}
                                      </span>
                                      <span className="truncate flex-1">{t.title}</span>
                                    </button>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        requestDelete({
                                          scope: 'task',
                                          endpoint: `/api/tasks/${t.id}`,
                                          label: t.title,
                                        });
                                      }}
                                      className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 px-1"
                                      title="Delete this request (closes PR, removes branch + dev env)"
                                    >
                                      🗑
                                    </button>
                                  </div>
                                  {!taskCollapsed && t.agents && t.agents.length > 0 && (
                                    <ul>
                                      {t.agents.map((a) => {
                                        const isAgentSel =
                                          sel?.kind === 'agent' && sel.agentId === a.id;
                                        return (
                                          <li key={a.id}>
                                            <button
                                              onClick={() =>
                                                setSel({
                                                  kind: 'agent',
                                                  repo,
                                                  workstreamKey: bucket.key,
                                                  taskId: t.id,
                                                  agentId: a.id,
                                                })
                                              }
                                              className={`w-full flex items-center gap-1.5 pl-16 pr-2 py-0.5 text-[11px] hover:bg-[#10101a] ${
                                                isAgentSel
                                                  ? 'bg-cyan-900/30 text-cyan-200'
                                                  : 'text-gray-400'
                                              }`}
                                            >
                                              <span
                                                className={`w-1.5 h-1.5 rounded-full ${
                                                  AGENT_STATUS_DOT[a.status] ?? 'bg-gray-500'
                                                }`}
                                              />
                                              <span>{ROLE_ICON[a.role] ?? '🤖'}</span>
                                              <span className="truncate flex-1 text-left">
                                                {a.name}
                                              </span>
                                              <span className="text-[9px] text-gray-600">
                                                {a.logs?.length ?? 0}
                                              </span>
                                            </button>
                                          </li>
                                        );
                                      })}
                                    </ul>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>
                    );
                  })}
              </div>
            );
          })}
        </aside>

        {/* Right: details */}
        <main className="flex-1 overflow-hidden flex flex-col">
          <DetailPane sel={sel} tasks={tasks} />
        </main>
      </div>

      {deleteTarget && (
        <ConfirmDeleteDialog
          target={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={handleDeleted}
        />
      )}
    </div>
  );
}

function DetailPane({ sel, tasks }: { sel: Selection | null; tasks: Task[] }) {
  if (!sel) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
        Select a repo, workstream, request, or agent to see details.
      </div>
    );
  }

  if (sel.kind === 'repo') {
    const repoTasks = tasks.filter((t) => (t.repository ?? '(no repo)') === sel.repo);
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <h2 className="text-lg font-semibold mb-1">📁 {sel.repo}</h2>
        <div className="text-xs text-gray-500 mb-4">{repoTasks.length} request(s)</div>
        <ul className="space-y-1 text-sm">
          {repoTasks.map((t) => {
            const style = STATUS_STYLES[t.status];
            return (
              <li
                key={t.id}
                className="flex items-center gap-2 px-3 py-2 rounded border border-[#1a1a2e] hover:border-cyan-500/40 bg-[#0a0a12]"
              >
                <span className={`px-2 py-0.5 text-[10px] uppercase border rounded ${style.cls}`}>
                  {style.label}
                </span>
                <span className="flex-1 truncate">{t.title}</span>
                {t.branch && (
                  <span className="text-[10px] text-gray-500 font-mono">⎇ {t.branch}</span>
                )}
                <Link
                  href={`/task/${t.id}`}
                  className="text-cyan-400 hover:text-cyan-300 text-xs"
                >
                  open →
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  if (sel.kind === 'workstream') {
    const wsTasks = tasks.filter((t) => {
      if ((t.repository ?? '(no repo)') !== sel.repo) return false;
      if (sel.workstreamKey === UNASSIGNED_KEY) return !t.workstreamId;
      return t.workstreamId === sel.workstreamKey;
    });
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <h2 className="text-lg font-semibold mb-1">📑 {sel.repo} / workstream</h2>
        <div className="text-xs text-gray-500 mb-4">{wsTasks.length} request(s)</div>
        <ul className="space-y-1 text-sm">
          {wsTasks.map((t) => {
            const style = STATUS_STYLES[t.status];
            return (
              <li
                key={t.id}
                className="flex items-center gap-2 px-3 py-2 rounded border border-[#1a1a2e] hover:border-cyan-500/40 bg-[#0a0a12]"
              >
                <span className={`px-2 py-0.5 text-[10px] uppercase border rounded ${style.cls}`}>
                  {style.label}
                </span>
                <span className="flex-1 truncate">{t.title}</span>
                <Link
                  href={`/task/${t.id}`}
                  className="text-cyan-400 hover:text-cyan-300 text-xs"
                >
                  open →
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  const task = tasks.find((t) => t.id === sel.taskId);
  if (!task) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
        Request not found.
      </div>
    );
  }

  if (sel.kind === 'task') {
    return <TaskDetail task={task} />;
  }

  // agent
  const agent = task.agents?.find((a) => a.id === sel.agentId);
  if (!agent) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
        Agent not found.
      </div>
    );
  }
  return <AgentDetail task={task} agent={agent} />;
}

function TaskDetail({ task }: { task: Task }) {
  const style = STATUS_STYLES[task.status];
  const allLogs: AgentLogEntry[] = useMemo(() => {
    const entries: AgentLogEntry[] = [];
    for (const a of task.agents ?? []) {
      for (const log of a.logs ?? []) {
        entries.push({ ...log, message: `[${a.name}] ${log.message}` });
      }
    }
    entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return entries;
  }, [task.agents]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-6 py-4 border-b border-[#1a1a2e] bg-[#0a0a12]">
        <div className="flex items-center gap-2 mb-2">
          <span className={`px-2 py-0.5 text-[10px] uppercase border rounded ${style.cls}`}>
            {style.label}
          </span>
          <h2 className="text-lg font-semibold flex-1 truncate">{task.title}</h2>
          <Link
            href={`/task/${task.id}`}
            className="text-xs px-3 py-1 bg-cyan-600 hover:bg-cyan-500 text-white rounded"
          >
            Open chat →
          </Link>
        </div>
        <div className="text-xs text-gray-400 flex flex-wrap gap-x-4 gap-y-1">
          {task.repository && <span>📁 {task.repository}</span>}
          {task.branch && <span className="font-mono">⎇ {task.branch}</span>}
          {task.commitSha && <span className="font-mono">{task.commitSha.substring(0, 7)}</span>}
          {task.pullRequestUrl && (
            <a
              href={task.pullRequestUrl}
              target="_blank"
              rel="noreferrer"
              className="text-purple-300 hover:text-purple-200"
            >
              🔗 PR #{task.pullRequestNumber}
            </a>
          )}
          {task.devUrl && (
            <a
              href={task.devUrl}
              target="_blank"
              rel="noreferrer"
              className="text-cyan-400 hover:text-cyan-300"
            >
              🌐 Preview
            </a>
          )}
          <span>{task.agents?.length ?? 0} agent(s)</span>
          <span>{allLogs.length} log line(s)</span>
        </div>
        {task.errorMessage && (
          <div className="mt-2 text-xs text-red-300 border border-red-500/30 bg-red-500/10 rounded px-2 py-1">
            ⚠ {task.errorMessage}
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto bg-[#06060c]">
        <LogList logs={allLogs} emptyHint="No agent logs yet — pipeline starting…" />
      </div>
    </div>
  );
}

function AgentDetail({ task, agent }: { task: Task; agent: Agent }) {
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-6 py-4 border-b border-[#1a1a2e] bg-[#0a0a12]">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xl">{ROLE_ICON[agent.role] ?? '🤖'}</span>
          <h2 className="text-lg font-semibold flex-1 truncate">{agent.name}</h2>
          <span
            className={`w-2 h-2 rounded-full ${AGENT_STATUS_DOT[agent.status] ?? 'bg-gray-500'}`}
          />
          <span className="text-xs text-gray-400">{agent.status}</span>
        </div>
        <div className="text-xs text-gray-500 flex flex-wrap gap-x-4">
          <span>
            request:{' '}
            <Link href={`/task/${task.id}`} className="text-cyan-400 hover:text-cyan-300">
              {task.title}
            </Link>
          </span>
          <span>role: {agent.role}</span>
          <span>{agent.logs?.length ?? 0} log line(s)</span>
        </div>
        {agent.currentAction && (
          <div className="text-xs text-gray-300 mt-2 italic">{agent.currentAction}</div>
        )}
        <div className="mt-2 h-1 bg-[#1a1a2e] rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-cyan-500 to-green-500"
            style={{ width: `${agent.progress}%` }}
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto bg-[#06060c]">
        <LogList logs={agent.logs ?? []} emptyHint="No logs from this agent yet." />
      </div>
    </div>
  );
}

function ConfirmDeleteDialog({
  target,
  onClose,
  onDeleted,
}: {
  target: DeleteTarget;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    fetch(`${target.endpoint}/delete-preview`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`Preview failed: ${r.status} ${await r.text()}`);
        return r.json() as Promise<{ preview: DeletePreview }>;
      })
      .then((d) => {
        if (!cancelled) setPreview(d.preview);
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [target.endpoint]);

  const confirm = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(target.endpoint, { method: 'DELETE' });
      if (!r.ok && r.status !== 204) {
        throw new Error(`Delete failed: ${r.status} ${await r.text()}`);
      }
      onDeleted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-lg bg-[#0d0d14] border border-[#1a1a2e] rounded-lg shadow-xl">
        <div className="px-5 py-3 border-b border-[#1a1a2e] flex items-center gap-2">
          <span className="text-xl">⚠️</span>
          <h3 className="text-base font-semibold text-red-300">
            Delete {target.scope === 'repo' ? 'repo group' : target.scope}
          </h3>
        </div>
        <div className="px-5 py-4 text-xs text-gray-300 space-y-3 max-h-[60vh] overflow-y-auto">
          <p className="text-gray-400">
            Target: <span className="text-gray-100 font-medium">{target.label}</span>
          </p>
          {loading && <p className="text-gray-500">Loading preview…</p>}
          {err && (
            <p className="text-red-400 border border-red-500/40 bg-red-500/10 rounded px-2 py-1">
              {err}
            </p>
          )}
          {preview && (
            <>
              <p className="text-gray-300">
                This will <span className="text-red-300 font-medium">permanently</span> remove{' '}
                <span className="font-mono">{preview.taskCount}</span> request(s) and the following
                external state:
              </p>
              <ul className="space-y-2">
                <PreviewSection
                  title="Pull requests to close"
                  empty="(none)"
                  items={preview.pullRequests.map((p) => `${p.repository}#${p.number}`)}
                />
                <PreviewSection
                  title="Branches to delete on the remote"
                  empty="(none)"
                  items={preview.branches.map((b) => `${b.repository} ⎇ ${b.branch}`)}
                />
                <PreviewSection
                  title="Kubernetes namespaces to delete"
                  empty="(none)"
                  items={preview.namespaces}
                />
                {preview.workstreams.length > 0 && (
                  <PreviewSection
                    title="Workstreams to remove"
                    empty="(none)"
                    items={preview.workstreams.map((w) => w.name)}
                  />
                )}
              </ul>
              <p className="text-gray-500 italic">
                The GitHub repository itself, its <span className="font-mono">main</span> branch,
                and any branches not created by these agents are{' '}
                <span className="font-medium">never</span> touched.
              </p>
            </>
          )}
        </div>
        <div className="px-5 py-3 border-t border-[#1a1a2e] flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1 text-xs text-gray-300 hover:text-white rounded border border-[#1a1a2e] hover:border-gray-500"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={busy || loading || !!err}
            className="px-3 py-1 text-xs text-white rounded bg-red-600 hover:bg-red-500 disabled:opacity-40"
          >
            {busy ? 'Deleting…' : 'Delete permanently'}
          </button>
        </div>
      </div>
    </div>
  );
}

function PreviewSection({
  title,
  items,
  empty,
}: {
  title: string;
  items: string[];
  empty: string;
}) {
  return (
    <li>
      <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">{title}</div>
      {items.length === 0 ? (
        <div className="text-gray-600 text-xs">{empty}</div>
      ) : (
        <ul className="ml-4 list-disc space-y-0.5 font-mono text-xs">
          {items.map((it, i) => (
            <li key={`${it}-${i}`}>{it}</li>
          ))}
        </ul>
      )}
    </li>
  );
}
