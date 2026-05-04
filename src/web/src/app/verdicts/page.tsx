'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';

type VerdictStatus = 'done' | 'blocked' | 'continue';

interface AgentVerdict {
  id: string;
  taskId: string;
  agentId: string | null;
  ts: string;
  status: VerdictStatus;
  reason: string | null;
  raw: string | null;
}

const STATUS_STYLE: Record<VerdictStatus, string> = {
  done: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
  blocked: 'bg-red-500/10 text-red-300 border-red-500/30',
  continue: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
};

export default function VerdictsPage() {
  const [verdicts, setVerdicts] = useState<AgentVerdict[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<VerdictStatus | 'all'>('all');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/verdicts');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { verdicts: AgentVerdict[] };
      setVerdicts(body.verdicts ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(refresh, 30_000);
    return () => clearInterval(interval);
  }, [refresh]);

  const filtered = filter === 'all' ? verdicts : verdicts.filter((v) => v.status === filter);
  const counts = {
    done: verdicts.filter((v) => v.status === 'done').length,
    blocked: verdicts.filter((v) => v.status === 'blocked').length,
    continue: verdicts.filter((v) => v.status === 'continue').length,
  };

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 p-8">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">Agent verdicts</h1>
            <p className="text-sm text-zinc-400 mt-1">
              Per-turn declarations from agents. Observational only — does not
              yet gate task completion.
            </p>
          </div>
          <Link href="/requests" className="text-sm text-blue-400 hover:text-blue-300">
            ← back to requests
          </Link>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-300 px-4 py-3 rounded mb-4">
            {error}
          </div>
        )}

        <div className="flex gap-2 mb-4 text-sm">
          {(['all', 'done', 'blocked', 'continue'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1 rounded border ${
                filter === f
                  ? 'bg-zinc-800 border-zinc-600 text-zinc-100'
                  : 'border-zinc-800 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {f}
              {f !== 'all' && (
                <span className="ml-1 text-xs text-zinc-500">({counts[f]})</span>
              )}
            </button>
          ))}
        </div>

        {loading && verdicts.length === 0 ? (
          <div className="text-zinc-500">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="text-zinc-500 italic">
            No verdicts {filter === 'all' ? 'recorded yet' : `with status "${filter}"`}.
            Agents emit <code className="text-zinc-300">VERDICT: done|blocked|continue — reason</code>{' '}
            at the end of each turn.
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((v) => (
              <div
                key={v.id}
                className="border border-zinc-800 rounded-lg p-3 bg-zinc-900/50"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-mono border ${STATUS_STYLE[v.status]}`}
                    >
                      {v.status}
                    </span>
                    <Link
                      href={`/task/${v.taskId}`}
                      className="text-xs text-blue-400 hover:text-blue-300 font-mono"
                    >
                      {v.taskId.slice(0, 8)}
                    </Link>
                  </div>
                  <span className="text-xs text-zinc-500">
                    {new Date(v.ts).toLocaleString()}
                  </span>
                </div>
                {v.reason && (
                  <div className="text-sm text-zinc-300 mt-2">{v.reason}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
