'use client';

import { useCallback, useEffect, useState } from 'react';
import type {
  AgentConfigRole,
  ReasoningEffort,
  UserAgentDefault,
  UserAgentDefaultsResponse,
  UpdateUserAgentDefaultRequest,
} from '@shared/types';

/** Frontend mirror of the backend `AGENT_CONFIG_ROLES` constant. Inlined
 *  here so that pages can rely on a pure type-only import from
 *  `@shared/types` (Turbopack rejects mixed CommonJS/ESM runtime imports
 *  from the shared module). Keep in sync with `src/shared/types/index.ts`. */
export const AGENT_CONFIG_ROLES: readonly AgentConfigRole[] = [
  'rewriter',
  'architect',
  'critic',
  'coder',
  'reviewer',
] as const;

const API_URL = '';

interface UseProfileDefaultsReturn {
  defaults: UserAgentDefault[];
  loading: boolean;
  error: string | null;
  /** Re-fetch from the server (called automatically on mount). */
  refresh: () => Promise<void>;
  /** Pin a model / reasoning for one role. Pass null/empty model to clear. */
  setRoleDefault: (
    role: AgentConfigRole,
    update: UpdateUserAgentDefaultRequest,
  ) => Promise<void>;
  /** Drop the row entirely (semantically: "never configured" → uses server fallback). */
  resetRole: (role: AgentConfigRole) => Promise<void>;
  /** True while a single role mutation is in flight (one-at-a-time). */
  saving: AgentConfigRole | null;
}

async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${body || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export function useProfileDefaults(): UseProfileDefaultsReturn {
  const [defaults, setDefaults] = useState<UserAgentDefault[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<AgentConfigRole | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetchJson<UserAgentDefaultsResponse>('/api/profile/agents');
      setDefaults([...resp.defaults]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setRoleDefault = useCallback(
    async (role: AgentConfigRole, update: UpdateUserAgentDefaultRequest) => {
      setSaving(role);
      setError(null);
      try {
        const resp = await fetchJson<UserAgentDefaultsResponse>(
          `/api/profile/agents/${role}`,
          {
            method: 'PUT',
            body: JSON.stringify(update),
          },
        );
        setDefaults([...resp.defaults]);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        setSaving(null);
      }
    },
    [],
  );

  const resetRole = useCallback(async (role: AgentConfigRole) => {
    setSaving(role);
    setError(null);
    try {
      const resp = await fetchJson<UserAgentDefaultsResponse>(
        `/api/profile/agents/${role}`,
        { method: 'DELETE' },
      );
      setDefaults([...resp.defaults]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setSaving(null);
    }
  }, []);

  return { defaults, loading, error, refresh, setRoleDefault, resetRole, saving };
}

/** Convenience: friendly label for a role. */
export function roleLabel(role: AgentConfigRole): string {
  switch (role) {
    case 'rewriter':
      return 'Rewriter';
    case 'architect':
      return 'Architect (planner)';
    case 'critic':
      return 'Critic (rubber-duck)';
    case 'coder':
      return 'Coder';
    case 'reviewer':
      return 'Reviewer';
  }
}

/** Convenience: short description rendered under the row title. */
export function roleDescription(role: AgentConfigRole): string {
  switch (role) {
    case 'rewriter':
      return 'Cleans up the user request before planning. Short turn — cheap models work great.';
    case 'architect':
      return 'Drafts the implementation plan before code is written.';
    case 'critic':
      return 'Reviews the plan for gaps. Short turn — cheap models work great.';
    case 'coder':
      return 'The main agent that writes code. Default for the workstream.';
    case 'reviewer':
      return 'Reviews coder output and posts feedback. Short turn — cheap models work great.';
  }
}

/** Allowed reasoning-effort values in order of intensity. */
export const REASONING_EFFORTS: ReadonlyArray<{ value: ReasoningEffort | ''; label: string }> = [
  { value: '', label: 'Auto (derive from model)' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra High' },
];
