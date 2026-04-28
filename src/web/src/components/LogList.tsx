'use client';

import { useEffect, useRef } from 'react';
import type { AgentLogEntry } from '@shared/types';

interface Props {
  logs: AgentLogEntry[];
  emptyHint?: string;
  autoScroll?: boolean;
}

const LEVEL_COLOR: Record<AgentLogEntry['level'], string> = {
  info: 'text-gray-300',
  warn: 'text-yellow-300',
  error: 'text-red-300',
  debug: 'text-gray-500',
};

export default function LogList({ logs, emptyHint, autoScroll = true }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'auto', block: 'end' });
    }
  }, [logs, autoScroll]);

  if (logs.length === 0) {
    return (
      <div className="text-gray-500 text-xs italic p-4">
        {emptyHint ?? 'No logs yet.'}
      </div>
    );
  }

  return (
    <div className="font-mono text-[11px] leading-relaxed">
      {logs.map((log, i) => (
        <div key={i} className="flex gap-2 px-3 py-0.5 hover:bg-[#10101a] border-b border-[#0a0a14]">
          <span className="text-gray-600 shrink-0">
            {new Date(log.timestamp).toLocaleTimeString()}
          </span>
          <span className={`shrink-0 uppercase text-[9px] mt-0.5 ${LEVEL_COLOR[log.level]}`}>
            {log.level}
          </span>
          <div className="min-w-0 flex-1">
            <div className={`${LEVEL_COLOR[log.level]} whitespace-pre-wrap break-words`}>
              {log.message}
            </div>
            {log.command && (
              <div className="text-cyan-400 mt-0.5 whitespace-pre-wrap break-words">
                $ {log.command}
              </div>
            )}
            {log.output && (
              <pre className="text-gray-500 mt-0.5 whitespace-pre-wrap break-words bg-[#06060c] rounded px-2 py-1 mt-1 max-h-40 overflow-y-auto">
                {log.output}
              </pre>
            )}
          </div>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
