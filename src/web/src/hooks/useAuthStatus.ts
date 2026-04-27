'use client';

import { useEffect, useState, useCallback } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { AuthStatus } from '@shared/types';

const API_URL =
  typeof window !== 'undefined' && window.location.hostname !== 'localhost'
    ? ''
    : 'http://localhost:5001';

interface UseAuthStatusReturn {
  status: AuthStatus | null;
  /** Trigger a fresh probe against the backend. */
  refresh: () => Promise<void>;
  refreshing: boolean;
}

export function useAuthStatus(): UseAuthStatusReturn {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Initial fetch + WebSocket subscription
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const res = await fetch(`${API_URL}/api/auth/status`);
        if (!res.ok) return;
        const data = (await res.json()) as AuthStatus;
        if (!cancelled) setStatus(data);
      } catch {
        // silent — banner stays hidden if API is unreachable
      }
    })();

    const socket: Socket = io(API_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
    });
    socket.on('auth:status', (s: AuthStatus) => {
      if (!cancelled) setStatus(s);
    });

    return () => {
      cancelled = true;
      socket.disconnect();
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    try {
      const res = await fetch(`${API_URL}/api/auth/check`, { method: 'POST' });
      if (res.ok) {
        const data = (await res.json()) as AuthStatus;
        setStatus(data);
      }
    } finally {
      setRefreshing(false);
    }
  }, []);

  return { status, refresh, refreshing };
}
