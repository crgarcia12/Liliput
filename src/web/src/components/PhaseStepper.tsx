'use client';

import { useEffect, useState } from 'react';
import type { Task, Agent } from '@shared/types';

/**
 * Visual pipeline showing the active phase of a task at a glance.
 *
 * Order mirrors the engine's phase progression:
 *   clarify → specify → build → deploy → review → ship → done
 *
 * Each segment shows:
 *   - filled when that phase has been entered
 *   - pulsing accent on the current phase
 *   - dim when not yet reached
 *
 * The header next to the stepper shows live elapsed time in the current phase.
 */

const PHASES: Array<{
  key: 'clarifying' | 'specifying' | 'building' | 'deploying' | 'review' | 'shipping';
  label: string;
  icon: string;
  short: string;
}> = [
  { key: 'clarifying',  label: 'Clarifying', icon: '💬', short: 'Clarify' },
  { key: 'specifying',  label: 'Specifying', icon: '📜', short: 'Spec' },
  { key: 'building',    label: 'Building',   icon: '🔨', short: 'Build' },
  { key: 'deploying',   label: 'Deploying',  icon: '🚀', short: 'Deploy' },
  { key: 'review',      label: 'Review',     icon: '👀', short: 'Review' },
  { key: 'shipping',    label: 'Shipping',   icon: '🚢', short: 'Ship' },
];

const PHASE_INDEX: Record<string, number> = Object.fromEntries(
  PHASES.map((p, i) => [p.key, i]),
);

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

interface PhaseStepperProps {
  task: Pick<Task, 'status' | 'createdAt' | 'updatedAt'>;
  agents: Agent[];
}

export default function PhaseStepper({ task, agents }: PhaseStepperProps) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Use the most recent working agent's startedAt as the proxy for "phase started"
  const workingAgents = agents.filter((a) => a.status === 'working' && a.startedAt);
  const earliestWorking = workingAgents
    .map((a) => new Date(a.startedAt!).getTime())
    .sort((a, b) => a - b)[0];
  const phaseStart = earliestWorking ?? new Date(task.updatedAt).getTime();

  const isTerminal =
    task.status === 'completed' || task.status === 'discarded' || task.status === 'failed';
  const currentIdx = PHASE_INDEX[task.status as string] ?? -1;

  return (
    <div className="flex items-center gap-1 text-xs">
      {PHASES.map((p, i) => {
        const isCurrent = i === currentIdx;
        const isDone =
          task.status === 'completed' || (currentIdx >= 0 && i < currentIdx);
        const isDimmed = currentIdx >= 0 ? i > currentIdx : !isTerminal;

        return (
          <div
            key={p.key}
            className={[
              'flex items-center gap-1 px-1.5 py-0.5 rounded',
              isCurrent ? 'bg-cyan-900/40 border border-cyan-700/50 text-cyan-300 animate-pulse' : '',
              isDone ? 'text-green-400' : '',
              isDimmed ? 'text-gray-600' : '',
            ].join(' ')}
            title={p.label}
          >
            <span>{p.icon}</span>
            <span className="hidden md:inline">{p.short}</span>
          </div>
        );
      })}
      {!isTerminal && currentIdx >= 0 && (
        <span className="ml-2 text-gray-500">
          ·{' '}
          <span className="text-gray-300">{fmtElapsed(Date.now() - phaseStart)}</span>{' '}
          in {PHASES[currentIdx].short.toLowerCase()}
        </span>
      )}
    </div>
  );
}
