'use client';

import { useEffect, useRef, useState } from 'react';
import type { ChatMessage, ChatRole } from '@shared/types';
import AutoGrowTextarea from './AutoGrowTextarea';

interface TerminalProps {
  messages: ChatMessage[];
  onSend: (message: string) => void;
  isWorking?: boolean;
}

const WELCOME_MESSAGE: ChatMessage = {
  id: 'welcome',
  taskId: '',
  role: 'liliput',
  content: `🏰 Welcome to Liliput, Gulliver!

I am your development kingdom. Tell me what feature you'd like to build,
and my citizens will get to work immediately.

Type your feature request below...`,
  timestamp: new Date().toISOString(),
};

function getRoleStyle(role: ChatRole): { color: string; prefix: string } {
  switch (role) {
    case 'gulliver':
      return { color: 'text-green-400', prefix: 'gulliver> ' };
    case 'liliput':
      return { color: 'text-cyan-400', prefix: '🏰 liliput> ' };
    case 'agent':
      return { color: 'text-yellow-400', prefix: '' };
    case 'system':
      return { color: 'text-gray-500', prefix: '--- ' };
    default:
      return { color: 'text-gray-400', prefix: '> ' };
  }
}

export default function Terminal({ messages, onSend, isWorking = false }: TerminalProps) {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const allMessages = [WELCOME_MESSAGE, ...messages];

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [allMessages.length]);

  const submit = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setInput('');
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submit(input);
  };

  const handleContainerClick = () => {
    inputRef.current?.focus();
  };

  return (
    <div
      className="flex flex-col h-full bg-[#0a0a0f] border border-[#1a1a2e] rounded-lg overflow-hidden"
      onClick={handleContainerClick}
    >
      {/* Terminal header */}
      <div className="flex items-center gap-2 px-4 py-2 bg-[#0d0d14] border-b border-[#1a1a2e]">
        <div className="flex gap-1.5">
          <div className="w-3 h-3 rounded-full bg-red-500/80" />
          <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
          <div className="w-3 h-3 rounded-full bg-green-500/80" />
        </div>
        <span className="text-xs text-gray-500 ml-2">liliput — terminal</span>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-1 font-mono text-sm">
        {allMessages.map((msg) => {
          const style = getRoleStyle(msg.role);
          const prefix =
            msg.role === 'agent' && msg.agentName
              ? `🤖 ${msg.agentName}> `
              : style.prefix;

          return (
            <div key={msg.id} className="whitespace-pre-wrap">
              <span className={style.color}>
                {prefix}
              </span>
              <span className={msg.role === 'system' ? 'text-gray-500' : 'text-gray-200'}>
                {msg.content}
              </span>
            </div>
          );
        })}

        {isWorking && (
          <div className="flex items-center gap-2 text-amber-400">
            <span className="animate-pulse">⚡</span>
            <span className="text-sm">Liliputians are working...</span>
            <span className="inline-flex gap-0.5">
              <span className="animate-bounce" style={{ animationDelay: '0ms' }}>.</span>
              <span className="animate-bounce" style={{ animationDelay: '150ms' }}>.</span>
              <span className="animate-bounce" style={{ animationDelay: '300ms' }}>.</span>
            </span>
          </div>
        )}
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="flex items-start border-t border-[#1a1a2e] bg-[#0d0d14]">
        <span className="text-green-400 pl-4 pt-3 text-sm font-mono shrink-0">gulliver&gt;&nbsp;</span>
        <AutoGrowTextarea
          ref={inputRef}
          value={input}
          onValueChange={setInput}
          onSubmit={submit}
          maxHeightPx={240}
          className="flex-1 resize-none bg-transparent text-gray-200 text-sm font-mono py-3 pr-4 outline-none placeholder-gray-600 leading-5"
          placeholder="Tell me what to build... (Shift+Enter for newline)"
          autoFocus
        />
      </form>
    </div>
  );
}
