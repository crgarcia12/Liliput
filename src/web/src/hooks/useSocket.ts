'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import type { AgentEvent, ChatMessage } from '@shared/types';

// In production, Socket.io connects through the nginx reverse proxy on the same origin.
// In development, connect directly to the API server.
const API_URL = typeof window !== 'undefined' && window.location.hostname !== 'localhost'
  ? ''
  : 'http://localhost:5001';

export interface ActivityEntry {
  id: string;
  taskId: string;
  timestamp: string;
  kind:
    | 'agent-spawned'
    | 'agent-status'
    | 'agent-log'
    | 'agent-completed'
    | 'agent-failed'
    | 'task-status'
    | 'task-spec';
  agentId?: string;
  agentName?: string;
  level?: 'info' | 'warn' | 'error';
  message: string;
  command?: string;
  output?: string;
}

interface UseSocketReturn {
  connected: boolean;
  agentEvents: AgentEvent[];
  chatMessages: ChatMessage[];
  activity: ActivityEntry[];
  joinTask: (taskId: string) => void;
  leaveTask: (taskId: string) => void;
}

let entryCounter = 0;
const newId = () => `evt-${Date.now()}-${++entryCounter}`;

export function useSocket(): UseSocketReturn {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);

  useEffect(() => {
    const socket = io(API_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));

    socket.on('agent:event', (event: AgentEvent) => {
      setAgentEvents((prev) => [...prev, event]);
    });

    socket.on('chat:message', (message: ChatMessage) => {
      setChatMessages((prev) => [...prev, message]);
    });

    // Translate raw backend channels into a unified activity stream + AgentEvent feed
    const pushActivity = (entry: Omit<ActivityEntry, 'id' | 'timestamp'> & { timestamp?: string }) => {
      setActivity((prev) => [
        ...prev,
        {
          id: newId(),
          timestamp: entry.timestamp ?? new Date().toISOString(),
          ...entry,
        } as ActivityEntry,
      ]);
    };

    socket.on('agent:spawned', (e: { taskId: string; agentId: string; name: string; role: string; timestamp?: string }) => {
      setAgentEvents((prev) => [
        ...prev,
        {
          type: 'agent:spawned',
          taskId: e.taskId,
          agentId: e.agentId,
          timestamp: e.timestamp ?? new Date().toISOString(),
          data: { id: e.agentId, taskId: e.taskId, name: e.name, role: e.role, status: 'idle', logs: [], progress: 0 },
        } as unknown as AgentEvent,
      ]);
      pushActivity({
        taskId: e.taskId,
        kind: 'agent-spawned',
        agentId: e.agentId,
        agentName: e.name,
        message: `${e.name} (${e.role}) spawned`,
      });
    });

    socket.on('agent:status', (e: { taskId: string; agentId: string; status: string; currentAction?: string; timestamp?: string }) => {
      setAgentEvents((prev) => [
        ...prev,
        {
          type: 'agent:status',
          taskId: e.taskId,
          agentId: e.agentId,
          timestamp: e.timestamp ?? new Date().toISOString(),
          data: { status: e.status, currentAction: e.currentAction },
        } as unknown as AgentEvent,
      ]);
      pushActivity({
        taskId: e.taskId,
        kind: 'agent-status',
        agentId: e.agentId,
        message: e.currentAction ? `→ ${e.status}: ${e.currentAction}` : `→ ${e.status}`,
      });
    });

    socket.on('agent:log', (e: { taskId: string; agentId: string; level?: 'info'|'warn'|'error'; message: string; command?: string; output?: string; timestamp?: string }) => {
      pushActivity({
        taskId: e.taskId,
        kind: 'agent-log',
        agentId: e.agentId,
        level: e.level ?? 'info',
        message: e.message,
        command: e.command,
        output: e.output,
      });
    });

    socket.on('agent:tool-event', (e: { taskId: string; agentId: string; kind: string; tool?: string; summary: string; details?: string; timestamp?: string }) => {
      // Skip the very chatty events to keep the activity log scannable.
      if (e.kind === 'tool-complete' && (!e.summary || e.summary === '✓ ')) return;
      pushActivity({
        taskId: e.taskId,
        kind: 'agent-log',
        agentId: e.agentId,
        level: e.kind === 'error' ? 'error' : 'info',
        message: e.summary,
        output: e.details,
      });
    });

    socket.on('agent:completed', (e: { taskId: string; agentId: string; timestamp?: string }) => {
      setAgentEvents((prev) => [
        ...prev,
        {
          type: 'agent:completed',
          taskId: e.taskId,
          agentId: e.agentId,
          timestamp: e.timestamp ?? new Date().toISOString(),
          data: { status: 'completed', progress: 100 },
        } as unknown as AgentEvent,
      ]);
      pushActivity({ taskId: e.taskId, kind: 'agent-completed', agentId: e.agentId, message: '✓ completed' });
    });

    socket.on('agent:failed', (e: { taskId: string; agentId: string; error: string; timestamp?: string }) => {
      setAgentEvents((prev) => [
        ...prev,
        {
          type: 'agent:failed',
          taskId: e.taskId,
          agentId: e.agentId,
          timestamp: e.timestamp ?? new Date().toISOString(),
          data: { status: 'failed' },
        } as unknown as AgentEvent,
      ]);
      pushActivity({ taskId: e.taskId, kind: 'agent-failed', agentId: e.agentId, level: 'error', message: `✗ failed: ${e.error}` });
    });

    socket.on('task:status', (e: { taskId: string; status: string; errorMessage?: string; devUrl?: string }) => {
      pushActivity({
        taskId: e.taskId,
        kind: 'task-status',
        level: e.status === 'failed' ? 'error' : 'info',
        message:
          `Task → ${e.status}` +
          (e.errorMessage ? `: ${e.errorMessage}` : '') +
          (e.devUrl ? ` (${e.devUrl})` : ''),
      });
    });

    socket.on('task:spec', (e: { taskId: string }) => {
      pushActivity({ taskId: e.taskId, kind: 'task-spec', message: '📜 Spec ready — review and approve to start the build.' });
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  const joinTask = useCallback((taskId: string) => {
    socketRef.current?.emit('task:join', taskId);
  }, []);

  const leaveTask = useCallback((taskId: string) => {
    socketRef.current?.emit('task:leave', taskId);
  }, []);

  return { connected, agentEvents, chatMessages, activity, joinTask, leaveTask };
}

