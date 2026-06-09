'use client';

import { useEffect, useState } from 'react';
import type { CostRollup } from '@shared/types';
import { get as apiGet } from '../lib/api-client';

export interface CostRollups {
  repos: Record<string, CostRollup>;
  workstreams: Record<string, CostRollup>;
}

const EMPTY: CostRollups = { repos: {}, workstreams: {} };

/**
 * Fetch repo + workstream cost rollups every `intervalMs` (default 30s).
 *
 * Cost moves slower than token totals (each call is fractions of a cent)
 * so we poll less aggressively than `useUsageRollups` (5s) — the dashboard
 * still feels live but the API does ~6× fewer cost-rollup joins.
 */
export function useCostRollups(intervalMs = 30_000): CostRollups {
  const [data, setData] = useState<CostRollups>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      try {
        const [r1, r2] = await Promise.all([
          apiGet<Record<string, CostRollup>>('/api/repos-cost'),
          apiGet<Record<string, CostRollup>>('/api/workstreams-cost'),
        ]);
        if (cancelled) return;
        setData({ repos: r1, workstreams: r2 });
      } catch {
        // best-effort; keep last value so the badge stays sticky on a transient error
      }
    };
    void refresh();
    const id = setInterval(() => {
      void refresh();
    }, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs]);

  return data;
}
