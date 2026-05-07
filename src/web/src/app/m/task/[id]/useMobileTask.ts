'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSocket } from '../../../../hooks/useSocket';
import { useTasks } from '../../../../hooks/useTasks';
import type { Task, ChatMessage, Agent, ActivityEntry } from '@shared/types';

const API_URL = '';

export type ActionKind = 'ship' | 'discard' | 'approve';

export interface UseMobileTaskReturn {
  task: Task | null;
  loading: boolean;
  error: string | null;
  setError: (err: string | null) => void;
  connected: boolean;
  allMessages: ChatMessage[];
  taskActivity: ActivityEntry[];
  agents: Agent[];
  isWorking: boolean;
  actionPending: ActionKind | null;
  sendMessage: (message: string) => Promise<void>;
  approveSpec: () => Promise<void>;
  shipTask: () => Promise<void>;
  discardTask: () => Promise<void>;
  setTaskModel: (model: string) => Promise<void>;
  setTaskReasoningEffort: (
    effort: '' | 'low' | 'medium' | 'high' | 'xhigh',
  ) => Promise<void>;
  modelPending: boolean;
  reasoningPending: boolean;
}

export function useMobileTask(taskId: string): UseMobileTaskReturn {
  const {
    connected,
    agentEvents,
    chatMessages: socketMessages,
    activity,
    joinTask,
    leaveTask,
  } = useSocket();
  const {
    getTask,
    sendMessage: apiSendMessage,
    shipTask: apiShipTask,
    discardTask: apiDiscardTask,
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

  const isWorking = agents.some((a) => a.status === 'working');

  const sendMessage = useCallback(
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
    [taskId, apiSendMessage],
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

  const setTaskModel = useCallback(
    async (model: string) => {
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
    async (effort: '' | 'low' | 'medium' | 'high' | 'xhigh') => {
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

  return {
    task,
    loading,
    error,
    setError,
    connected,
    allMessages,
    taskActivity,
    agents,
    isWorking,
    actionPending,
    sendMessage,
    approveSpec,
    shipTask,
    discardTask,
    setTaskModel,
    setTaskReasoningEffort,
    modelPending,
    reasoningPending,
  };
}
