'use client';

import type { ReactElement } from 'react';
import type { UsageRollup } from '@shared/types';

/** Format token counts compactly: 1234 -> "1.2k", 1234567 -> "1.2M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

/** Format milliseconds as a short duration: "1.2s", "45s", "3m12s", "1h05m". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${String(rs).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h${String(rm).padStart(2, '0')}m`;
}

interface TokenBadgeProps {
  rollup: UsageRollup | undefined;
  /** Compact = no label, just number. */
  compact?: boolean;
  /** Optional className override. */
  className?: string;
}

/**
 * Inline token-count chip with breakdown tooltip.
 * Renders nothing when rollup is undefined or has zero tokens — keeps the UI
 * uncluttered for repos/workstreams that haven't generated any LLM activity.
 */
export default function TokenBadge({ rollup, compact, className }: TokenBadgeProps): ReactElement | null {
  if (!rollup || rollup.totalTokens === 0) return null;
  const tooltip = [
    `in: ${rollup.inputTokens.toLocaleString()}`,
    `out: ${rollup.outputTokens.toLocaleString()}`,
    `cache r: ${rollup.cacheReadTokens.toLocaleString()}`,
    `cache w: ${rollup.cacheWriteTokens.toLocaleString()}`,
    `turns: ${rollup.turns}`,
    rollup.nanoAiu && rollup.nanoAiu > 0 ? `nanoAiu: ${rollup.nanoAiu.toLocaleString()}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <span
      title={tooltip}
      className={
        className ??
        'inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-mono bg-purple-500/10 text-purple-300 border border-purple-500/20'
      }
    >
      {compact ? '' : '🪙 '}
      {formatTokens(rollup.totalTokens)}
    </span>
  );
}
