'use client';

import React, { useEffect, useRef } from 'react';
import ChatMessage from './ChatMessage';
import TypingIndicator from './TypingIndicator';
import { Message } from '../hooks/useChat';

interface MessageListProps {
  messages: Message[];
  isLoading: boolean;
}

export default function MessageList({ messages, isLoading }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  return (
    <div
      data-testid="message-list"
      aria-live="polite"
      className="flex-1 overflow-y-auto px-4 py-6"
    >
      {messages.map((msg) => (
        <ChatMessage
          key={msg.id}
          role={msg.role}
          content={msg.content}
          isError={msg.isError}
        />
      ))}
      <TypingIndicator visible={isLoading} />
      <div ref={bottomRef} />
    </div>
  );
}
