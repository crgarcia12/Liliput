/**
 * Cost store — joins `turn_usage_call` rows against `model_pricing` to
 * produce CostRollup objects for tasks, workstreams, and repositories.
 *
 * Cost is computed at read time so the price book can be updated without
 * needing to backfill historical rows. The price effective at the call's
 * `occurred_at` is used (NOT the price effective today).
 */

import type { CostByModel, CostRollup } from '../../../shared/types/index.js';
import { getDb } from './db.js';
import { getEffectivePrice } from './pricing-store.js';

interface CallRow {
  id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  occurred_at: string;
}

function costForRows(rows: CallRow[], currency: string): CostRollup {
  // Bucket calls by model so the rollup has a per-model breakdown.
  const buckets = new Map<string, CostByModel>();
  let pricedCalls = 0;
  let unpricedCalls = 0;
  let total = 0;

  for (const r of rows) {
    const price = getEffectivePrice(r.model, r.occurred_at, r.input_tokens, currency);
    let bucket = buckets.get(r.model);
    if (!bucket) {
      bucket = {
        model: r.model,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCost: 0,
        hasUnpriced: false,
      };
      buckets.set(r.model, bucket);
    }
    bucket.calls += 1;
    bucket.inputTokens += r.input_tokens;
    bucket.outputTokens += r.output_tokens;
    bucket.cacheReadTokens += r.cache_read_tokens;
    bucket.cacheWriteTokens += r.cache_write_tokens;

    if (!price) {
      unpricedCalls += 1;
      bucket.hasUnpriced = true;
      continue;
    }

    const callCost =
      (r.input_tokens / 1_000_000) * price.inputPerMtok +
      (r.output_tokens / 1_000_000) * price.outputPerMtok +
      (r.cache_read_tokens / 1_000_000) * (price.cachedInputPerMtok ?? 0) +
      (r.cache_write_tokens / 1_000_000) * (price.cacheWritePerMtok ?? 0);
    bucket.estimatedCost += callCost;
    total += callCost;
    pricedCalls += 1;
  }

  // Stable sort: highest-cost model first, then by name.
  const perModel = Array.from(buckets.values()).sort((a, b) => {
    if (b.estimatedCost !== a.estimatedCost) return b.estimatedCost - a.estimatedCost;
    return a.model.localeCompare(b.model);
  });

  return {
    currency,
    estimatedCost: total,
    pricedCalls,
    unpricedCalls,
    perModel,
  };
}

const CALL_SELECT = `
  SELECT id, model, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, occurred_at
    FROM turn_usage_call
`;

export function costForTask(taskId: string, currency: string = 'USD'): CostRollup {
  const rows = getDb()
    .prepare(`${CALL_SELECT} WHERE task_id = ?`)
    .all(taskId) as CallRow[];
  return costForRows(rows, currency);
}

export function costForWorkstream(workstreamId: string, currency: string = 'USD'): CostRollup {
  const rows = getDb()
    .prepare(
      `${CALL_SELECT}
        WHERE task_id IN (SELECT id FROM tasks WHERE workstream_id = ?)`,
    )
    .all(workstreamId) as CallRow[];
  return costForRows(rows, currency);
}

export function costForRepo(repository: string, currency: string = 'USD'): CostRollup {
  const rows = getDb()
    .prepare(
      `${CALL_SELECT}
        WHERE task_id IN (SELECT id FROM tasks WHERE repository = ?)`,
    )
    .all(repository) as CallRow[];
  return costForRows(rows, currency);
}
