'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useSocket } from '../../../../hooks/useSocket';
import { useTasks } from '../../../../hooks/useTasks';
import type { Task, TaskStatus, Workstream } from '@shared/types';

const UNASSIGNED_KEY = '__unassigned__';

const STATUS_STYLES: Record<TaskStatus, { label: string; cls: string }> = {
  clarifying: { label: 'Clarifying', cls: 'bg-blue-500/15 text-blue-300 border-blue-500/30' },
  specifying: { label: 'Specifying', cls: 'bg-blue-500/15 text-blue-300 border-blue-500/30' },
  building: { label: 'Building', cls: 'bg-yellow-500/15 text-yellow-300 border-yellow-500/30' },
  deploying: { label: 'Deploying', cls: 'bg-yellow-500/15 text-yellow-300 border-yellow-500/30' },
  review: { label: 'Review', cls: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30' },
  shipping: { label: 'Shipping', cls: 'bg-purple-500/15 text-purple-300 border-purple-500/30' },
  completed: { label: 'Completed', cls: 'bg-green-500/15 text-green-300 border-green-500/30' },
  discarded: { label: 'Discarded', cls: 'bg-gray-500/15 text-gray-400 border-gray-500/30' },
  failed: { label: 'Failed', cls: 'bg-red-500/15 text-red-300 border-red-500/30' },
  deleting: { label: 'Deleting', cls: 'bg-gray-500/15 text-gray-400 border-gray-500/30' },
};

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const sec = Math.max(0, Math.round(diffMs / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  const yr = Math.round(mo / 12);
  return `${yr}y ago`;
}

export default function MobileWorkstreamPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const rawId = Array.isArray(params?.id) ? params?.id[0] : params?.id;
  const wsId = decodeURIComponent(rawId ?? '');
  const isUnassigned = wsId === UNASSIGNED_KEY;
  const repoParam = searchParams?.get('repo') ?? null;

  const { connected } = useSocket();
  const { getTasks } = useTasks();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [workstreams, setWorkstreams] = useState<Workstream[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
      setError(err instanceof Error ? err.message : 'Failed to load tasks');
    } finally {
      setLoading(false);
    }
  }, [getTasks]);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [refresh]);

  const workstream = useMemo(
    () => (isUnassigned ? null : workstreams.find((w) => w.id === wsId) ?? null),
    [isUnassigned, wsId, workstreams],
  );

  const repoName = isUnassigned ? repoParam ?? '(no repo)' : workstream?.repository ?? '';
  const headerTitle = isUnassigned ? '(unassigned)' : workstream?.name ?? wsId;

  const filteredTasks = useMemo(() => {
    const matches = tasks.filter((t) => {
      if (isUnassigned) {
        const repo = t.repository ?? '(no repo)';
        return repo === (repoParam ?? '(no repo)') && !t.workstreamId;
      }
      return t.workstreamId === wsId;
    });
    return matches.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [tasks, isUnassigned, repoParam, wsId]);

  const newHref = isUnassigned
    ? `/new${repoParam ? `?repo=${encodeURIComponent(repoParam)}` : ''}`
    : `/new${workstream?.repository ? `?repo=${encodeURIComponent(workstream.repository)}&workstreamId=${encodeURIComponent(wsId)}` : ''}`;

  return (
    <div className="min-h-screen bg-[#050510] text-gray-100 flex flex-col">
      <header className="sticky top-0 z-10 border-b border-[#1a1a2e] bg-[#0d0d14]/95 backdrop-blur">
        <div className="flex items-center gap-2 px-3 py-3">
          <Link
            href="/m"
            className="inline-flex items-center justify-center w-10 h-10 rounded-md text-gray-400 hover:text-cyan-300 hover:bg-[#15152a] active:bg-[#1a1a2e] shrink-0"
            aria-label="Back to workstreams"
          >
            ←
          </Link>
          <div className="flex-1 min-w-0">
            <div className="text-[11px] text-gray-500 truncate">📁 {repoName || '—'}</div>
            <div className="text-sm font-medium truncate">{headerTitle}</div>
          </div>
          <span
            className={`inline-flex items-center justify-center w-2.5 h-2.5 rounded-full shrink-0 ${
              connected ? 'bg-green-400' : 'bg-red-400'
            }`}
            title={connected ? 'Live' : 'Offline'}
            aria-label={connected ? 'Connected' : 'Disconnected'}
          />
        </div>
      </header>

      <main className="flex-1 pb-24">
        {loading && filteredTasks.length === 0 && (
          <div className="px-4 py-6 text-sm text-gray-500">Loading…</div>
        )}
        {error && (
          <div className="mx-4 my-3 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}
        {!loading && !error && filteredTasks.length === 0 && (
          <div className="px-4 py-12 text-center text-sm text-gray-500">
            No tasks.{' '}
            <Link href={newHref} className="text-cyan-400 underline">
              + New task
            </Link>
          </div>
        )}

        <ul className="divide-y divide-[#1a1a2e]">
          {filteredTasks.map((t) => {
            const style = STATUS_STYLES[t.status];
            return (
              <li key={t.id}>
                <Link
                  href={`/m/task/${t.id}`}
                  className="flex items-start gap-3 px-4 py-3 min-h-[44px] hover:bg-[#0d0d14] active:bg-[#15152a] transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{t.title}</div>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-gray-500">
                      <span
                        className={`inline-flex items-center px-1.5 h-4 rounded border ${style.cls}`}
                      >
                        {style.label}
                      </span>
                      <span className="truncate">{formatRelative(t.updatedAt)}</span>
                    </div>
                  </div>
                  <span className="text-gray-600 mt-1 shrink-0">›</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </main>

      <div className="fixed bottom-0 inset-x-0 border-t border-[#1a1a2e] bg-[#0d0d14]/95 backdrop-blur px-4 py-3">
        <Link
          href={newHref}
          className="flex items-center justify-center w-full h-11 rounded-md bg-cyan-600 hover:bg-cyan-500 active:bg-cyan-700 text-white text-sm font-semibold transition-colors"
        >
          + New task
        </Link>
      </div>
    </div>
  );
}
