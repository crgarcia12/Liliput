'use client';

import { useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import Terminal from '../components/Terminal';
import AgentPanel from '../components/AgentPanel';
import { useSocket } from '../hooks/useSocket';
import { useTasks } from '../hooks/useTasks';
import type { ChatMessage, Agent, Task } from '@shared/types';

const LiliputIsland = dynamic(() => import('../components/LiliputIsland'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center bg-[#050510] rounded-lg border border-[#1a1a2e]">
      <div className="text-center">
        <div className="text-4xl animate-pulse mb-2">🏰</div>
        <p className="text-gray-500 text-sm">Loading Liliput Island...</p>
      </div>
    </div>
  ),
});

export default function Home() {
  const router = useRouter();
  const { connected, agentEvents, chatMessages: socketMessages } = useSocket();
  const { createTask, sendMessage } = useTasks();

  const [localMessages, setLocalMessages] = useState<ChatMessage[]>([]);
  const [currentTask, setCurrentTask] = useState<Task | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [isWorking, setIsWorking] = useState(false);
  const [targetRepo, setTargetRepo] = useState('');
  const [baseBranch, setBaseBranch] = useState('main');
  const [commitMode, setCommitMode] = useState<'pr' | 'direct'>('pr');

  // Merge local + socket messages
  const allMessages = useMemo(
    () => [...localMessages, ...socketMessages],
    [localMessages, socketMessages]
  );

  // Process agent events into agents list
  useMemo(() => {
    const agentMap = new Map<string, Agent>();
    for (const event of agentEvents) {
      if (event.agentId) {
        const existing = agentMap.get(event.agentId);
        if (event.type === 'agent:spawned') {
          agentMap.set(event.agentId, event.data as unknown as Agent);
        } else if (existing) {
          agentMap.set(event.agentId, { ...existing, ...event.data } as Agent);
        }
      }
    }
    setAgents(Array.from(agentMap.values()));
    const hasWorking = Array.from(agentMap.values()).some(
      (a) => a.status === 'working'
    );
    setIsWorking(hasWorking);
  }, [agentEvents]);

  const handleSend = useCallback(
    async (message: string) => {
      // Add user message locally
      const userMsg: ChatMessage = {
        id: `local-${Date.now()}`,
        taskId: currentTask?.id || '',
        role: 'gulliver',
        content: message,
        timestamp: new Date().toISOString(),
      };
      setLocalMessages((prev) => [...prev, userMsg]);

      try {
        if (!currentTask) {
          // First message creates a task — then we redirect to /task/<id>
          // so the user lands on the live activity / spec / chat view.
          setIsWorking(true);
          const task = await createTask(message, message, {
            repository: targetRepo.trim() || undefined,
            baseBranch: baseBranch.trim() || 'main',
            commitMode,
          });
          setCurrentTask(task);

          // Send the same message as a chat so the spec generator kicks off
          try {
            await sendMessage(task.id, message);
          } catch {
            /* surface on task page */
          }

          router.push(`/task/${task.id}`);
          return;
        }

        await sendMessage(currentTask.id, message);
      } catch {
        const errMsg: ChatMessage = {
          id: `err-${Date.now()}`,
          taskId: currentTask?.id || '',
          role: 'system',
          content: 'Failed to send message. Is the API running?',
          timestamp: new Date().toISOString(),
        };
        setLocalMessages((prev) => [...prev, errMsg]);
        setIsWorking(false);
      }
    },
    [currentTask, createTask, sendMessage, targetRepo, baseBranch, commitMode, router]
  );

  const activeCount = agents.filter((a) => a.status === 'working').length;
  const completedCount = agents.filter((a) => a.status === 'completed').length;
  const failedCount = agents.filter((a) => a.status === 'failed').length;

  return (
    <div className="flex flex-col h-screen">
      {/* Top bar */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-[#1a1a2e] bg-[#0d0d14]">
        <div className="flex items-center gap-3">
          <span className="text-2xl">🏰</span>
          <h1 className="text-lg font-bold tracking-tight">
            <span className="text-cyan-400">Liliput</span>
            <span className="text-gray-500 font-normal"> — Agent Orchestrator</span>
          </h1>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <a href="/requests" className="text-gray-400 hover:text-cyan-300">
            📋 Requests
          </a>
          <span className={connected ? 'text-green-400' : 'text-red-400'}>
            {connected ? '● Connected' : '○ Disconnected'}
          </span>
          {currentTask && (
            <span className="text-gray-500">
              Task: {currentTask.status}
            </span>
          )}
        </div>
      </header>

      {/* Main content */}
      {!currentTask && (
        <div className="px-6 py-3 border-b border-[#1a1a2e] bg-[#0d0d14] flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-2">
            <span className="text-gray-400">Target repo:</span>
            <input
              type="text"
              value={targetRepo}
              onChange={(e) => setTargetRepo(e.target.value)}
              placeholder="owner/repo (e.g. crgarcia12/Liliput)"
              className="bg-[#050510] border border-[#1a1a2e] rounded px-2 py-1 w-72 text-gray-200 focus:outline-none focus:border-cyan-500"
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="text-gray-400">Base:</span>
            <input
              type="text"
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              className="bg-[#050510] border border-[#1a1a2e] rounded px-2 py-1 w-24 text-gray-200 focus:outline-none focus:border-cyan-500"
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="text-gray-400">Commit mode:</span>
            <select
              value={commitMode}
              onChange={(e) => setCommitMode(e.target.value as 'pr' | 'direct')}
              className="bg-[#050510] border border-[#1a1a2e] rounded px-2 py-1 text-gray-200 focus:outline-none focus:border-cyan-500"
            >
              <option value="pr">Pull request</option>
              <option value="direct">Direct (auto-merge)</option>
            </select>
          </label>
          <span className="text-gray-600 ml-auto">
            Leave repo empty to use the default ({process.env.NEXT_PUBLIC_DEFAULT_REPO || 'configured server-side'})
          </span>
        </div>
      )}

      <main className="flex-1 flex overflow-hidden">
        {/* Left: Terminal (60%) */}
        <div className="w-[60%] p-3">
          <Terminal
            messages={allMessages}
            onSend={handleSend}
            isWorking={isWorking}
          />
        </div>

        {/* Right: 3D + Agent Panel (40%) */}
        <div className="w-[40%] flex flex-col p-3 pl-0 gap-3">
          {/* 3D Island */}
          <div className="flex-1 min-h-0">
            <LiliputIsland agents={agents} />
          </div>

          {/* Agent Panel */}
          <div className="h-[40%] bg-[#0d0d14] border border-[#1a1a2e] rounded-lg overflow-hidden">
            <AgentPanel agents={agents} />
          </div>
        </div>
      </main>

      {/* Bottom status bar */}
      <footer className="flex items-center justify-between px-6 py-2 border-t border-[#1a1a2e] bg-[#0d0d14] text-xs">
        <div className="flex items-center gap-6">
          <span className="text-yellow-400">⚡ {activeCount} active</span>
          <span className="text-green-400">✓ {completedCount} completed</span>
          <span className="text-red-400">✗ {failedCount} failed</span>
        </div>
        <span className="text-gray-600">
          {agents.length} Liliputian{agents.length !== 1 ? 's' : ''} in the kingdom
        </span>
      </footer>
    </div>
  );
}
