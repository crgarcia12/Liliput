'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import Terminal from '../../../components/Terminal';
import AgentPanel from '../../../components/AgentPanel';
import ActivityLog from '../../../components/ActivityLog';
import { useSocket } from '../../../hooks/useSocket';
import { useTasks } from '../../../hooks/useTasks';
import type { Task, ChatMessage, Agent } from '@shared/types';

const LiliputIsland = dynamic(() => import('../../../components/LiliputIsland'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center bg-[#050510] rounded-lg border border-[#1a1a2e]">
      <div className="text-4xl animate-pulse">🏰</div>
    </div>
  ),
});

const API_URL = '';

export default function TaskPage() {
  const params = useParams();
  const taskId = params.id as string;

  const { connected, agentEvents, chatMessages: socketMessages, activity, joinTask, leaveTask } =
    useSocket();
  const { getTask, sendMessage, shipTask, discardTask } = useTasks();

  const [task, setTask] = useState<Task | null>(null);
  const [localMessages, setLocalMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState<'ship' | 'discard' | 'approve' | null>(null);
  const [showSpec, setShowSpec] = useState(true);

  // Only swap task / chat state when something the user can see has actually
  // changed. Without this, the 4s poll + activity-event refetch (which fires
  // on every heartbeat / tool event) constantly replaced these objects with
  // fresh references — re-rendering the chat list and breaking text selection.
  // Note: we deliberately ignore activityHistory.length here — the activity
  // panel hydrates from the live socket stream, not from task refetches, so
  // including it would re-render every few seconds during active agent work
  // and kill text selection in the chat above.
  const applyTaskUpdate = useCallback((next: Task) => {
    setTask((prev) => {
      if (
        prev &&
        prev.updatedAt === next.updatedAt &&
        prev.status === next.status &&
        prev.devUrl === next.devUrl &&
        prev.commitSha === next.commitSha &&
        prev.pullRequestUrl === next.pullRequestUrl &&
        (prev.chatHistory?.length ?? 0) === (next.chatHistory?.length ?? 0)
      ) {
        return prev;
      }
      return next;
    });
    setLocalMessages((prev) => {
      const nextMsgs = next.chatHistory || [];
      if (prev.length === nextMsgs.length) {
        const lastA = prev[prev.length - 1];
        const lastB = nextMsgs[nextMsgs.length - 1];
        if ((lastA?.id ?? null) === (lastB?.id ?? null)) {
          return prev;
        }
      }
      return nextMsgs;
    });
  }, []);


  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const t = await getTask(taskId);
        if (!cancelled) {
          applyTaskUpdate(t);
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setError('Failed to load task');
          setLoading(false);
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [taskId, getTask, applyTaskUpdate]);

  useEffect(() => {
    if (connected && taskId) {
      joinTask(taskId);
      return () => leaveTask(taskId);
    }
  }, [connected, taskId, joinTask, leaveTask]);

  // Cheap polling fallback so the user always sees fresh state — including
  // chat history. Without this, any chat:message emitted before the page was
  // open (or while the socket was reconnecting) would be invisible to the user
  // even though the backend has it persisted in task.chatHistory.
  useEffect(() => {
    if (!taskId) return;
    const interval = setInterval(() => {
      getTask(taskId).then(applyTaskUpdate).catch(() => {});
    }, 4000);
    return () => clearInterval(interval);
  }, [taskId, getTask, applyTaskUpdate]);

  // Refetch immediately when activity arrives for this task (socket events
  // signal something changed; pull fresh task + chat history).
  useEffect(() => {
    if (!taskId) return;
    const last = activity[activity.length - 1];
    if (last && last.taskId === taskId) {
      getTask(taskId).then(applyTaskUpdate).catch(() => {});
    }
  }, [activity, taskId, getTask, applyTaskUpdate]);

  // Merge persisted chatHistory (localMessages) with live socket messages,
  // de-duplicating by id so a refetch after a chat:message doesn't double up.
  const allMessages = useMemo(() => {
    const seen = new Set<string>();
    const out: ChatMessage[] = [];
    for (const m of localMessages) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        out.push(m);
      }
    }
    for (const m of socketMessages) {
      if (m.taskId !== taskId) continue;
      if (!seen.has(m.id)) {
        seen.add(m.id);
        out.push(m);
      }
    }
    return out;
  }, [localMessages, socketMessages, taskId]);

  // Merge persisted task.activityHistory with live socket activity, dedupe by id.
  // Without this, anything emitted before the page was open would be invisible.
  const taskActivity = useMemo(() => {
    const seen = new Set<string>();
    const out: typeof activity = [];
    const persisted = task?.activityHistory ?? [];
    for (const e of persisted) {
      if (e.taskId !== taskId) continue;
      if (!seen.has(e.id)) {
        seen.add(e.id);
        out.push(e);
      }
    }
    for (const e of activity) {
      if (e.taskId !== taskId) continue;
      if (!seen.has(e.id)) {
        seen.add(e.id);
        out.push(e);
      }
    }
    return out;
  }, [task?.activityHistory, activity, taskId]);

  const agents = useMemo(() => {
    const agentMap = new Map<string, Agent>();
    if (task?.agents) {
      for (const a of task.agents) agentMap.set(a.id, a);
    }
    for (const event of agentEvents) {
      if (event.taskId === taskId && event.agentId) {
        const existing = agentMap.get(event.agentId);
        if (event.type === 'agent:spawned') {
          agentMap.set(event.agentId, event.data as unknown as Agent);
        } else if (existing) {
          agentMap.set(event.agentId, { ...existing, ...event.data } as Agent);
        }
      }
    }
    return Array.from(agentMap.values());
  }, [task, agentEvents, taskId]);

  const isWorking = agents.some((a) => a.status === 'working');

  const handleSend = useCallback(
    async (message: string) => {
      const userMsg: ChatMessage = {
        id: `local-${Date.now()}`,
        taskId,
        role: 'gulliver',
        content: message,
        timestamp: new Date().toISOString(),
      };
      setLocalMessages((prev) => [...prev, userMsg]);
      try {
        await sendMessage(taskId, message);
      } catch {
        const errMsg: ChatMessage = {
          id: `err-${Date.now()}`,
          taskId,
          role: 'system',
          content: 'Failed to send message.',
          timestamp: new Date().toISOString(),
        };
        setLocalMessages((prev) => [...prev, errMsg]);
      }
    },
    [taskId, sendMessage],
  );

  const handleApproveSpec = useCallback(async () => {
    if (!task) return;
    setActionPending('approve');
    try {
      const res = await fetch(`${API_URL}/api/tasks/${task.id}/approve-spec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`approve-spec failed: ${res.status} ${body}`);
      }
      const data = await res.json();
      setTask(data.task);
      setShowSpec(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionPending(null);
    }
  }, [task]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#0a0a0f]">
        <div className="text-center">
          <div className="text-4xl animate-pulse mb-4">🏰</div>
          <p className="text-gray-500">Loading task...</p>
        </div>
      </div>
    );
  }

  if (error && !task) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#0a0a0f]">
        <div className="text-center">
          <div className="text-4xl mb-4">⚠️</div>
          <p className="text-red-400">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen">
      <header className="flex items-center justify-between px-6 py-3 border-b border-[#1a1a2e] bg-[#0d0d14] gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <a href="/" className="text-gray-500 hover:text-gray-300 text-sm">
            ← Back
          </a>
          <span className="text-gray-600">|</span>
          <span className="text-2xl">🏰</span>
          <h1 className="text-lg font-bold truncate max-w-md">
            <span className="text-cyan-400">{task?.title || 'Task'}</span>
          </h1>
          {task?.status && (
            <span
              className={`text-xs px-2 py-0.5 rounded ${
                task.status === 'failed'
                  ? 'bg-red-900/40 text-red-300 border border-red-800'
                  : task.status === 'review'
                  ? 'bg-amber-900/40 text-amber-300 border border-amber-700'
                  : task.status === 'completed'
                  ? 'bg-green-900/40 text-green-300 border border-green-800'
                  : 'bg-[#1a1a2e] text-gray-400'
              }`}
            >
              {task.status}
            </span>
          )}
          {task?.repository && (
            <span className="text-xs text-gray-500 font-mono truncate">
              📦 {task.repository}@{task.baseBranch ?? 'main'}
            </span>
          )}
          {task?.devUrl && (
            <a
              href={task.devUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs px-2 py-0.5 rounded bg-cyan-900/30 border border-cyan-700/50 text-cyan-300 hover:bg-cyan-900/50"
            >
              🌐 Dev preview
            </a>
          )}
          {task?.pullRequestUrl && (
            <a
              href={task.pullRequestUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs px-2 py-0.5 rounded bg-purple-900/30 border border-purple-700/50 text-purple-300 hover:bg-purple-900/50"
            >
              🔀 Pull request{task.pullRequestNumber ? ` #${task.pullRequestNumber}` : ''}
            </a>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {task?.status === 'review' && (
            <>
              {task.pullRequestUrl && (
                <a
                  href={task.pullRequestUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs px-3 py-1 rounded bg-purple-700 hover:bg-purple-600 text-white"
                >
                  🔀 View PR{task.pullRequestNumber ? ` #${task.pullRequestNumber}` : ''} ↗
                </a>
              )}
              <button
                onClick={async () => {
                  if (!task) return;
                  setActionPending('ship');
                  try {
                    const updated = await shipTask(task.id);
                    setTask(updated);
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Ship failed');
                  } finally {
                    setActionPending(null);
                  }
                }}
                disabled={actionPending !== null}
                className="text-xs px-3 py-1 rounded bg-green-700 hover:bg-green-600 text-white disabled:opacity-50"
              >
                {actionPending === 'ship'
                  ? 'Shipping…'
                  : `🚀 Ship (${task.commitMode === 'direct' ? 'merge' : 'PR'})`}
              </button>
              <button
                onClick={async () => {
                  if (!task) return;
                  if (!confirm('Discard this task? Dev environment + branch will be deleted.'))
                    return;
                  setActionPending('discard');
                  try {
                    const updated = await discardTask(task.id);
                    setTask(updated);
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Discard failed');
                  } finally {
                    setActionPending(null);
                  }
                }}
                disabled={actionPending !== null}
                className="text-xs px-3 py-1 rounded bg-red-800 hover:bg-red-700 text-white disabled:opacity-50"
              >
                {actionPending === 'discard' ? 'Discarding…' : '🗑️ Discard'}
              </button>
            </>
          )}
          <span className={`text-xs ${connected ? 'text-green-400' : 'text-red-400'}`}>
            {connected ? '● Connected' : '○ Disconnected'}
          </span>
          <a href="/requests" className="text-xs text-gray-400 hover:text-cyan-300">
            📋 All requests
          </a>
        </div>
      </header>

      {(error || task?.errorMessage) && (
        <div className="px-6 py-2 bg-red-900/30 border-b border-red-800 text-red-300 text-xs flex items-center gap-2">
          <span>⚠️</span>
          <span className="flex-1 font-mono">{error || task?.errorMessage}</span>
          {error && (
            <button onClick={() => setError(null)} className="text-red-200 hover:text-white">
              ✕
            </button>
          )}
        </div>
      )}

      {task?.spec && task.status === 'specifying' && showSpec && (
        <div className="border-b border-purple-800/50 bg-purple-950/20">
          <div className="flex items-center justify-between px-6 py-2 text-xs">
            <span className="text-purple-300 font-semibold">
              📜 Specification ready — review and approve to start the build
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowSpec(false)}
                className="text-purple-400 hover:text-purple-200 px-2"
              >
                Hide
              </button>
              <button
                onClick={handleApproveSpec}
                disabled={actionPending === 'approve'}
                className="px-3 py-1 rounded bg-purple-700 hover:bg-purple-600 text-white disabled:opacity-50"
              >
                {actionPending === 'approve' ? 'Approving…' : '✓ Approve & Build'}
              </button>
            </div>
          </div>
          <pre className="px-6 pb-3 max-h-64 overflow-y-auto text-[11px] text-gray-300 whitespace-pre-wrap font-mono">
            {task.spec}
          </pre>
        </div>
      )}
      {task?.spec && task.status === 'specifying' && !showSpec && (
        <div className="px-6 py-1 bg-purple-950/20 border-b border-purple-800/30 text-xs flex items-center gap-3">
          <span className="text-purple-300">📜 Spec is ready</span>
          <button
            onClick={() => setShowSpec(true)}
            className="text-purple-400 hover:text-purple-200 underline"
          >
            Show
          </button>
          <button
            onClick={handleApproveSpec}
            disabled={actionPending === 'approve'}
            className="ml-auto px-3 py-0.5 rounded bg-purple-700 hover:bg-purple-600 text-white disabled:opacity-50"
          >
            {actionPending === 'approve' ? 'Approving…' : '✓ Approve & Build'}
          </button>
        </div>
      )}

      <main className="flex-1 flex overflow-hidden">
        <div className="w-[40%] p-3">
          <Terminal messages={allMessages} onSend={handleSend} isWorking={isWorking} />
        </div>

        <div className="flex-1 p-3 pl-0">
          <ActivityLog entries={taskActivity} title="Live Activity" />
        </div>

        <div className="w-[300px] flex flex-col p-3 pl-0 gap-3">
          <div className="h-[40%]">
            <LiliputIsland agents={agents} />
          </div>
          <div className="flex-1 bg-[#0d0d14] border border-[#1a1a2e] rounded-lg overflow-hidden">
            <AgentPanel agents={agents} />
          </div>
        </div>
      </main>
    </div>
  );
}
