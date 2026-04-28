'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import Link from 'next/link';
import LogList from '../../components/LogList';
import { useSocket } from '../../hooks/useSocket';
import { useTasks } from '../../hooks/useTasks';
import type { Task, TaskStatus, Agent, AgentLogEntry } from '@shared/types';

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

type SelKind = 'repo' | 'task' | 'agent';
interface Selection {
  kind: SelKind;
  repo: string;
  taskId?: string;
  agentId?: string;
}

export default function RequestsPage() {
  const { connected } = useSocket();
  const { getTasks } = useTasks();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(new Set());
  const [collapsedTasks, setCollapsedTasks] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<Selection | null>(null);

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
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [refresh]);

  const grouped = useMemo(() => {
    const filtered = showInactive
      ? tasks
      : tasks.filter((t) =>
          ['clarifying', 'specifying', 'building', 'deploying', 'review', 'shipping'].includes(t.status),
        );
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

  // Auto-select first repo on first load.
  useEffect(() => {
    if (!sel && grouped.length > 0) {
      const [firstRepo, repoTasks] = grouped[0]!;
      const firstTask = repoTasks[0];
      if (firstTask) {
        setSel({ kind: 'task', repo: firstRepo, taskId: firstTask.id });
      } else {
        setSel({ kind: 'repo', repo: firstRepo });
      }
    }
  }, [grouped, sel]);

  const toggleRepo = (repo: string) =>
    setCollapsedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(repo)) next.delete(repo);
      else next.add(repo);
      return next;
    });
  const toggleTask = (taskId: string) =>
    setCollapsedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });

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
            href="/"
            className="px-3 py-1 bg-cyan-600 hover:bg-cyan-500 text-white rounded text-xs font-semibold"
          >
            + New
          </Link>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Left: tree */}
        <aside className="w-80 shrink-0 border-r border-[#1a1a2e] bg-[#0a0a12] overflow-y-auto">
          {loading && <div className="p-4 text-xs text-gray-500">Loading…</div>}
          {error && <div className="p-4 text-xs text-red-400">{error}</div>}
          {!loading && !error && grouped.length === 0 && (
            <div className="p-4 text-xs text-gray-500">
              No {showInactive ? '' : 'active '}requests.{' '}
              <Link href="/" className="text-cyan-400">New →</Link>
            </div>
          )}
          {grouped.map(([repo, repoTasks]) => {
            const repoCollapsed = collapsedRepos.has(repo);
            const isRepoSel = sel?.kind === 'repo' && sel.repo === repo;
            return (
              <div key={repo} className="mb-1">
                <button
                  onClick={() => {
                    toggleRepo(repo);
                    setSel({ kind: 'repo', repo });
                  }}
                  className={`w-full flex items-center gap-1 px-2 py-1 text-xs hover:bg-[#10101a] ${
                    isRepoSel ? 'bg-cyan-900/30 text-cyan-200' : 'text-gray-300'
                  }`}
                >
                  <span className="text-gray-500 w-3 text-center">{repoCollapsed ? '▶' : '▼'}</span>
                  <span>📁</span>
                  <span className="truncate flex-1 text-left font-medium">{repo}</span>
                  <span className="text-[10px] text-gray-500">{repoTasks.length}</span>
                </button>
                {!repoCollapsed && (
                  <ul>
                    {repoTasks.map((t) => {
                      const taskCollapsed = collapsedTasks.has(t.id);
                      const isTaskSel = sel?.kind === 'task' && sel.taskId === t.id;
                      const style = STATUS_STYLES[t.status];
                      return (
                        <li key={t.id}>
                          <button
                            onClick={() => {
                              toggleTask(t.id);
                              setSel({ kind: 'task', repo, taskId: t.id });
                            }}
                            className={`w-full flex items-center gap-1 pl-5 pr-2 py-1 text-xs hover:bg-[#10101a] ${
                              isTaskSel ? 'bg-cyan-900/30 text-cyan-200' : 'text-gray-300'
                            }`}
                            title={t.title}
                          >
                            <span className="text-gray-500 w-3 text-center">
                              {(t.agents?.length ?? 0) > 0 ? (taskCollapsed ? '▶' : '▼') : ' '}
                            </span>
                            <span
                              className={`px-1.5 py-0 text-[9px] uppercase tracking-wide border rounded ${style.cls}`}
                            >
                              {style.label}
                            </span>
                            <span className="truncate flex-1 text-left">{t.title}</span>
                          </button>
                          {!taskCollapsed && t.agents && t.agents.length > 0 && (
                            <ul>
                              {t.agents.map((a) => {
                                const isAgentSel =
                                  sel?.kind === 'agent' && sel.agentId === a.id;
                                return (
                                  <li key={a.id}>
                                    <button
                                      onClick={() =>
                                        setSel({ kind: 'agent', repo, taskId: t.id, agentId: a.id })
                                      }
                                      className={`w-full flex items-center gap-1.5 pl-12 pr-2 py-0.5 text-[11px] hover:bg-[#10101a] ${
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
                                      <span className="truncate flex-1 text-left">{a.name}</span>
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
        </aside>

        {/* Right: details */}
        <main className="flex-1 overflow-hidden flex flex-col">
          <DetailPane sel={sel} tasks={tasks} />
        </main>
      </div>
    </div>
  );
}

function DetailPane({ sel, tasks }: { sel: Selection | null; tasks: Task[] }) {
  if (!sel) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
        Select a repo, request, or agent to see details.
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

  const task = tasks.find((t) => t.id === sel.taskId);
  if (!task) {
    return <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">Request not found.</div>;
  }

  if (sel.kind === 'task') {
    return <TaskDetail task={task} />;
  }

  // agent
  const agent = task.agents?.find((a) => a.id === sel.agentId);
  if (!agent) {
    return <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">Agent not found.</div>;
  }
  return <AgentDetail task={task} agent={agent} />;
}

function TaskDetail({ task }: { task: Task }) {
  const style = STATUS_STYLES[task.status];
  // Aggregate logs from all agents, ordered by timestamp.
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
            <a href={task.pullRequestUrl} target="_blank" rel="noreferrer" className="text-purple-300 hover:text-purple-200">
              🔗 PR #{task.pullRequestNumber}
            </a>
          )}
          {task.devUrl && (
            <a href={task.devUrl} target="_blank" rel="noreferrer" className="text-cyan-400 hover:text-cyan-300">
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
          <span>request: <Link href={`/task/${task.id}`} className="text-cyan-400 hover:text-cyan-300">{task.title}</Link></span>
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
