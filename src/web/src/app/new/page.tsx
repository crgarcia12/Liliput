'use client';

import { useState, useCallback, useMemo, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import Terminal from '../../components/Terminal';
import AgentPanel from '../../components/AgentPanel';
import TopBar from '../../components/TopBar';
import { useSocket } from '../../hooks/useSocket';
import { useTasks } from '../../hooks/useTasks';
import type { ChatMessage, Agent, Task, ModelOption, ModelsResponse } from '@shared/types';

const LiliputIsland = dynamic(() => import('../../components/LiliputIsland'), {
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

  // Prefill repo from ?repo=owner/name (set when launching from a repo node
  // on the workstreams list). Read client-side to avoid the SSR Suspense
  // requirement of useSearchParams.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const r = new URLSearchParams(window.location.search).get('repo');
    if (r && r.trim()) setTargetRepo(r.trim());
  }, []);
  const [baseBranch, setBaseBranch] = useState('main');
  const [commitMode, setCommitMode] = useState<'pr' | 'direct'>('pr');
  const [modelOptions, setModelOptions] = useState<readonly ModelOption[]>([]);
  const [model, setModel] = useState<string>('');
  // '' means "auto-derive" — server picks based on model id suffix.
  const [reasoningEffort, setReasoningEffort] = useState<'' | 'low' | 'medium' | 'high' | 'xhigh'>('');
  // Greenfield ("Create new project") state.
  const [projectMode, setProjectMode] = useState<'existing' | 'create'>('existing');
  const [newRepoName, setNewRepoName] = useState('');
  const [newRepoVisibility, setNewRepoVisibility] = useState<'public' | 'private'>('private');
  const [nameCheck, setNameCheck] = useState<{ available?: boolean; reason?: string; loading?: boolean }>({});

  // Fetch the curated Copilot SDK model list once on mount so the dropdown
  // and the persisted default both come from the server's source of truth.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/models')
      .then((r) => (r.ok ? (r.json() as Promise<ModelsResponse>) : null))
      .then((data) => {
        if (cancelled || !data) return;
        setModelOptions(data.options);
        setModel(data.default);
      })
      .catch(() => {
        // Non-fatal: dropdown stays empty, server picks its default.
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  // Debounced live name availability check for greenfield mode.
  useEffect(() => {
    if (projectMode !== 'create') return;
    const trimmed = newRepoName.trim();
    if (!trimmed) {
      setNameCheck({});
      return;
    }
    setNameCheck({ loading: true });
    const handle = setTimeout(() => {
      fetch(`/api/projects/check-name?name=${encodeURIComponent(trimmed)}`)
        .then((r) => r.json())
        .then((data: { available: boolean; reason?: string }) => {
          setNameCheck({ available: data.available, ...(data.reason ? { reason: data.reason } : {}) });
        })
        .catch(() => setNameCheck({}));
    }, 400);
    return () => clearTimeout(handle);
  }, [newRepoName, projectMode]);

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
          setIsWorking(true);

          // Greenfield path: create a brand-new GitHub repo + bootstrap.
          if (projectMode === 'create') {
            const trimmedName = newRepoName.trim();
            if (!trimmedName) throw new Error('Project name is required.');
            const res = await fetch('/api/projects', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name: trimmedName,
                description: message,
                visibility: newRepoVisibility,
                ...(model ? { model } : {}),
                ...(reasoningEffort ? { reasoningEffort } : {}),
              }),
            });
            if (!res.ok) {
              const body = (await res.json().catch(() => ({}))) as { error?: string };
              throw new Error(body.error ?? `Failed to create project (${res.status})`);
            }
            const data = (await res.json()) as { task: Task };
            setCurrentTask(data.task);
            // Same LLM-title backfill as the existing-repo path below.
            void (async () => {
              try {
                const r2 = await fetch('/api/title-suggest', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ input: message }),
                });
                if (!r2.ok) return;
                const { title } = (await r2.json()) as { title?: string };
                if (!title || !title.trim()) return;
                await fetch(`/api/tasks/${data.task.id}/title`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ title: title.trim() }),
                });
              } catch {
                /* best-effort */
              }
            })();
            // Mirror the existing-repo flow: send the description as a chat
            // message so /api/tasks/:id/chat triggers spec generation. Without
            // this, the new task sits in `clarifying` forever.
            try {
              await sendMessage(data.task.id, message);
            } catch {
              /* surface on task page */
            }
            router.push(`/task/${data.task.id}`);
            return;
          }

          // Existing-repo path (unchanged).
          const task = await createTask(message, message, {
            repository: targetRepo.trim() || undefined,
            baseBranch: baseBranch.trim() || 'main',
            commitMode,
            ...(model ? { model } : {}),
            ...(reasoningEffort ? { reasoningEffort } : {}),
          });
          setCurrentTask(task);
          // Fire-and-forget: ask the LLM for a tight 1-4 word title and
          // PATCH the task once it comes back. Failures are ignored — the
          // long heuristic title from `message` stays as a perfectly fine
          // fallback.
          void (async () => {
            try {
              const r = await fetch('/api/title-suggest', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ input: message }),
              });
              if (!r.ok) return;
              const { title } = (await r.json()) as { title?: string };
              if (!title || !title.trim()) return;
              await fetch(`/api/tasks/${task.id}/title`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: title.trim() }),
              });
            } catch {
              /* best-effort */
            }
          })();

          try {
            await sendMessage(task.id, message);
          } catch {
            /* surface on task page */
          }

          router.push(`/task/${task.id}`);
          return;
        }

        await sendMessage(currentTask.id, message);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        const errMsg: ChatMessage = {
          id: `err-${Date.now()}`,
          taskId: currentTask?.id || '',
          role: 'system',
          content: `❌ ${message}`,
          timestamp: new Date().toISOString(),
        };
        setLocalMessages((prev) => [...prev, errMsg]);
        setIsWorking(false);
      }
    },
    [currentTask, createTask, sendMessage, targetRepo, baseBranch, commitMode, model, reasoningEffort, router, projectMode, newRepoName, newRepoVisibility]
  );

  const activeCount = agents.filter((a) => a.status === 'working').length;
  const completedCount = agents.filter((a) => a.status === 'completed').length;
  const failedCount = agents.filter((a) => a.status === 'failed').length;

  return (
    <div className="flex flex-col h-screen">
      <TopBar
        subtitle="New workstream"
        connected={connected}
        hideNewCta
        extras={
          currentTask ? (
            <span className="text-gray-500">Task: {currentTask.status}</span>
          ) : undefined
        }
      />

      {/* Main content */}
      {!currentTask && (
        <div className="px-6 py-3 border-b border-[#1a1a2e] bg-[#0d0d14] flex flex-wrap items-center gap-3 text-xs">
          <div className="flex items-center gap-3 mr-4 pr-4 border-r border-[#1a1a2e]">
            <label className="flex items-center gap-1 cursor-pointer">
              <input
                type="radio"
                name="projectMode"
                value="existing"
                checked={projectMode === 'existing'}
                onChange={() => setProjectMode('existing')}
              />
              <span className="text-gray-300">Use existing repo</span>
            </label>
            <label className="flex items-center gap-1 cursor-pointer">
              <input
                type="radio"
                name="projectMode"
                value="create"
                checked={projectMode === 'create'}
                onChange={() => setProjectMode('create')}
              />
              <span className="text-gray-300">Create new project</span>
            </label>
          </div>
          {projectMode === 'existing' ? (
            <>
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
            </>
          ) : (
            <>
              <label className="flex items-center gap-2">
                <span className="text-gray-400">New repo name:</span>
                <input
                  type="text"
                  value={newRepoName}
                  onChange={(e) => setNewRepoName(e.target.value)}
                  placeholder="my-new-app"
                  className="bg-[#050510] border border-[#1a1a2e] rounded px-2 py-1 w-56 text-gray-200 focus:outline-none focus:border-cyan-500"
                />
                {nameCheck.loading && <span className="text-gray-500">checking…</span>}
                {!nameCheck.loading && nameCheck.available === true && (
                  <span className="text-green-400">✓ available</span>
                )}
                {!nameCheck.loading && nameCheck.available === false && (
                  <span className="text-red-400" title={nameCheck.reason}>✗ {nameCheck.reason ?? 'unavailable'}</span>
                )}
              </label>
              <label className="flex items-center gap-2">
                <span className="text-gray-400">Visibility:</span>
                <select
                  value={newRepoVisibility}
                  onChange={(e) => setNewRepoVisibility(e.target.value as 'public' | 'private')}
                  className="bg-[#050510] border border-[#1a1a2e] rounded px-2 py-1 text-gray-200 focus:outline-none focus:border-cyan-500"
                >
                  <option value="private">Private</option>
                  <option value="public">Public</option>
                </select>
              </label>
            </>
          )}
          <label className="flex items-center gap-2">
            <span className="text-gray-400">Model:</span>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="bg-[#050510] border border-[#1a1a2e] rounded px-2 py-1 text-gray-200 focus:outline-none focus:border-cyan-500"
              disabled={modelOptions.length === 0}
            >
              {modelOptions.length === 0 && <option value="">(loading…)</option>}
              {modelOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-gray-400">Reasoning:</span>
            <select
              value={reasoningEffort}
              onChange={(e) => setReasoningEffort(e.target.value as typeof reasoningEffort)}
              className="bg-[#050510] border border-[#1a1a2e] rounded px-2 py-1 text-gray-200 focus:outline-none focus:border-cyan-500"
              title="Some models (like claude-opus-4.7-xhigh) only accept ONE effort. Auto picks it from the model id suffix."
            >
              <option value="">auto</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="xhigh">xhigh</option>
            </select>
          </label>
          <span className="text-gray-600 ml-auto">
            {projectMode === 'create'
              ? 'Creates a new GitHub repo under your account, then runs spec2cloud init.'
              : `Leave repo empty to use the default (${process.env.NEXT_PUBLIC_DEFAULT_REPO || 'configured server-side'})`}
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
