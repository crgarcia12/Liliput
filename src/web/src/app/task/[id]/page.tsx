'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import Terminal from '../../../components/Terminal';
import AgentPanel from '../../../components/AgentPanel';
import ActivityLog from '../../../components/ActivityLog';
import AgentPipeline from '../../../components/AgentPipeline';
import TurnList from '../../../components/TurnList';
import PhaseStepper from '../../../components/PhaseStepper';
import ResizableSplit from '../../../components/ResizableSplit';
import CostBadge from '../../../components/CostBadge';
import { useSocket } from '../../../hooks/useSocket';
import { useTasks } from '../../../hooks/useTasks';
import { useProfileDefaults } from '../../../hooks/useProfileDefaults';
import { get as apiGet } from '../../../lib/api-client';
import {
  rememberChatConfig,
  type ReasoningEffortSelection,
} from '../../../lib/chat-config-storage';
import type { Task, ChatMessage, Agent, ModelOption, ModelsResponse, CostRollup } from '@shared/types';

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

  const { connected, agentEvents, chatMessages: socketMessages, activity, pipeline: livePipeline, joinTask, leaveTask } =
    useSocket();
  const { getTask, sendMessage, shipTask, discardTask, closeTask, cancelTask, setTaskModel, setTaskReasoningEffort } = useTasks();
  const { defaults: profileDefaults } = useProfileDefaults();
  const coderProfileLabel =
    profileDefaults.find((d) => d.role === 'coder')?.effectiveModel ?? '';
  const reviewerProfileLabel =
    profileDefaults.find((d) => d.role === 'reviewer')?.effectiveModel ?? '';

  const [task, setTask] = useState<Task | null>(null);
  const [localMessages, setLocalMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState<'ship' | 'discard' | 'close' | 'cancel' | 'approve' | null>(null);
  const [showSpec, setShowSpec] = useState(true);
  const [editingSpec, setEditingSpec] = useState(false);
  const [specDraft, setSpecDraft] = useState('');
  const [specSaving, setSpecSaving] = useState(false);
  const [modelOptions, setModelOptions] = useState<readonly ModelOption[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelsSource, setModelsSource] = useState<'sdk' | 'fallback' | null>(null);
  const [taskCost, setTaskCost] = useState<CostRollup | undefined>(undefined);
  const [modelPending, setModelPending] = useState(false);
  const [reasoningPending, setReasoningPending] = useState(false);
  const [reviewerPending, setReviewerPending] = useState(false);

  async function patchReviewer(
    taskId: string,
    body: {
      reviewerModel?: string | null;
      reviewerReasoningEffort?: ReasoningEffortSelection | null;
      reviewerEnabled?: boolean;
    },
  ): Promise<Task> {
    setReviewerPending(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}/reviewer`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error ?? `Failed to update reviewer (${res.status})`);
      }
      const data = (await res.json()) as { task: Task };
      rememberChatConfig(body);
      return data.task;
    } finally {
      setReviewerPending(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    apiGet<ModelsResponse>('/api/models')
      .then((data) => {
        if (cancelled) return;
        setModelsError(null);
        setModelsSource(data.source ?? 'sdk');
        setModelOptions(data.options);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        console.error('Failed to load /api/models', err);
        setModelsError(msg);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll task cost every 15s. Cost moves slowly (per-call cents) but we still
  // want it to refresh while the user watches an agent burn through tokens.
  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      try {
        const c = await apiGet<CostRollup>(`/api/tasks/${taskId}/cost`);
        if (!cancelled) setTaskCost(c);
      } catch {
        // best-effort; keep stale value rather than flashing the badge
      }
    };
    void refresh();
    const id = setInterval(() => void refresh(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [taskId]);

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
        prev.model === next.model &&
        prev.reasoningEffort === next.reasoningEffort &&
        prev.reviewerModel === next.reviewerModel &&
        prev.reviewerReasoningEffort === next.reviewerReasoningEffort &&
        prev.reviewerEnabled === next.reviewerEnabled &&
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

  // Surface socket connection state to the global VersionFooter.
  // Each page owns its own socket; the footer listens on this CustomEvent.
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('liliput:connection', { detail: { connected } }),
    );
    return () => {
      // On unmount the next page's socket effect will overwrite, but if no
      // socket-using page mounts after this one we want the footer to fall
      // back to "no socket" rather than showing stale state. Send a sentinel
      // by re-firing as `connected: false` and letting the next page (if any)
      // override immediately.
      window.dispatchEvent(
        new CustomEvent('liliput:connection', { detail: { connected: false } }),
      );
    };
  }, [connected]);

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

  // Treat the task as actively working only when both an agent is in the
  // 'working' state AND the task isn't in a terminal status. Without the
  // terminal-status gate, stale 'working' rows from a prior run kept the
  // "Liliputians are working…" indicator on after the task had completed
  // / failed / been discarded.
  const isTerminalStatus =
    task?.status === 'completed' ||
    task?.status === 'discarded' ||
    task?.status === 'failed' ||
    task?.status === 'deleting' ||
    task?.status === 'review';
  const isWorking = !isTerminalStatus && agents.some((a) => a.status === 'working');

  const handleSend = useCallback(
    async (message: string) => {
      // Reopen guard: chatting on a closed/cancelled workstream silently
      // reopens it (the API routes a 'completed'/'failed' chat through
      // iterateTask). Confirm once so it doesn't happen by accident.
      const reopens =
        task?.status === 'completed' ||
        task?.status === 'discarded' ||
        task?.status === 'failed';
      if (reopens) {
        const label =
          task?.status === 'failed' ? 'cancelled' : task?.status;
        if (!confirm(`This workstream is "${label}". Sending a message will reopen it and run another agent turn. Continue?`)) {
          return;
        }
      }
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
    [taskId, sendMessage, task?.status],
  );

  const handleApproveSpec = useCallback(async () => {
    if (!task) return;
    setActionPending('approve');
    try {
      const body = editingSpec && specDraft.trim() ? { spec: specDraft.trim() } : {};
      const res = await fetch(`${API_URL}/api/tasks/${task.id}/approve-spec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`approve-spec failed: ${res.status} ${errBody}`);
      }
      const data = await res.json();
      setTask(data.task);
      setEditingSpec(false);
      setShowSpec(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionPending(null);
    }
  }, [task, editingSpec, specDraft]);

  const handleStartEditSpec = useCallback(() => {
    if (!task?.spec) return;
    setSpecDraft(task.spec);
    setEditingSpec(true);
    setShowSpec(true);
  }, [task?.spec]);

  const handleCancelEditSpec = useCallback(() => {
    setEditingSpec(false);
    setSpecDraft('');
  }, []);

  const handleSaveSpec = useCallback(async () => {
    if (!task) return;
    const trimmed = specDraft.trim();
    if (!trimmed) return;
    setSpecSaving(true);
    try {
      const res = await fetch(`${API_URL}/api/tasks/${task.id}/spec`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: trimmed }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`save spec failed: ${res.status} ${body}`);
      }
      const data = await res.json();
      setTask(data.task);
      setEditingSpec(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSpecSaving(false);
    }
  }, [task, specDraft]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full bg-[#0a0a0f]">
        <div className="text-center">
          <div className="text-4xl animate-pulse mb-4">🏰</div>
          <p className="text-gray-500">Loading task...</p>
        </div>
      </div>
    );
  }

  if (error && !task) {
    return (
      <div className="flex items-center justify-center h-full bg-[#0a0a0f]">
        <div className="text-center">
          <div className="text-4xl mb-4">⚠️</div>
          <p className="text-red-400">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/*
        Two-line header.
          Row 1: brand · workstream/task title · 📦 repo · 🧠 model · ⚙ effort · status
          Row 2: phase stepper (clarify→…→ship) with elapsed
        Right side spans both rows: 🌐 Dev preview + 📋 Workstreams (and PR / ship / discard when in review).
        The previous "● Connected" + "FE x.y.z | BE x.y.z" overlap with header
        text is fixed by moving both into the global VersionFooter bar.
      */}
      <header className="border-b border-[#1a1a2e] bg-[#0d0d14]">
        <div className="flex items-stretch gap-3 px-4 py-2">
          <div className="flex-1 min-w-0 flex flex-col gap-1.5 justify-center">
            {/* Row 1 — identity + config */}
            <div className="flex items-center gap-2 min-w-0 flex-wrap">
              {task?.repository && (
                <span className="text-xs text-gray-500 font-mono truncate shrink-0">
                  📦 {task.repository}@{task.baseBranch ?? 'main'}
                </span>
              )}
              <span className="text-gray-700">·</span>
              <h1 className="text-sm font-bold truncate min-w-0">
                <span className="text-cyan-400">{task?.title || 'Task'}</span>
              </h1>
              {task?.status && (
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${
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
              {taskCost && <CostBadge rollup={taskCost} />}
              {task && task.status !== 'completed' && task.status !== 'deleting' && modelOptions.length > 0 && (
                <label className="flex items-center gap-1 text-xs shrink-0">
                  <span className="text-gray-500">🧠</span>
                  <select
                    value={task.model ?? '__profile_default__'}
                    disabled={modelPending}
                    onChange={async (e) => {
                      const next = e.target.value;
                      if (!task) return;
                      if (next === '__profile_default__') {
                        if (!task.model) return;
                        setModelPending(true);
                        try {
                          const updated = await setTaskModel(task.id, null);
                          setTask(updated);
                        } catch (err) {
                          setError(err instanceof Error ? err.message : 'Failed to unpin model');
                        } finally {
                          setModelPending(false);
                        }
                        return;
                      }
                      if (next === (task.model ?? '__profile_default__')) return;
                      setModelPending(true);
                      try {
                        const updated = await setTaskModel(task.id, next);
                        setTask(updated);
                      } catch (err) {
                        setError(err instanceof Error ? err.message : 'Failed to switch model');
                      } finally {
                        setModelPending(false);
                      }
                    }}
                    className="bg-[#050510] border border-[#1a1a2e] rounded px-1.5 py-0.5 text-gray-300 focus:outline-none focus:border-cyan-500 disabled:opacity-50"
                    title="Copilot SDK model — applies on next agent turn"
                  >
                    <option value="__profile_default__">
                      🔗 Profile default{coderProfileLabel ? ` (${coderProfileLabel})` : ''}
                    </option>
                    {modelOptions.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  {modelsSource === 'fallback' && (
                    <span
                      className="text-amber-400"
                      title="Copilot SDK list unavailable — showing a small curated fallback list. Check API logs."
                    >
                      ⚠
                    </span>
                  )}
                </label>
              )}
              {task && task.status !== 'completed' && task.status !== 'deleting' && modelOptions.length === 0 && modelsError && (
                <span
                  className="text-red-400 text-xs shrink-0"
                  title={modelsError}
                >
                  ⚠ models failed to load
                </span>
              )}
              {task && task.status !== 'completed' && task.status !== 'deleting' && (
                <label className="flex items-center gap-1 text-xs shrink-0">
                  <span className="text-gray-500">⚙</span>
                  <select
                    value={task.reasoningEffort ?? ''}
                    disabled={reasoningPending}
                    onChange={async (e) => {
                      const next = e.target.value as '' | 'low' | 'medium' | 'high' | 'xhigh';
                      if (!task || next === (task.reasoningEffort ?? '')) return;
                      setReasoningPending(true);
                      try {
                        const updated = await setTaskReasoningEffort(task.id, next);
                        setTask(updated);
                      } catch (err) {
                        setError(err instanceof Error ? err.message : 'Failed to switch reasoning effort');
                      } finally {
                        setReasoningPending(false);
                      }
                    }}
                    className="bg-[#050510] border border-[#1a1a2e] rounded px-1.5 py-0.5 text-gray-300 focus:outline-none focus:border-cyan-500 disabled:opacity-50"
                    title="Reasoning effort — applies on next agent turn. Some models (e.g. claude-opus-4.7-xhigh) only accept ONE value; auto picks it from the model id suffix."
                  >
                    <option value="">auto</option>
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                    <option value="xhigh">xhigh</option>
                  </select>
                </label>
              )}
              {task && task.status !== 'completed' && task.status !== 'deleting' && modelOptions.length > 0 && (
                <label
                  className="flex items-center gap-1 text-xs shrink-0"
                  title="Reviewer Agent — a second model that watches the Coder and posts feedback to chat only when it spots something important (bug, security issue, missed requirement). Silent otherwise."
                >
                  <span className="text-violet-400">🔍</span>
                  <select
                    value={task.reviewerModel ?? '__profile_default__'}
                    disabled={reviewerPending}
                    onChange={async (e) => {
                      const next = e.target.value;
                      if (!task) return;
                      if (next === '__profile_default__') {
                        if (!task.reviewerModel && task.reviewerEnabled !== false) return;
                        try {
                          const updated = await patchReviewer(task.id, {
                            reviewerModel: null,
                            reviewerEnabled: true,
                          });
                          setTask(updated);
                        } catch (err) {
                          setError(err instanceof Error ? err.message : 'Failed to unpin reviewer');
                        }
                        return;
                      }
                      if (next === (task.reviewerModel ?? '__profile_default__')) return;
                      try {
                        const updated = await patchReviewer(task.id, {
                          reviewerModel: next === '' ? null : next,
                        });
                        setTask(updated);
                      } catch (err) {
                        setError(err instanceof Error ? err.message : 'Failed to switch reviewer');
                      }
                    }}
                    className="bg-[#050510] border border-[#1a1a2e] rounded px-1.5 py-0.5 text-violet-300 focus:outline-none focus:border-violet-500 disabled:opacity-50"
                  >
                    <option value="__profile_default__">
                      🔗 Profile default{reviewerProfileLabel ? ` (${reviewerProfileLabel})` : ' (off)'}
                    </option>
                    <option value="">(force off)</option>
                    {modelOptions.map((m) => (
                      <option key={`rev-${m.id}`} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {task && task.reviewerModel && task.status !== 'completed' && task.status !== 'deleting' && (
                <label className="flex items-center gap-1 text-xs shrink-0" title="Reviewer reasoning effort">
                  <span className="text-violet-400">⚙</span>
                  <select
                    value={task.reviewerReasoningEffort ?? ''}
                    disabled={reviewerPending}
                    onChange={async (e) => {
                      const next = e.target.value as '' | 'low' | 'medium' | 'high' | 'xhigh';
                      if (!task || next === (task.reviewerReasoningEffort ?? '')) return;
                      try {
                        const updated = await patchReviewer(task.id, {
                          reviewerReasoningEffort: next === '' ? null : next,
                        });
                        setTask(updated);
                      } catch (err) {
                        setError(err instanceof Error ? err.message : 'Failed to switch reviewer reasoning');
                      }
                    }}
                    className="bg-[#050510] border border-[#1a1a2e] rounded px-1.5 py-0.5 text-violet-300 focus:outline-none focus:border-violet-500 disabled:opacity-50"
                  >
                    <option value="">auto</option>
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                    <option value="xhigh">xhigh</option>
                  </select>
                </label>
              )}
            </div>
            {/* Row 2 — phase stepper + elapsed */}
            <div className="flex items-center gap-2 min-w-0 overflow-x-auto">
              {task && <PhaseStepper task={task} agents={agents} />}
            </div>
          </div>
          {/* Right side — primary actions, span both rows */}
          <div className="flex items-stretch gap-2 shrink-0">
            <a
              href={task?.devUrl || '#'}
              onClick={(e) => {
                if (!task?.devUrl) e.preventDefault();
              }}
              target={task?.devUrl ? '_blank' : undefined}
              rel="noopener noreferrer"
              aria-disabled={!task?.devUrl}
              className={`flex flex-col items-center justify-center px-3 rounded text-xs whitespace-nowrap border ${
                task?.devUrl
                  ? 'bg-cyan-900/30 border-cyan-700/50 text-cyan-300 hover:bg-cyan-900/50'
                  : 'bg-[#0a0a14] border-[#1a1a2e] text-gray-600 cursor-not-allowed'
              }`}
              title={task?.devUrl ? 'Open dev preview in new tab' : 'No dev preview yet'}
            >
              <span className="text-base leading-none">🌐</span>
              <span className="leading-tight">Dev preview</span>
            </a>
            <Link
              href="/dashboard"
              className="flex flex-col items-center justify-center px-3 rounded text-xs whitespace-nowrap border bg-[#15152a] border-[#1a1a2e] text-gray-300 hover:bg-[#1a1a2e] hover:text-cyan-300"
              title="Back to workstreams list"
            >
              <span className="text-base leading-none">📋</span>
              <span className="leading-tight">Workstreams</span>
            </Link>
            {/* Action bar
                - PR link: always visible when a PR exists (any status).
                - Ship / Discard: review state only.
                - Cancel: while an agent is actively working — aborts the turn.
                - Close: any non-terminal state — park work without opening a PR. */}
            {task && (task.pullRequestUrl || task.status === 'review' || isWorking || !isTerminalStatus) && (
              <div className="flex flex-col gap-1 justify-center">
                {task.pullRequestUrl && (
                  <a
                    href={task.pullRequestUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] px-2 py-0.5 rounded bg-purple-700 hover:bg-purple-600 text-white text-center"
                  >
                    🔀 PR{task.pullRequestNumber ? ` #${task.pullRequestNumber}` : ''} ↗
                  </a>
                )}
                <div className="flex gap-1">
                  {task.status === 'review' && (
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
                        className="text-[11px] px-2 py-0.5 rounded bg-green-700 hover:bg-green-600 text-white disabled:opacity-50"
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
                        className="text-[11px] px-2 py-0.5 rounded bg-red-800 hover:bg-red-700 text-white disabled:opacity-50"
                        title="Discard — delete dev env, close PR, delete branch"
                      >
                        {actionPending === 'discard' ? 'Discarding…' : '🗑️'}
                      </button>
                    </>
                  )}
                  {isWorking && (
                    <button
                      onClick={async () => {
                        if (!task) return;
                        setActionPending('cancel');
                        try {
                          const updated = await cancelTask(task.id);
                          setTask(updated);
                        } catch (err) {
                          setError(err instanceof Error ? err.message : 'Cancel failed');
                        } finally {
                          setActionPending(null);
                        }
                      }}
                      disabled={actionPending !== null}
                      className="text-[11px] px-2 py-0.5 rounded bg-orange-700 hover:bg-orange-600 text-white disabled:opacity-50"
                      title="Stop the current agent turn — branch + dev env stay"
                    >
                      {actionPending === 'cancel' ? 'Cancelling…' : '⏹ Cancel'}
                    </button>
                  )}
                  {!isTerminalStatus && (
                    <button
                      onClick={async () => {
                        if (!task) return;
                        if (!confirm('Close this workstream? The branch and any commits stay on the remote (no PR). The dev environment will be paused.'))
                          return;
                        setActionPending('close');
                        try {
                          const updated = await closeTask(task.id);
                          setTask(updated);
                        } catch (err) {
                          setError(err instanceof Error ? err.message : 'Close failed');
                        } finally {
                          setActionPending(null);
                        }
                      }}
                      disabled={actionPending !== null}
                      className="text-[11px] px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600 text-white disabled:opacity-50"
                      title="Close — keep branch + commits, no PR"
                    >
                      {actionPending === 'close' ? 'Closing…' : '🏁 Close'}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
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

      {task?.spec && showSpec && (
        <div className="border-b border-purple-800/50 bg-purple-950/20">
          <div className="flex items-center justify-between px-6 py-2 text-xs">
            <span className="text-purple-300 font-semibold">
              {task.status === 'specifying' && task.requireSpecApproval === true
                ? `📜 Specification ready — review${editingSpec ? ' & edit' : ', edit,'} and approve to start the build`
                : '📜 Internal implementation specification'}
            </span>
            <div className="flex items-center gap-2">
              {task.status === 'specifying' && task.requireSpecApproval === true && editingSpec ? (
                <>
                  <button
                    onClick={handleCancelEditSpec}
                    disabled={specSaving}
                    className="text-purple-400 hover:text-purple-200 px-2 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSaveSpec}
                    disabled={specSaving || !specDraft.trim()}
                    className="px-3 py-1 rounded bg-purple-800 hover:bg-purple-700 text-white disabled:opacity-50"
                  >
                    {specSaving ? 'Saving…' : '💾 Save'}
                  </button>
                </>
              ) : task.status === 'specifying' && task.requireSpecApproval === true ? (
                <>
                  <button
                    onClick={handleStartEditSpec}
                    className="text-purple-400 hover:text-purple-200 px-2"
                  >
                    ✎ Edit
                  </button>
                  <button
                    onClick={() => setShowSpec(false)}
                    className="text-purple-400 hover:text-purple-200 px-2"
                  >
                    Hide
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setShowSpec(false)}
                  className="text-purple-400 hover:text-purple-200 px-2"
                >
                  Hide
                </button>
              )}
              {task.status === 'specifying' && task.requireSpecApproval === true && (
                <button
                  onClick={handleApproveSpec}
                  disabled={actionPending === 'approve' || specSaving}
                  className="px-3 py-1 rounded bg-purple-700 hover:bg-purple-600 text-white disabled:opacity-50"
                >
                  {actionPending === 'approve' ? 'Approving…' : '✓ Approve & Build'}
                </button>
              )}
            </div>
          </div>
          {task.status === 'specifying' && task.requireSpecApproval === true && editingSpec ? (
            <textarea
              value={specDraft}
              onChange={(e) => setSpecDraft(e.target.value)}
              spellCheck={false}
              className="mx-6 mb-3 block w-[calc(100%-3rem)] h-64 resize-y rounded border border-purple-800/50 bg-[#0a0a0f] px-3 py-2 text-[11px] text-gray-200 font-mono focus:outline-none focus:border-purple-500"
            />
          ) : (
            <pre className="px-6 pb-3 max-h-64 overflow-y-auto text-[11px] text-gray-300 whitespace-pre-wrap font-mono">
              {task.spec}
            </pre>
          )}
        </div>
      )}
      {task?.spec && !showSpec && (
        <div className="px-6 py-1 bg-purple-950/20 border-b border-purple-800/30 text-xs flex items-center gap-3">
          <span className="text-purple-300">
            📜 {task.status === 'specifying' && task.requireSpecApproval === true ? 'Spec is ready' : 'Implementation spec'}
          </span>
          <button
            onClick={() => setShowSpec(true)}
            className="text-purple-400 hover:text-purple-200 underline"
          >
            Show
          </button>
          {task.status === 'specifying' && task.requireSpecApproval === true && (
            <>
              <button
                onClick={handleStartEditSpec}
                className="text-purple-400 hover:text-purple-200 underline"
              >
                Edit
              </button>
              <button
                onClick={handleApproveSpec}
                disabled={actionPending === 'approve'}
                className="ml-auto px-3 py-0.5 rounded bg-purple-700 hover:bg-purple-600 text-white disabled:opacity-50"
              >
                {actionPending === 'approve' ? 'Approving…' : '✓ Approve & Build'}
              </button>
            </>
          )}
        </div>
      )}

      <main className="flex-1 min-h-0 overflow-hidden p-3">
        <ResizableSplit
          storageKey="liliput.task.split"
          defaults={{ left: 0.4, center: 0.45 }}
          min={{ left: 0.2, center: 0.2, right: 0.18 }}
          left={
            <div className="h-full pr-1.5">
              <Terminal messages={allMessages} onSend={handleSend} isWorking={isWorking} />
            </div>
          }
          center={
            <div className="h-full px-1.5 flex flex-col gap-2 min-h-0">
              <AgentPipeline pipeline={livePipeline ?? task?.pipeline ?? null} />
              <div className="flex-1 min-h-0">
                <ActivityLog entries={taskActivity} title="Live Activity" />
              </div>
            </div>
          }
          right={
            <div className="h-full pl-1.5 flex flex-col gap-3">
              <div className="h-[40%]">
                <LiliputIsland agents={agents} />
              </div>
              <div className="bg-[#0d0d14] border border-[#1a1a2e] rounded-lg overflow-hidden">
                <div className="px-3 py-1.5 text-[11px] font-semibold text-gray-400 border-b border-[#1a1a2e]">
                  Turns
                </div>
                <TurnList taskId={taskId} />
              </div>
              <div className="flex-1 bg-[#0d0d14] border border-[#1a1a2e] rounded-lg overflow-hidden">
                <AgentPanel agents={agents} />
              </div>
            </div>
          }
        />
      </main>
    </div>
  );
}
