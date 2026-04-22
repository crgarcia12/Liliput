'use client';

import React from 'react';
import Markdown from 'react-markdown';

interface ChatMessageProps {
  role: 'user' | 'assistant';
  content: string;
  isError?: boolean;
}

export default function ChatMessage({ role, content, isError }: ChatMessageProps) {
  const isUser = role === 'user';

  return (
    <div
      data-testid="message"
      role="article"
      className={`flex w-full ${isUser ? 'justify-end' : 'justify-start'} mb-3`}
    >
      <div
        data-testid={isUser ? 'user-message' : 'assistant-message'}
        className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
          isUser
            ? 'bg-blue-600 text-white'
            : isError
              ? 'error bg-red-50 text-red-800 border border-red-200'
              : 'bg-gray-100 text-gray-900'
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap">{content}</p>
        ) : (
          <Markdown
            components={{
              a: ({ href, children, ...props }) => (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 underline hover:text-blue-800"
                  {...props}
                >
                  {children}
                </a>
              ),
              h1: ({ children, ...props }) => (
                <h1 className="text-xl font-bold mb-2 mt-2" {...props}>{children}</h1>
              ),
              h2: ({ children, ...props }) => (
                <h2 className="text-lg font-bold mb-2 mt-2" {...props}>{children}</h2>
              ),
              h3: ({ children, ...props }) => (
                <h3 className="text-base font-bold mb-1 mt-1" {...props}>{children}</h3>
              ),
              ul: ({ children, ...props }) => (
                <ul className="list-disc ml-4 mb-2" {...props}>{children}</ul>
              ),
              ol: ({ children, ...props }) => (
                <ol className="list-decimal ml-4 mb-2" {...props}>{children}</ol>
              ),
              p: ({ children, ...props }) => (
                <p className="mb-2 last:mb-0" {...props}>{children}</p>
              ),
            }}
          >
            {content}
          </Markdown>
        )}
      </div>
    </div>
  );
}
