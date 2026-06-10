'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import TopBar from '../../../components/TopBar';
import type { ModelOption, ModelsResponse, ReasoningEffort } from '@shared/types';
import { AGENT_CONFIG_ROLES } from '@shared/types';
import {
  useProfileDefaults,
  roleLabel,
  roleDescription,
  REASONING_EFFORTS,
} from '../../../hooks/useProfileDefaults';

export default function ProfileAgentsPage() {
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
    <div className="min-h-screen bg-[#0a0a0f] text-gray-100">
      <TopBar subtitle="Profile" hideNewCta />
      <main className="max-w-5xl mx-auto px-4 py-6">
        <div className="mb-6">
          <h1 className="text-xl font-bold text-cyan-300 mb-1">⚙ Agent model defaults</h1>
          <p className="text-sm text-gray-400">
            Pick the model + reasoning effort each agent should use by default.
            Workstreams that don&apos;t pin their own model resolve <strong>live</strong>
            from this profile on every turn — so changes here apply to your next
            agent call automatically. Workstreams with a manually-selected model
            keep that pin until you reset it.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-gray-500">
            <span>Resolution order:</span>
            <code className="px-1.5 py-0.5 bg-[#1a1a2e] rounded">workstream pin</code>
            <span>→</span>
            <code className="px-1.5 py-0.5 bg-[#1a1a2e] rounded">profile (this page)</code>
            <span>→</span>
            <code className="px-1.5 py-0.5 bg-[#1a1a2e] rounded">server default ({serverDefault || '…'})</code>
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded bg-red-900/30 border border-red-800 text-sm text-red-200">
            {error}
          </div>
        )}
        {modelsError && (
          <div className="mb-4 p-3 rounded bg-amber-900/30 border border-amber-800 text-sm text-amber-200">
            ⚠ Failed to load model list: {modelsError}. The dropdowns will be empty.
          </div>
        )}

        {loading ? (
          <p className="text-sm text-gray-400">Loading profile…</p>
        ) : (
          <div className="overflow-x-auto rounded border border-[#1a1a2e]">
            <table className="w-full text-sm">
              <thead className="bg-[#10101c] text-gray-400 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left px-3 py-2">Agent</th>
                  <th className="text-left px-3 py-2">Model</th>
                  <th className="text-left px-3 py-2">Reasoning effort</th>
                  <th className="text-left px-3 py-2">Effective</th>
                  <th className="text-right px-3 py-2">Reset</th>
                </tr>
              </thead>
              <tbody>
                {AGENT_CONFIG_ROLES.map((role) => {
                  const d = byRole.get(role);
                  const pinned = d?.pinnedModel ?? '';
                  const pinnedEffort = (d?.pinnedReasoningEffort ?? '') as ReasoningEffort | '';
                  const effective = d?.effectiveModel ?? '(server default)';
                  const isPinned = Boolean(pinned);
                  const isSaving = saving === role;
                  return (
                    <tr key={role} className="border-t border-[#1a1a2e] hover:bg-[#10101c]/40">
                      <td className="px-3 py-3 align-top w-1/4">
                        <div className="font-medium text-gray-100">{roleLabel(role)}</div>
                        <div className="text-xs text-gray-500 mt-1">{roleDescription(role)}</div>
                      </td>
                      <td className="px-3 py-3 align-top">
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
                              /* error already in hook state */
                            }
                          }}
                          className="bg-[#0d0d14] border border-[#1a1a2e] rounded px-2 py-1 text-sm min-w-[14rem]"
                        >
                          <option value="">— Use server default ({serverDefault || '…'}) —</option>
                          {modelOptions.map((opt) => (
                            <option key={opt.id} value={opt.id}>
                              {opt.label} ({opt.id})
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-3 align-top">
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
                              /* error already in hook state */
                            }
                          }}
                          className="bg-[#0d0d14] border border-[#1a1a2e] rounded px-2 py-1 text-sm"
                        >
                          {REASONING_EFFORTS.map((r) => (
                            <option key={r.value} value={r.value}>
                              {r.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-3 align-top text-xs text-gray-400">
                        <div className="font-mono">{effective}</div>
                        {d?.effectiveReasoningEffort && (
                          <div className="text-gray-500">effort: {d.effectiveReasoningEffort}</div>
                        )}
                        <div className="text-[10px] uppercase tracking-wide text-gray-600 mt-1">
                          source: {d?.source ?? 'default'}
                        </div>
                      </td>
                      <td className="px-3 py-3 align-top text-right">
                        {isPinned ? (
                          <button
                            onClick={async () => {
                              try {
                                await resetRole(role);
                              } catch {
                                /* error already in hook state */
                              }
                            }}
                            disabled={isSaving}
                            className="text-xs px-2 py-1 rounded border border-[#1a1a2e] hover:bg-[#15152a] text-gray-300 disabled:opacity-40"
                            title="Drop this row — fall back to server default"
                          >
                            {isSaving ? '…' : '↺ Reset'}
                          </button>
                        ) : (
                          <span className="text-[10px] text-gray-600">unset</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-6 text-xs text-gray-500">
          <p>
            💡 New accounts are seeded with cheap defaults for the rewriter, critic, and reviewer
            (short bounded turns where small models work great). Coder and architect are left
            unseeded so they inherit the server&apos;s stronger default.
          </p>
          <p className="mt-2">
            <Link href="/dashboard" className="underline hover:text-cyan-300">← Back to workstreams</Link>
          </p>
        </div>
      </main>
    </div>
  );
}
