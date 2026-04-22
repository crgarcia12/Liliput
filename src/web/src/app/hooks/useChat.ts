'use client';

import { useState, useCallback, useRef } from 'react';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isError?: boolean;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001';

const WELCOME_MESSAGE: Message = {
  id: 'welcome',
  role: 'assistant',
  content:
    "Welcome! This is a spec2cloud shell template. Define your PRD and run the spec2cloud agents to build your application.",
};

export function useChat() {
  const [messages, setMessages] = useState<Message[]>([WELCOME_MESSAGE]);
  const [isLoading, setIsLoading] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const userMsg: Message = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: trimmed,
    };

    setMessages((prev) => [...prev, userMsg]);
    setIsLoading(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(`${API_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: trimmed,
          sessionId: sessionIdRef.current || '',
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        let errorContent: string;
        // Try to parse JSON error body
        let parsedBody = '';
        try {
          const parsed = JSON.parse(body);
          parsedBody = parsed.message || parsed.error || body;
        } catch {
          parsedBody = body;
        }
        if (res.status === 429) {
          errorContent = parsedBody || 'Conversation limit reached. Please start a new conversation.';
        } else if (res.status === 404) {
          errorContent = 'Your session has expired. Starting a new conversation...';
        } else {
          errorContent = parsedBody || `Error: ${res.statusText}`;
        }

        const errMsg: Message = {
          id: `error-${Date.now()}`,
          role: 'assistant',
          content: errorContent,
          isError: true,
        };
        setMessages((prev) => [...prev, errMsg]);
        setIsLoading(false);
        return;
      }

      const data = await res.json();
      if (data.sessionId) {
        sessionIdRef.current = data.sessionId;
      }

      const assistantMsg: Message = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: data.message || '',
        isError: false,
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        // Cancelled, don't add error message
      } else {
        const errMsg: Message = {
          id: `error-${Date.now()}`,
          role: 'assistant',
          content:
            'Unable to connect to the assistant. Please check your connection and try again.',
          isError: true,
        };
        setMessages((prev) => [...prev, errMsg]);
      }
    } finally {
      setIsLoading(false);
      abortRef.current = null;
    }
  }, []);

  const clearConversation = useCallback(async () => {
    // Abort any in-flight request
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }

    // Delete session on backend
    if (sessionIdRef.current) {
      try {
        await fetch(`${API_URL}/api/sessions/${sessionIdRef.current}`, {
          method: 'DELETE',
        });
      } catch {
        // Best-effort
      }
    }

    sessionIdRef.current = null;
    setIsLoading(false);
    setMessages([
      {
        ...WELCOME_MESSAGE,
        id: `welcome-${Date.now()}`,
      },
    ]);
  }, []);

  return { messages, isLoading, sendMessage, clearConversation };
}
