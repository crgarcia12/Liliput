'use client';

import { useState, useCallback, useMemo } from 'react';
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
  const { connected, agentEvents, chatMessages: socketMessages } = useSocket();
  const { createTask, sendMessage } = useTasks();

  const [localMessages, setLocalMessages] = useState<ChatMessage[]>([]);
  const [currentTask, setCurrentTask] = useState<Task | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [isWorking, setIsWorking] = useState(false);

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
          // First message creates a task
          setIsWorking(true);
          const task = await createTask(message, message);
          setCurrentTask(task);

          const sysMsg: ChatMessage = {
            id: `sys-${Date.now()}`,
            taskId: task.id,
            role: 'liliput',
            content: `📋 Task created: "${task.title}"\n🏗️  Summoning the Liliputians...`,
            timestamp: new Date().toISOString(),
          };
          setLocalMessages((prev) => [...prev, sysMsg]);
        } else {
          await sendMessage(currentTask.id, message);
        }
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
    [currentTask, createTask, sendMessage]
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
