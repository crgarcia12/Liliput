'use client';

import type { PipelineStage, PipelineStageStatus, PipelineState } from '@shared/types';

// Stage metadata is inlined here (rather than importing the runtime
// `PIPELINE_STAGES` value from `@shared/types`) because the web bundle only
// imports *types* from the shared package — pulling in a runtime value trips
// the CommonJS/ESM module-format conflict during the Next.js build.
const PIPELINE_STAGES: ReadonlyArray<{ key: PipelineStage; label: string; icon: string }> = [
  { key: 'rewrite', label: 'Rewrite', icon: '✍️' },
  { key: 'plan', label: 'Plan', icon: '🗺️' },
  { key: 'critique', label: 'Critique', icon: '🦆' },
  { key: 'implement', label: 'Implement', icon: '🔨' },
  { key: 'review', label: 'Review', icon: '👀' },
];

/**
 * AgentPipeline — the multi-agent state-machine diagram shown above the
 * activity log. Renders the five fixed stages every request flows through:
 *
 *   ✍️ Rewrite → 🗺️ Plan → 🦆 Critique → 🔨 Implement → 👀 Review
 *
 * The active stage pulses; done stages are green; skipped/failed are dimmed
 * or red. Driven entirely by the live `pipeline:stage` socket event (with the
 * persisted `task.pipeline` as the hydration fallback after reload).
 */

interface Props {
  pipeline?: PipelineState | null;
}

function statusClasses(status: PipelineStageStatus): string {
  switch (status) {
    case 'active':
      return 'bg-cyan-900/50 border-cyan-600/60 text-cyan-200 animate-pulse';
    case 'done':
      return 'bg-green-900/20 border-green-800/40 text-green-400';
    case 'failed':
      return 'bg-red-900/20 border-red-800/40 text-red-400';
    case 'skipped':
      return 'border-[#1a1a2e] text-gray-600 line-through';
    default:
      return 'border-[#1a1a2e] text-gray-600';
  }
}

function connectorClass(status: PipelineStageStatus): string {
  if (status === 'done') return 'bg-green-800/50';
  if (status === 'active') return 'bg-cyan-700/50';
  return 'bg-[#1a1a2e]';
}

export default function AgentPipeline({ pipeline }: Props) {
  const stages: Record<PipelineStage, PipelineStageStatus> =
    pipeline?.stages ?? {
      rewrite: 'pending',
      plan: 'pending',
      critique: 'pending',
      implement: 'pending',
      review: 'pending',
    };

  return (
    <div className="bg-[#0d0d14] border border-[#1a1a2e] rounded-lg px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">
        Agent pipeline
      </div>
      <div className="flex items-center gap-1 overflow-x-auto">
        {PIPELINE_STAGES.map((stage, i) => {
          const status = stages[stage.key] ?? 'pending';
          return (
            <div key={stage.key} className="flex items-center gap-1 shrink-0">
              <div
                className={[
                  'flex items-center gap-1 px-2 py-1 rounded border text-xs whitespace-nowrap',
                  statusClasses(status),
                ].join(' ')}
                title={`${stage.label} — ${status}`}
              >
                <span className="text-sm leading-none">{stage.icon}</span>
                <span className="hidden sm:inline">{stage.label}</span>
                {status === 'done' && <span className="text-green-500">✓</span>}
              </div>
              {i < PIPELINE_STAGES.length - 1 && (
                <div className={['h-0.5 w-3 rounded', connectorClass(status)].join(' ')} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
