'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import type { AgentEvent, ChatMessage } from '@shared/types';

// In production, Socket.io connects through the nginx reverse proxy on the same origin.
// In development, connect directly to the API server.
const API_URL = typeof window !== 'undefined' && window.location.hostname !== 'localhost'
  ? ''
  : 'http://localhost:5001';

interface UseSocketReturn {
  connected: boolean;
  agentEvents: AgentEvent[];
  chatMessages: ChatMessage[];
  joinTask: (taskId: string) => void;
  leaveTask: (taskId: string) => void;
}

export function useSocket(): UseSocketReturn {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);

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

  return { connected, agentEvents, chatMessages, joinTask, leaveTask };
}
