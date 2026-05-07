'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSocket } from '../../hooks/useSocket';
import { useTasks } from '../../hooks/useTasks';
import type { Task, Workstream } from '@shared/types';

const UNASSIGNED_KEY = '__unassigned__';
const ACTIVE_STATUSES = new Set([
  'clarifying',
  'specifying',
  'building',
  'deploying',
  'review',
  'shipping',
]);

interface WsRow {
  key: string;
  name: string;
  taskCount: number;
}

interface RepoGroup {
  repo: string;
  workstreams: WsRow[];
  taskCount: number;
}

export default function MobileRootPage() {
  const { connected } = useSocket();
  const { getTasks } = useTasks();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [workstreams, setWorkstreams] = useState<Workstream[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const [list, wsRes] = await Promise.all([
        getTasks(),
        fetch('/api/workstreams').then((r) =>
          r.ok ? (r.json() as Promise<{ workstreams: Workstream[] }>) : { workstreams: [] },
        ),
      ]);
      setTasks(list);
      setWorkstreams(wsRes.workstreams);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workstreams');
    } finally {
      setLoading(false);
    }
  }, [getTasks]);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [refresh]);

  const groups: RepoGroup[] = useMemo(() => {
    const filtered = showInactive ? tasks : tasks.filter((t) => ACTIVE_STATUSES.has(t.status));

    const wsById = new Map(workstreams.map((w) => [w.id, w]));
    const wsByRepo = new Map<string, Workstream[]>();
    for (const w of workstreams) {
      const arr = wsByRepo.get(w.repository) ?? [];
      arr.push(w);
      wsByRepo.set(w.repository, arr);
    }

    // repo -> (wsKey -> count)
    const counts = new Map<string, Map<string, number>>();
    const ensure = (repo: string): Map<string, number> => {
      let m = counts.get(repo);
      if (!m) {
        m = new Map();
        counts.set(repo, m);
      }
      return m;
    };

    for (const t of filtered) {
      const repo = t.repository ?? '(no repo)';
      const m = ensure(repo);
      const key = t.workstreamId && wsById.has(t.workstreamId) ? t.workstreamId : UNASSIGNED_KEY;
      m.set(key, (m.get(key) ?? 0) + 1);
    }

    if (showInactive) {
      for (const repo of wsByRepo.keys()) ensure(repo);
    }

    const out: RepoGroup[] = [];
    for (const [repo, m] of counts) {
      const rows: WsRow[] = [];
      const unassignedCount = m.get(UNASSIGNED_KEY) ?? 0;
      if (unassignedCount > 0 || showInactive) {
        rows.push({ key: UNASSIGNED_KEY, name: '(unassigned)', taskCount: unassignedCount });
      }
      for (const w of wsByRepo.get(repo) ?? []) {
        const c = m.get(w.id) ?? 0;
        if (c === 0 && !showInactive) continue;
        rows.push({ key: w.id, name: w.name, taskCount: c });
      }
      rows.sort((a, b) => {
        if (a.key === UNASSIGNED_KEY) return -1;
        if (b.key === UNASSIGNED_KEY) return 1;
        return a.name.localeCompare(b.name);
      });
      const taskCount = rows.reduce((s, r) => s + r.taskCount, 0);
      if (rows.length === 0) continue;
      out.push({ repo, workstreams: rows, taskCount });
    }
    out.sort((a, b) => a.repo.localeCompare(b.repo));
    return out;
  }, [tasks, workstreams, showInactive]);

  const toggleRepo = (repo: string) => {
    setCollapsedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(repo)) next.delete(repo);
      else next.add(repo);
      return next;
    });
  };

  return (
    <div className="min-h-screen bg-[#050510] text-gray-100 flex flex-col">
      {/* Sticky header */}
      <header className="sticky top-0 z-10 border-b border-[#1a1a2e] bg-[#0d0d14]/95 backdrop-blur">
        <div className="flex items-center gap-2 px-4 py-3">
          <Link href="/m" className="flex items-center gap-2 min-w-0 flex-1">
            <span className="text-xl shrink-0">🏰</span>
            <span className="text-sm font-bold text-cyan-400 truncate">Liliput</span>
            <span className="text-xs text-gray-500 truncate">· Workstreams</span>
          </Link>
          <span
            className={`inline-flex items-center justify-center w-2.5 h-2.5 rounded-full shrink-0 ${
              connected ? 'bg-green-400' : 'bg-red-400'
            }`}
            title={connected ? 'Live' : 'Offline'}
            aria-label={connected ? 'Connected' : 'Disconnected'}
          />
        </div>
        <div className="flex items-center justify-between px-4 pb-2 text-xs">
          <label className="inline-flex items-center gap-2 text-gray-400 select-none">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="accent-cyan-500"
            />
            Show inactive
          </label>
          <span className="text-gray-500">
            {groups.length} repo{groups.length === 1 ? '' : 's'}
          </span>
        </div>
      </header>

      <main className="flex-1 pb-24">
        {loading && groups.length === 0 && (
          <div className="px-4 py-6 text-sm text-gray-500">Loading…</div>
        )}
        {error && (
          <div className="mx-4 my-3 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}
        {!loading && !error && groups.length === 0 && (
          <div className="px-4 py-12 text-center text-sm text-gray-500">
            No workstreams yet.{' '}
            <Link href="/new" className="text-cyan-400 underline">
              Create one
            </Link>
            .
          </div>
        )}

        <ul className="divide-y divide-[#1a1a2e]">
          {groups.map((g) => {
            const collapsed = collapsedRepos.has(g.repo);
            return (
              <li key={g.repo} className="bg-[#050510]">
                <button
                  type="button"
                  onClick={() => toggleRepo(g.repo)}
                  className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-[#0d0d14] active:bg-[#15152a] transition-colors"
                  aria-expanded={!collapsed}
                >
                  <span className="text-gray-500 text-xs w-3 shrink-0">
                    {collapsed ? '▸' : '▾'}
                  </span>
                  <span className="shrink-0">📁</span>
                  <span className="flex-1 min-w-0 truncate text-sm font-medium">{g.repo}</span>
                  <span className="text-xs text-gray-500 shrink-0">
                    {g.taskCount} task{g.taskCount === 1 ? '' : 's'}
                  </span>
                </button>
                {!collapsed && (
                  <ul className="border-t border-[#1a1a2e] bg-[#08080f]">
                    {g.workstreams.map((w) => {
                      const href =
                        w.key === UNASSIGNED_KEY
                          ? `/m/workstream/${UNASSIGNED_KEY}?repo=${encodeURIComponent(g.repo)}`
                          : `/m/workstream/${encodeURIComponent(w.key)}`;
                      return (
                        <li key={w.key} className="border-b border-[#1a1a2e] last:border-b-0">
                          <Link
                            href={href}
                            className="flex items-center gap-3 pl-10 pr-4 py-3 min-h-[44px] hover:bg-[#0d0d14] active:bg-[#15152a] transition-colors"
                          >
                            <span className="shrink-0">
                              {w.key === UNASSIGNED_KEY ? '📥' : '🌿'}
                            </span>
                            <span
                              className={`flex-1 min-w-0 truncate text-sm ${
                                w.key === UNASSIGNED_KEY ? 'italic text-gray-400' : ''
                              }`}
                            >
                              {w.name}
                            </span>
                            <span className="inline-flex items-center justify-center min-w-[1.5rem] h-5 px-1.5 rounded-md border border-cyan-500/30 bg-cyan-500/10 text-[11px] text-cyan-300 shrink-0">
                              {w.taskCount}
                            </span>
                            <span className="text-gray-600 shrink-0">›</span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </main>

      {/* Sticky bottom CTA */}
      <div className="fixed bottom-0 inset-x-0 border-t border-[#1a1a2e] bg-[#0d0d14]/95 backdrop-blur px-4 py-3">
        <Link
          href="/new"
          className="flex items-center justify-center w-full h-11 rounded-md bg-cyan-600 hover:bg-cyan-500 active:bg-cyan-700 text-white text-sm font-semibold transition-colors"
        >
          + New workstream
        </Link>
      </div>
    </div>
  );
}
