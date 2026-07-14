'use client';

import { useEffect, useState, useCallback } from 'react';
import TopBar from '../../components/TopBar';

interface ToolWishAggregate {
  tool: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  reasons: string[];
  taskIds: string[];
}

export default function ToolWishesPage() {
  const [aggregates, setAggregates] = useState<ToolWishAggregate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/tool-wishes');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { aggregates: ToolWishAggregate[] };
      setAggregates(body.aggregates ?? []);
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

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <TopBar subtitle="Tool wishes" />
      <main className="p-8">
        <div className="max-w-5xl mx-auto">
          <div className="mb-6">
            <h1 className="text-2xl font-bold">Tool wishes</h1>
            <p className="text-sm text-zinc-400 mt-1">
              CLIs the agents have asked for. Bake popular ones into the
              runtime image (<code className="text-zinc-300">src/api/Dockerfile</code>).
            </p>
          </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-300 px-4 py-3 rounded mb-4">
            {error}
          </div>
        )}

        {loading && aggregates.length === 0 ? (
          <div className="text-zinc-500">Loading…</div>
        ) : aggregates.length === 0 ? (
          <div className="text-zinc-500 italic">
            No tool wishes recorded yet. Agents emit{' '}
            <code className="text-zinc-300">TOOL-WISH: name — reason</code> in
            their chat when they want a CLI that isn&apos;t installed.
          </div>
        ) : (
          <div className="space-y-3">
            {aggregates.map((a) => (
              <div
                key={a.tool}
                className="border border-zinc-800 rounded-lg p-4 bg-zinc-900/50"
              >
                <div className="flex items-baseline justify-between mb-2">
                  <code className="text-lg font-mono text-emerald-300">
                    {a.tool}
                  </code>
                  <span className="text-sm text-zinc-400">
                    {a.count} request{a.count === 1 ? '' : 's'} ·{' '}
                    {a.taskIds.length} task{a.taskIds.length === 1 ? '' : 's'}
                  </span>
                </div>
                {a.reasons.length > 0 && (
                  <ul className="text-sm text-zinc-300 mt-2 space-y-1 list-disc list-inside">
                    {a.reasons.slice(0, 5).map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                    {a.reasons.length > 5 && (
                      <li className="text-zinc-500 italic">
                        +{a.reasons.length - 5} more reasons
                      </li>
                    )}
                  </ul>
                )}
                <div className="text-xs text-zinc-500 mt-2">
                  First seen {new Date(a.firstSeen).toLocaleString()} · last{' '}
                  {new Date(a.lastSeen).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        )}
        </div>
      </main>
    </div>
  );
}
