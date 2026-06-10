'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { ModelOption, ModelsResponse, ReasoningEffort } from '@shared/types';
import {
  useProfileDefaults,
  roleLabel,
  roleDescription,
  REASONING_EFFORTS,
  AGENT_CONFIG_ROLES,
} from '../../../../hooks/useProfileDefaults';

export default function MobileProfileAgentsPage() {
  const { defaults, loading, error, setRoleDefault, resetRole, saving } = useProfileDefaults();

  const [modelOptions, setModelOptions] = useState<readonly ModelOption[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [serverDefault, setServerDefault] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/models', { credentials: 'include' })
      .then((r) => r.json() as Promise<ModelsResponse>)
      .then((data) => {
        if (cancelled) return;
        setModelOptions(data.options);
        setServerDefault(data.default);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setModelsError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const byRole = new Map(defaults.map((d) => [d.role, d]));

  return (
    <div className="flex flex-col h-screen bg-[#0a0a0f] text-gray-100">
      <header className="sticky top-0 z-10 flex items-center gap-2 px-3 py-2 bg-[#0d0d14] border-b border-[#1a1a2e]">
        <Link
          href="/m"
          className="text-gray-400 hover:text-gray-200 px-2 py-2 -ml-2 text-base"
          aria-label="Back"
        >
          ←
        </Link>
        <h1 className="text-sm font-bold truncate flex-1 min-w-0 text-cyan-400">
          ⚙ Agent defaults
        </h1>
      </header>

      <main className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        <p className="text-xs text-gray-400">
          Pick the model each agent uses by default. Workstreams that don&apos;t pin their own model
          read live from this profile on every turn.
        </p>

        {error && (
          <div className="p-2 rounded bg-red-900/30 border border-red-800 text-xs text-red-200">
            {error}
          </div>
        )}
        {modelsError && (
          <div className="p-2 rounded bg-amber-900/30 border border-amber-800 text-xs text-amber-200">
            ⚠ Model list failed to load: {modelsError}
          </div>
        )}

        {loading ? (
          <p className="text-xs text-gray-500">Loading…</p>
        ) : (
          AGENT_CONFIG_ROLES.map((role) => {
            const d = byRole.get(role);
            const pinned = d?.pinnedModel ?? '';
            const pinnedEffort = (d?.pinnedReasoningEffort ?? '') as ReasoningEffort | '';
            const effective = d?.effectiveModel ?? '(server default)';
            const isPinned = Boolean(pinned);
            const isSaving = saving === role;
            return (
              <div key={role} className="rounded border border-[#1a1a2e] bg-[#10101c] p-3">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div>
                    <div className="text-sm font-semibold text-gray-100">{roleLabel(role)}</div>
                    <div className="text-[11px] text-gray-500 leading-snug">{roleDescription(role)}</div>
                  </div>
                  {isPinned && (
                    <button
                      onClick={async () => {
                        try {
                          await resetRole(role);
                        } catch {
                          /* error in hook */
                        }
                      }}
                      disabled={isSaving}
                      className="text-[10px] px-2 py-1 rounded border border-[#1a1a2e] hover:bg-[#15152a] text-gray-300 shrink-0 disabled:opacity-40"
                    >
                      {isSaving ? '…' : '↺'}
                    </button>
                  )}
                </div>

                <label className="block text-[10px] text-gray-500 mt-2 mb-1">Model</label>
                <select
                  value={pinned}
                  disabled={isSaving || modelOptions.length === 0}
                  onChange={async (e) => {
                    const next = e.target.value;
                    try {
                      await setRoleDefault(role, {
                        model: next ? next : null,
                        reasoningEffort: pinnedEffort ? pinnedEffort : null,
                      });
                    } catch {
                      /* error in hook */
                    }
                  }}
                  className="w-full bg-[#0d0d14] border border-[#1a1a2e] rounded px-2 py-1.5 text-xs"
                >
                  <option value="">— Server default ({serverDefault || '…'}) —</option>
                  {modelOptions.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label} ({opt.id})
                    </option>
                  ))}
                </select>

                <label className="block text-[10px] text-gray-500 mt-2 mb-1">Reasoning effort</label>
                <select
                  value={pinnedEffort}
                  disabled={isSaving}
                  onChange={async (e) => {
                    const next = e.target.value as ReasoningEffort | '';
                    try {
                      await setRoleDefault(role, {
                        model: pinned ? pinned : null,
                        reasoningEffort: next ? next : null,
                      });
                    } catch {
                      /* error in hook */
                    }
                  }}
                  className="w-full bg-[#0d0d14] border border-[#1a1a2e] rounded px-2 py-1.5 text-xs"
                >
                  {REASONING_EFFORTS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>

                <div className="mt-2 flex items-center justify-between text-[10px] text-gray-500">
                  <span className="font-mono text-gray-400 truncate">
                    → {effective}
                  </span>
                  <span className="uppercase tracking-wide text-gray-600">
                    {d?.source ?? 'default'}
                  </span>
                </div>
              </div>
            );
          })
        )}

        <p className="text-[11px] text-gray-500 pt-2">
          💡 New accounts are seeded with cheap models for the rewriter, critic, and reviewer.
          Coder and architect are unseeded — they use the server&apos;s stronger default.
        </p>
      </main>
    </div>
  );
}
