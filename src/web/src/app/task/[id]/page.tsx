'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import Terminal from '../../../components/Terminal';
import AgentPanel from '../../../components/AgentPanel';
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

export default function TaskPage() {
  const params = useParams();
  const taskId = params.id as string;

  const { connected, agentEvents, chatMessages: socketMessages, joinTask, leaveTask } = useSocket();
  const { getTask, sendMessage, shipTask, discardTask } = useTasks();

  const [task, setTask] = useState<Task | null>(null);
  const [localMessages, setLocalMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState<'ship' | 'discard' | null>(null);

  // Load task data
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const t = await getTask(taskId);
        if (!cancelled) {
          setTask(t);
          setLocalMessages(t.chatHistory || []);
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
    return () => { cancelled = true; };
  }, [taskId, getTask]);

  // Join socket room
  useEffect(() => {
    if (connected && taskId) {
      joinTask(taskId);
      return () => leaveTask(taskId);
    }
  }, [connected, taskId, joinTask, leaveTask]);

  // Refresh task whenever a status event arrives
  useEffect(() => {
    if (!taskId) return;
    const handler = (e: MessageEvent) => {
      if (e.data === `task-status:${taskId}`) {
        getTask(taskId).then(setTask).catch(() => {});
      }
    };
    window.addEventListener('message', handler);
    // Poll every 5s while task is in an active build state (cheap fallback for live updates)
    const interval = setInterval(() => {
      if (task && ['building', 'deploying', 'review', 'shipping'].includes(task.status)) {
        getTask(taskId).then(setTask).catch(() => {});
      }
    }, 5000);
    return () => {
      window.removeEventListener('message', handler);
      clearInterval(interval);
    };
  }, [taskId, task, getTask]);

  const allMessages = useMemo(
    () => [...localMessages, ...socketMessages],
    [localMessages, socketMessages]
  );

  // Build agents from task data + live events
  const agents = useMemo(() => {
    const agentMap = new Map<string, Agent>();
    if (task?.agents) {
      for (const a of task.agents) {
        agentMap.set(a.id, a);
      }
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
    [taskId, sendMessage]
  );

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

  if (error) {
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
      {/* Top bar */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-[#1a1a2e] bg-[#0d0d14]">
        <div className="flex items-center gap-3">
          <a href="/" className="text-gray-500 hover:text-gray-300 text-sm">← Back</a>
          <span className="text-gray-600">|</span>
          <span className="text-2xl">🏰</span>
          <h1 className="text-lg font-bold truncate max-w-md">
            <span className="text-cyan-400">{task?.title || 'Task'}</span>
          </h1>
          {task?.status && (
            <span className="text-xs px-2 py-0.5 rounded bg-[#1a1a2e] text-gray-400">
              {task.status}
            </span>
          )}
          {task?.devUrl && (
            <a
              href={task.devUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs px-2 py-0.5 rounded bg-cyan-900/30 border border-cyan-700/50 text-cyan-300 hover:bg-cyan-900/50"
              title="Open the live dev environment"
            >
              🌐 Open dev preview
            </a>
          )}
          {task?.pullRequestUrl && (
            <a
              href={task.pullRequestUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs px-2 py-0.5 rounded bg-purple-900/30 border border-purple-700/50 text-purple-300 hover:bg-purple-900/50"
            >
              🔀 PR
            </a>
          )}
        </div>
        <div className="flex items-center gap-3">
          {task?.status === 'review' && (
            <>
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
                {actionPending === 'ship' ? 'Shipping…' : `🚀 Ship (${task.commitMode === 'direct' ? 'merge' : 'PR'})`}
              </button>
              <button
                onClick={async () => {
                  if (!task) return;
                  if (!confirm('Discard this task? Dev environment + branch will be deleted.')) return;
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
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 flex overflow-hidden">
        {/* Left: Terminal */}
        <div className="flex-1 p-3">
          <Terminal messages={allMessages} onSend={handleSend} isWorking={isWorking} />
        </div>

        {/* Right sidebar */}
        <div className="w-[350px] flex flex-col p-3 pl-0 gap-3">
          <div className="h-[45%]">
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
