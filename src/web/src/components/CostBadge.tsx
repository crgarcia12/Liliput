import type { ReactElement } from 'react';
import type { CostRollup } from '@shared/types';

interface CostBadgeProps {
  rollup: CostRollup | undefined;
  /** Render in a compact form (just the dollar amount, no leading icon). */
  compact?: boolean;
  className?: string;
}

/**
 * Format a USD cost. Below $0.01 we render `<$0.01` (still visible but not
 * misleading), above $100 we drop the cents so badges don't blow up the row.
 */
function formatCost(amount: number, currency: string): string {
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  if (amount === 0) return `${symbol}0`;
  if (amount < 0.01) return `<${symbol}0.01`;
  if (amount >= 100) return `${symbol}${amount.toFixed(0)}`;
  return `${symbol}${amount.toFixed(2)}`;
}

/**
 * Cost badge — sibling of <TokenBadge/>. Renders the estimated dollar cost
 * of a rollup. Hidden entirely when the rollup is missing or has zero priced
 * calls (so a blank task doesn't show a noisy `$0`). Shows a small ⚠ when
 * some calls are unpriced (price book is missing rows for that model).
 */
export default function CostBadge({
  rollup,
  compact,
  className,
}: CostBadgeProps): ReactElement | null {
  if (!rollup) return null;
  if (rollup.pricedCalls === 0 && rollup.unpricedCalls === 0) return null;

  const text = formatCost(rollup.estimatedCost, rollup.currency);

  const tooltipLines = [
    `Estimated cost: ${formatCost(rollup.estimatedCost, rollup.currency)}`,
    `Priced calls: ${rollup.pricedCalls.toLocaleString()}`,
    rollup.unpricedCalls > 0
      ? `Unpriced calls: ${rollup.unpricedCalls.toLocaleString()} (no price-book row)`
      : '',
    '',
    'Per model:',
    ...rollup.perModel.slice(0, 10).map((m) => {
      const cost = formatCost(m.estimatedCost, rollup.currency);
      const flag = m.hasUnpriced ? ' (some unpriced)' : '';
      return `  ${m.model}: ${cost} — ${m.calls} call${m.calls === 1 ? '' : 's'}${flag}`;
    }),
  ].filter(Boolean);
  const tooltip = tooltipLines.join('\n');

  return (
    <span
      title={tooltip}
      className={
        className ??
        'inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-mono bg-emerald-500/10 text-emerald-300 border border-emerald-500/20'
      }
    >
      {compact ? '' : '💰 '}
      {text}
      {rollup.unpricedCalls > 0 && (
        <span className="ml-0.5 text-amber-400" title="Some calls have no price-book row">
          ⚠
        </span>
      )}
    </span>
  );
}
