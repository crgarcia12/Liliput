'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSocket } from '../../../../hooks/useSocket';
import { useTasks } from '../../../../hooks/useTasks';
import {
  rememberChatConfig,
  type ReasoningEffortSelection,
} from '../../../../lib/chat-config-storage';
import type { Task, ChatMessage, Agent, ActivityEntry, PipelineState } from '@shared/types';

const API_URL = '';

export type ActionKind = 'ship' | 'discard' | 'close' | 'cancel' | 'approve';

export interface UseMobileTaskReturn {
  task: Task | null;
  loading: boolean;
  error: string | null;
  setError: (err: string | null) => void;
  connected: boolean;
  pipeline: PipelineState | null;
  allMessages: ChatMessage[];
  taskActivity: ActivityEntry[];
  agents: Agent[];
  isWorking: boolean;
  actionPending: ActionKind | null;
  sendMessage: (message: string) => Promise<void>;
  approveSpec: () => Promise<void>;
  shipTask: () => Promise<void>;
  discardTask: () => Promise<void>;
  closeTask: () => Promise<void>;
  cancelTask: () => Promise<void>;
  setTaskModel: (model: string | null) => Promise<void>;
  setTaskReasoningEffort: (
    effort: ReasoningEffortSelection,
  ) => Promise<void>;
  setTaskReviewerModel: (model: string) => Promise<void>;
  setTaskReviewerReasoningEffort: (effort: ReasoningEffortSelection) => Promise<void>;
  modelPending: boolean;
  reasoningPending: boolean;
  reviewerPending: boolean;
}

export function useMobileTask(taskId: string): UseMobileTaskReturn {
  const {
    connected,
    agentEvents,
    chatMessages: socketMessages,
    activity,
    pipeline: livePipeline,
    joinTask,
    leaveTask,
  } = useSocket();
  const {
    getTask,
    sendMessage: apiSendMessage,
    shipTask: apiShipTask,
    discardTask: apiDiscardTask,
    closeTask: apiCloseTask,
    cancelTask: apiCancelTask,
    setTaskModel: apiSetTaskModel,
    setTaskReasoningEffort: apiSetTaskReasoningEffort,
  } = useTasks();

  const [task, setTask] = useState<Task | null>(null);
  const [localMessages, setLocalMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState<ActionKind | null>(null);
  const [modelPending, setModelPending] = useState(false);
  const [reasoningPending, setReasoningPending] = useState(false);
  const [reviewerPending, setReviewerPending] = useState(false);

  // Mirror desktop's optimization: don't replace state objects when nothing
  // visible has changed. Preserves text selection across 4s polls.
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

  // Initial load
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

  // Socket join lifecycle
  useEffect(() => {
    if (connected && taskId) {
      joinTask(taskId);
      return () => leaveTask(taskId);
    }
  }, [connected, taskId, joinTask, leaveTask]);

  // 4s polling fallback
  useEffect(() => {
    if (!taskId) return;
    const interval = setInterval(() => {
      getTask(taskId).then(applyTaskUpdate).catch(() => {});
    }, 4000);
    return () => clearInterval(interval);
  }, [taskId, getTask, applyTaskUpdate]);

  // Refetch on activity
  useEffect(() => {
    if (!taskId) return;
    const last = activity[activity.length - 1];
    if (last && last.taskId === taskId) {
      getTask(taskId).then(applyTaskUpdate).catch(() => {});
    }
  }, [activity, taskId, getTask, applyTaskUpdate]);

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

  const taskActivity = useMemo<ActivityEntry[]>(() => {
    const seen = new Set<string>();
    const out: ActivityEntry[] = [];
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

  const isTerminalStatus =
    task?.status === 'completed' ||
    task?.status === 'discarded' ||
    task?.status === 'failed' ||
    task?.status === 'deleting' ||
    task?.status === 'review';
  const isWorking = !isTerminalStatus && agents.some((a) => a.status === 'working');

  const sendMessage = useCallback(
    async (message: string) => {
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
        await apiSendMessage(taskId, message);
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
    [taskId, apiSendMessage, task?.status],
  );

  const approveSpec = useCallback(async () => {
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
      const data = (await res.json()) as { task: Task };
      setTask(data.task);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionPending(null);
    }
  }, [task]);

  const shipTask = useCallback(async () => {
    if (!task) return;
    setActionPending('ship');
    try {
      const updated = await apiShipTask(task.id);
      setTask(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ship failed');
    } finally {
      setActionPending(null);
    }
  }, [task, apiShipTask]);

  const discardTask = useCallback(async () => {
    if (!task) return;
    setActionPending('discard');
    try {
      const updated = await apiDiscardTask(task.id);
      setTask(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Discard failed');
    } finally {
      setActionPending(null);
    }
  }, [task, apiDiscardTask]);

  const closeTask = useCallback(async () => {
    if (!task) return;
    setActionPending('close');
    try {
      const updated = await apiCloseTask(task.id);
      setTask(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Close failed');
    } finally {
      setActionPending(null);
    }
  }, [task, apiCloseTask]);

  const cancelTask = useCallback(async () => {
    if (!task) return;
    setActionPending('cancel');
    try {
      const updated = await apiCancelTask(task.id);
      setTask(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cancel failed');
    } finally {
      setActionPending(null);
    }
  }, [task, apiCancelTask]);

  const setTaskModel = useCallback(
    async (model: string | null) => {
      if (!task) return;
      setModelPending(true);
      try {
        const updated = await apiSetTaskModel(task.id, model);
        setTask(updated);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to switch model');
      } finally {
        setModelPending(false);
      }
    },
    [task, apiSetTaskModel],
  );

  const setTaskReasoningEffort = useCallback(
    async (effort: ReasoningEffortSelection) => {
      if (!task) return;
      setReasoningPending(true);
      try {
        const updated = await apiSetTaskReasoningEffort(task.id, effort);
        setTask(updated);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Failed to switch reasoning effort',
        );
      } finally {
        setReasoningPending(false);
      }
    },
    [task, apiSetTaskReasoningEffort],
  );

  const patchReviewer = useCallback(
    async (body: {
      reviewerModel?: string | null;
      reviewerReasoningEffort?: ReasoningEffortSelection | null;
    }) => {
      if (!task) return;
      setReviewerPending(true);
      try {
        const res = await fetch(`${API_URL}/api/tasks/${task.id}/reviewer`, {
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
        setTask(data.task);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update checking model');
      } finally {
        setReviewerPending(false);
      }
    },
    [task],
  );

  const setTaskReviewerModel = useCallback(
    async (model: string) => {
      await patchReviewer({ reviewerModel: model === '' ? null : model });
    },
    [patchReviewer],
  );

  const setTaskReviewerReasoningEffort = useCallback(
    async (effort: ReasoningEffortSelection) => {
      await patchReviewer({ reviewerReasoningEffort: effort === '' ? null : effort });
    },
    [patchReviewer],
  );

  return {
    task,
    loading,
    error,
    setError,
    connected,
    pipeline: livePipeline ?? task?.pipeline ?? null,
    allMessages,
    taskActivity,
    agents,
    isWorking,
    actionPending,
    sendMessage,
    approveSpec,
    shipTask,
    discardTask,
    closeTask,
    cancelTask,
    setTaskModel,
    setTaskReasoningEffort,
    setTaskReviewerModel,
    setTaskReviewerReasoningEffort,
    modelPending,
    reasoningPending,
    reviewerPending,
  };
}
