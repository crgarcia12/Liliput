'use client';

import { useEffect, useRef } from 'react';
import type { ActivityEntry } from '../hooks/useSocket';

interface Props {
  entries: ActivityEntry[];
  title?: string;
}

const KIND_ICON: Record<ActivityEntry['kind'], string> = {
  'agent-spawned': '✨',
  'agent-status': '⚙️',
  'agent-log': '·',
  'agent-completed': '✓',
  'agent-failed': '✗',
  'task-status': '📌',
  'task-spec': '📜',
};

function levelColor(entry: ActivityEntry): string {
  if (entry.level === 'error' || entry.kind === 'agent-failed') return 'text-red-400';
  if (entry.level === 'warn') return 'text-yellow-400';
  if (entry.kind === 'agent-completed') return 'text-green-400';
  if (entry.kind === 'task-status') return 'text-cyan-400';
  if (entry.kind === 'task-spec') return 'text-purple-400';
  if (entry.kind === 'agent-spawned') return 'text-blue-400';
  return 'text-gray-300';
}

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

export default function ActivityLog({ entries, title = 'Activity Log' }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries.length]);

  return (
    <div className="flex flex-col h-full bg-[#050510] border border-[#1a1a2e] rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-[#0d0d14] border-b border-[#1a1a2e]">
        <span className="text-xs font-mono text-gray-400">📡 {title}</span>
        <span className="text-[10px] text-gray-600">{entries.length} events</span>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-2 space-y-0.5 font-mono text-[11px]">
        {entries.length === 0 ? (
          <div className="text-gray-600 italic px-2 py-1">
            Waiting for activity… (the live event stream will appear here as agents work)
          </div>
        ) : (
          entries.map((e) => (
            <div key={e.id} className="flex gap-2 hover:bg-[#0d0d14] px-1 py-0.5 rounded">
              <span className="text-gray-600 shrink-0 tabular-nums">{fmtTime(e.timestamp)}</span>
              <span className="shrink-0">{KIND_ICON[e.kind]}</span>
              {e.agentName && (
                <span className="text-amber-300 shrink-0">{e.agentName}</span>
              )}
              <span className={`flex-1 break-words ${levelColor(e)}`}>
                {e.message}
                {e.command && (
                  <span className="block pl-2 text-gray-500">
                    $ <code>{e.command}</code>
                  </span>
                )}
                {e.output && (
                  <pre className="block pl-2 text-gray-400 whitespace-pre-wrap text-[10px] mt-0.5 max-h-40 overflow-y-auto">
                    {e.output}
                  </pre>
                )}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
