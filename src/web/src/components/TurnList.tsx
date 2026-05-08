'use client';

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { Turn } from '@shared/types';
import { formatTokens, formatDuration } from './TokenBadge';

interface TurnListProps {
  taskId: string;
}

/**
 * Compact list of all Turns belonging to a task.
 * Each turn shows: title · model · duration · tokens (with breakdown tooltip).
 * Polls every 4s plus refreshes immediately on `turn:opened` / `turn:updated` /
 * `turn:closed` socket events. We use polling rather than full socket-driven
 * state because turn:updated fires very frequently per assistant token usage.
 */
export default function TurnList({ taskId }: TurnListProps): ReactElement {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const fetchTurns = async () => {
      try {
        const r = await fetch(`/api/tasks/${taskId}/turns`);
        if (!r.ok) return;
        const data = (await r.json()) as { turns: Turn[] };
        if (!cancelled) setTurns(data.turns);
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void fetchTurns();
    const id = setInterval(fetchTurns, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [taskId]);

  if (loading && turns.length === 0) {
    return <div className="text-xs text-gray-500 px-2 py-1">Loading turns…</div>;
  }
  if (turns.length === 0) {
    return <div className="text-xs text-gray-500 px-2 py-1">No turns recorded yet.</div>;
  }

  return (
    <div className="flex flex-col gap-1 px-1 py-1 max-h-64 overflow-y-auto">
      {turns.map((t, i) => {
        const isOpen = t.status === 'open';
        const tokens = t.usage.totalTokens;
        const tooltip = [
          `in: ${t.usage.inputTokens.toLocaleString()}`,
          `out: ${t.usage.outputTokens.toLocaleString()}`,
          `cache r: ${t.usage.cacheReadTokens.toLocaleString()}`,
          `cache w: ${t.usage.cacheWriteTokens.toLocaleString()}`,
          `calls: ${t.usage.callCount}`,
        ].join('\n');
        return (
          <div
            key={t.id}
            className={`flex items-center gap-2 text-[11px] px-2 py-1 rounded border ${
              isOpen
                ? 'bg-cyan-500/5 border-cyan-500/30'
                : 'bg-[#10101a] border-[#1a1a2e] text-gray-400'
            }`}
          >
            <span className="text-gray-500 w-6">#{i + 1}</span>
            <span className="flex-1 truncate" title={t.userMessage ?? t.title}>
              {t.title || t.userMessage || '(no title)'}
            </span>
            {t.model && (
              <span className="font-mono text-[10px] text-gray-500" title={t.model}>
                {t.model.split('-').slice(0, 2).join('-')}
              </span>
            )}
            {t.durationMs != null && (
              <span className="font-mono text-[10px] text-gray-500">
                ⏱ {formatDuration(t.durationMs)}
              </span>
            )}
            {tokens > 0 && (
              <span
                title={tooltip}
                className="font-mono text-[10px] text-purple-300 bg-purple-500/10 border border-purple-500/20 px-1 rounded"
              >
                🪙 {formatTokens(tokens)}
              </span>
            )}
            {isOpen && <span className="text-[9px] text-cyan-400">● live</span>}
          </div>
        );
      })}
    </div>
  );
}
