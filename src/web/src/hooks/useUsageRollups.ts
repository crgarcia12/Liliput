'use client';

import { useEffect, useState } from 'react';
import type { UsageRollup } from '@shared/types';

export interface UsageRollups {
  repos: Record<string, UsageRollup>;
  workstreams: Record<string, UsageRollup>;
}

const EMPTY: UsageRollups = { repos: {}, workstreams: {} };

/** Fetch repo + workstream token rollups every `intervalMs` (default 5s). */
export function useUsageRollups(intervalMs = 5000): UsageRollups {
  const [data, setData] = useState<UsageRollups>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const [r1, r2] = await Promise.all([
          fetch('/api/repos-usage').then((r) => (r.ok ? r.json() : {})),
          fetch('/api/workstreams-usage').then((r) => (r.ok ? r.json() : {})),
        ]);
        if (cancelled) return;
        setData({
          repos: r1 as Record<string, UsageRollup>,
          workstreams: r2 as Record<string, UsageRollup>,
        });
      } catch {
        // best-effort; keep last value
      }
    };
    void refresh();
    const id = setInterval(refresh, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs]);

  return data;
}
