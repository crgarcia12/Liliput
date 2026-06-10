'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import type { ModelOption, ModelsResponse } from '@shared/types';
import { useMobileTask } from '../useMobileTask';
import { get as apiGet } from '../../../../../lib/api-client';
import { useProfileDefaults } from '../../../../../hooks/useProfileDefaults';

export default function MobileTaskConfigPage() {
  const params = useParams();
  const taskId = params.id as string;
  const m = useMobileTask(taskId);

  const [modelOptions, setModelOptions] = useState<readonly ModelOption[]>([]);
  const [modelDefault, setModelDefault] = useState<string>('');
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelsSource, setModelsSource] = useState<'sdk' | 'fallback' | null>(null);

  const { defaults: profileDefaults } = useProfileDefaults();
  const coderProfile = profileDefaults.find((d) => d.role === 'coder');
  const reviewerProfile = profileDefaults.find((d) => d.role === 'reviewer');
  const coderProfileLabel = coderProfile?.effectiveModel ?? modelDefault ?? '';
  const reviewerProfileLabel = reviewerProfile?.effectiveModel ?? '';

  useEffect(() => {
    let cancelled = false;
    apiGet<ModelsResponse>('/api/models')
      .then((data) => {
        if (cancelled) return;
        setModelsError(null);
        setModelsSource(data.source ?? 'sdk');
        setModelOptions(data.options);
        setModelDefault(data.default);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        console.error('Failed to load /api/models', err);
        setModelsError(msg);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const task = m.task;
  const showModelControls =
    task && task.status !== 'completed' && task.status !== 'deleting';
  const errorText = m.error || task?.errorMessage;

  return (
    <div className="flex flex-col h-screen bg-[#0a0a0f]">
      <header className="sticky top-0 z-10 flex items-center gap-2 px-3 py-2 bg-[#0d0d14] border-b border-[#1a1a2e]">
        <Link
          href={`/m/task/${taskId}`}
          className="text-gray-400 hover:text-gray-200 px-2 py-2 -ml-2 text-base"
          aria-label="Back"
        >
          ←
        </Link>
        <h1 className="text-sm font-bold truncate flex-1 min-w-0 text-gray-200">
          ⚙ Config
        </h1>
      </header>

      {errorText && (
        <div className="px-3 py-2 bg-red-900/30 border-b border-red-800 text-red-300 text-xs flex items-center gap-2">
          <span>⚠️</span>
          <span className="flex-1 font-mono break-words">{errorText}</span>
          {m.error && (
            <button
              onClick={() => m.setError(null)}
              className="text-red-200 hover:text-white px-2 py-1"
              aria-label="Dismiss error"
            >
              ✕
            </button>
          )}
        </div>
      )}

      <main className="flex-1 min-h-0 overflow-y-auto p-4 space-y-6">
        {!task ? (
          <div className="text-gray-500 text-sm">Loading…</div>
        ) : (
          <>
            {showModelControls && modelOptions.length > 0 && (
              <section>
                <label
                  htmlFor="m-model"
                  className="block text-xs uppercase tracking-wide text-gray-500 mb-2"
                >
                  🧠 Model
                  {modelsSource === 'fallback' && (
                    <span
                      className="ml-2 text-amber-400 normal-case tracking-normal"
                      title="Copilot SDK list unavailable — showing fallback list."
                    >
                      ⚠ fallback
                    </span>
                  )}
                </label>
                <select
                  id="m-model"
                  value={task.model ?? '__profile_default__'}
                  disabled={m.modelPending}
                  onChange={(e) => {
                    const next = e.target.value;
                    if (next === '__profile_default__') {
                      if (task.model) m.setTaskModel(null);
                      return;
                    }
                    if (next === (task.model ?? '__profile_default__')) return;
                    m.setTaskModel(next);
                  }}
                  className="w-full bg-[#050510] border border-[#1a1a2e] rounded px-3 py-3 min-h-[44px] text-sm text-gray-200 focus:outline-none focus:border-cyan-500 disabled:opacity-50"
                >
                  <option value="__profile_default__">
                    🔗 Use my profile default{coderProfileLabel ? ` (${coderProfileLabel})` : ''}
                  </option>
                  {modelOptions.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-gray-500 mt-1">
                  Applies on next agent turn. Pick &quot;Use my profile default&quot; to follow your{' '}
                  <Link href="/m/profile/agents" className="underline">profile</Link> live.
                </p>
              </section>
            )}

            {showModelControls && modelOptions.length === 0 && modelsError && (
              <section>
                <div className="text-xs text-red-300 bg-red-900/30 border border-red-800 rounded px-3 py-2">
                  ⚠ Failed to load model list: {modelsError}. Reload to retry.
                </div>
              </section>
            )}

            {showModelControls && (
              <section>
                <label
                  htmlFor="m-effort"
                  className="block text-xs uppercase tracking-wide text-gray-500 mb-2"
                >
                  ⚙ Reasoning effort
                </label>
                <select
                  id="m-effort"
                  value={task.reasoningEffort ?? ''}
                  disabled={m.reasoningPending}
                  onChange={(e) => {
                    const next = e.target.value as
                      | ''
                      | 'low'
                      | 'medium'
                      | 'high'
                      | 'xhigh';
                    if (next === (task.reasoningEffort ?? '')) return;
                    m.setTaskReasoningEffort(next);
                  }}
                  className="w-full bg-[#050510] border border-[#1a1a2e] rounded px-3 py-3 min-h-[44px] text-sm text-gray-200 focus:outline-none focus:border-cyan-500 disabled:opacity-50"
                >
                  <option value="">auto</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                  <option value="xhigh">xhigh</option>
                </select>
              </section>
            )}

            {showModelControls && modelOptions.length > 0 && (
              <section>
                <label
                  htmlFor="m-reviewer-model"
                  className="block text-xs uppercase tracking-wide text-violet-400 mb-2"
                >
                  🔍 Checking model
                </label>
                <select
                  id="m-reviewer-model"
                  value={task.reviewerModel ?? '__profile_default__'}
                  disabled={m.reviewerPending}
                  onChange={(e) => {
                    const next = e.target.value;
                    if (next === '__profile_default__') {
                      if (task.reviewerModel) m.setTaskReviewerModel('');
                      return;
                    }
                    if (next === (task.reviewerModel ?? '__profile_default__')) return;
                    m.setTaskReviewerModel(next);
                  }}
                  className="w-full bg-[#050510] border border-[#1a1a2e] rounded px-3 py-3 min-h-[44px] text-sm text-violet-200 focus:outline-none focus:border-violet-500 disabled:opacity-50"
                >
                  <option value="__profile_default__">
                    🔗 Use my profile default{reviewerProfileLabel ? ` (${reviewerProfileLabel})` : ' (off)'}
                  </option>
                  <option value="">off (force disable)</option>
                  {modelOptions.map((opt) => (
                    <option key={`reviewer-${opt.id}`} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-gray-500 mt-1">
                  A second model checks the agent and only comments when it finds something important.
                </p>
              </section>
            )}

            {showModelControls && task.reviewerModel && (
              <section>
                <label
                  htmlFor="m-reviewer-effort"
                  className="block text-xs uppercase tracking-wide text-violet-400 mb-2"
                >
                  ⚙ Checking reasoning
                </label>
                <select
                  id="m-reviewer-effort"
                  value={task.reviewerReasoningEffort ?? ''}
                  disabled={m.reviewerPending}
                  onChange={(e) => {
                    const next = e.target.value as
                      | ''
                      | 'low'
                      | 'medium'
                      | 'high'
                      | 'xhigh';
                    if (next === (task.reviewerReasoningEffort ?? '')) return;
                    m.setTaskReviewerReasoningEffort(next);
                  }}
                  className="w-full bg-[#050510] border border-[#1a1a2e] rounded px-3 py-3 min-h-[44px] text-sm text-violet-200 focus:outline-none focus:border-violet-500 disabled:opacity-50"
                >
                  <option value="">auto</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                  <option value="xhigh">xhigh</option>
                </select>
              </section>
            )}

            <section>
              <h2 className="text-xs uppercase tracking-wide text-gray-500 mb-2">
                Repository
              </h2>
              <div className="text-sm text-gray-300 font-mono break-all">
                📦 {task.repository || '—'}
                {task.repository ? `@${task.baseBranch ?? 'main'}` : ''}
              </div>
            </section>

            {task.devUrl && (
              <section>
                <h2 className="text-xs uppercase tracking-wide text-gray-500 mb-2">
                  Dev preview
                </h2>
                <a
                  href={task.devUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block w-full text-center px-4 py-3 min-h-[44px] rounded bg-cyan-900/40 border border-cyan-700/50 text-cyan-200 hover:bg-cyan-900/60 text-sm"
                >
                  🌐 Open dev preview
                </a>
              </section>
            )}

            {task.pullRequestUrl && (
              <section>
                <h2 className="text-xs uppercase tracking-wide text-gray-500 mb-2">
                  Pull request
                </h2>
                <a
                  href={task.pullRequestUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block w-full text-center px-4 py-3 min-h-[44px] rounded bg-purple-900/40 border border-purple-700/50 text-purple-200 hover:bg-purple-900/60 text-sm"
                >
                  🔀 Open PR{task.pullRequestNumber ? ` #${task.pullRequestNumber}` : ''}
                </a>
              </section>
            )}

            {task.spec && task.status === 'specifying' && (
              <section>
                <h2 className="text-xs uppercase tracking-wide text-gray-500 mb-2">
                  Spec approval
                </h2>
                <button
                  onClick={m.approveSpec}
                  disabled={m.actionPending === 'approve'}
                  className="w-full px-4 py-3 min-h-[44px] rounded bg-purple-700 hover:bg-purple-600 text-white text-sm disabled:opacity-50"
                >
                  {m.actionPending === 'approve' ? 'Approving…' : '✓ Approve & Build'}
                </button>
              </section>
            )}

            {task.status === 'review' && (
              <section className="space-y-3">
                <h2 className="text-xs uppercase tracking-wide text-gray-500">
                  Actions
                </h2>
                <button
                  onClick={m.shipTask}
                  disabled={m.actionPending !== null}
                  className="w-full px-4 py-3 min-h-[44px] rounded bg-green-700 hover:bg-green-600 text-white text-sm disabled:opacity-50"
                >
                  {m.actionPending === 'ship'
                    ? 'Shipping…'
                    : `🚀 Ship (${task.commitMode === 'direct' ? 'merge' : 'PR'})`}
                </button>
                <button
                  onClick={() => {
                    if (
                      confirm(
                        'Discard this task? Dev environment + branch will be deleted.',
                      )
                    ) {
                      m.discardTask();
                    }
                  }}
                  disabled={m.actionPending !== null}
                  className="w-full px-4 py-3 min-h-[44px] rounded bg-red-800 hover:bg-red-700 text-white text-sm disabled:opacity-50"
                >
                  {m.actionPending === 'discard' ? 'Discarding…' : '🗑 Discard'}
                </button>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
