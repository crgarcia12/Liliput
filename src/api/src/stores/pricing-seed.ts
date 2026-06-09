/**
 * Default pricing seed for the `model_pricing` table.
 *
 * Source: https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
 * Snapshot date: 2026-06-09. All prices are USD per 1,000,000 tokens.
 * `effective_from` is set far in the past (2024-01-01) so the rows match
 * historical turns when the cost backfill synthesises calls from existing
 * `turns` rows.
 *
 * Mapping notes (SDK model id → GH pricing row):
 *   - claude-opus-4.7-1m-internal, claude-opus-4.7-high, claude-opus-4.7-xhigh
 *     are all priced like claude-opus-4.7 (same base model, different
 *     reasoning-effort / context-window variants).
 *   - claude-opus-4.6-1m is priced like claude-opus-4.6.
 *   - gemini-3.1-pro-preview has a long-context tier above 200K input tokens.
 *   - gpt-5.4 and gpt-5.5 have long-context tiers above 272K input tokens.
 *   - `auto`, `gpt-4.1`, and any other SDK ids not in the GH pricing table
 *     are intentionally omitted — they will be reported as `unpriced` in the
 *     cost rollup until someone POSTs a price row for them.
 *
 * Re-running this on a fresh boot is idempotent: `upsertPrice` matches on the
 * UNIQUE key (model, tier, min_input_tokens, effective_from, currency) and
 * updates the existing row in place if found.
 */

import { upsertPrice } from './pricing-store.js';

const DEFAULT_EFFECTIVE_FROM = '2024-01-01';
const DEFAULT_SOURCE = 'github-copilot-docs-2026-06';

interface SeedRow {
  /** SDK model ids that should all share this pricing row. */
  models: readonly string[];
  /** Display label for the tier; the gating is by minInputTokens. */
  tier?: string;
  /** Lower bound on input tokens for this tier to apply. */
  minInputTokens?: number;
  inputPerMtok: number;
  cachedInputPerMtok?: number;
  /** Anthropic-only — Cache write column on the GH page. */
  cacheWritePerMtok?: number;
  outputPerMtok: number;
  notes?: string;
}

const SEED_ROWS: readonly SeedRow[] = [
  // ───────── Anthropic ─────────
  {
    models: ['claude-haiku-4.5'],
    inputPerMtok: 1.0,
    cachedInputPerMtok: 0.1,
    cacheWritePerMtok: 1.25,
    outputPerMtok: 5.0,
  },
  {
    models: ['claude-sonnet-4'],
    inputPerMtok: 3.0,
    cachedInputPerMtok: 0.3,
    cacheWritePerMtok: 3.75,
    outputPerMtok: 15.0,
  },
  {
    models: ['claude-sonnet-4.5'],
    inputPerMtok: 3.0,
    cachedInputPerMtok: 0.3,
    cacheWritePerMtok: 3.75,
    outputPerMtok: 15.0,
  },
  {
    models: ['claude-sonnet-4.6'],
    inputPerMtok: 3.0,
    cachedInputPerMtok: 0.3,
    cacheWritePerMtok: 3.75,
    outputPerMtok: 15.0,
  },
  {
    models: ['claude-opus-4.5'],
    inputPerMtok: 5.0,
    cachedInputPerMtok: 0.5,
    cacheWritePerMtok: 6.25,
    outputPerMtok: 25.0,
  },
  {
    models: ['claude-opus-4.6', 'claude-opus-4.6-1m'],
    inputPerMtok: 5.0,
    cachedInputPerMtok: 0.5,
    cacheWritePerMtok: 6.25,
    outputPerMtok: 25.0,
    notes: 'Opus 4.6 base + 1M context variant share the same per-token price.',
  },
  {
    models: [
      'claude-opus-4.7',
      'claude-opus-4.7-1m-internal',
      'claude-opus-4.7-high',
      'claude-opus-4.7-xhigh',
    ],
    inputPerMtok: 5.0,
    cachedInputPerMtok: 0.5,
    cacheWritePerMtok: 6.25,
    outputPerMtok: 25.0,
    notes: 'Opus 4.7 base + internal/high/xhigh reasoning variants share base price.',
  },
  {
    models: ['claude-opus-4.8'],
    inputPerMtok: 5.0,
    cachedInputPerMtok: 0.5,
    cacheWritePerMtok: 6.25,
    outputPerMtok: 25.0,
  },
  {
    models: ['claude-fable-5'],
    inputPerMtok: 10.0,
    cachedInputPerMtok: 1.0,
    cacheWritePerMtok: 12.5,
    outputPerMtok: 50.0,
  },

  // ───────── OpenAI ─────────
  {
    models: ['gpt-5-mini'],
    inputPerMtok: 0.25,
    cachedInputPerMtok: 0.025,
    outputPerMtok: 2.0,
  },
  {
    models: ['gpt-5.3-codex'],
    inputPerMtok: 1.75,
    cachedInputPerMtok: 0.175,
    outputPerMtok: 14.0,
  },
  {
    models: ['gpt-5.4'],
    tier: 'default',
    minInputTokens: 0,
    inputPerMtok: 2.5,
    cachedInputPerMtok: 0.25,
    outputPerMtok: 15.0,
    notes: 'Default tier: input ≤ 272K tokens.',
  },
  {
    models: ['gpt-5.4'],
    tier: 'long_context',
    minInputTokens: 272_001,
    inputPerMtok: 5.0,
    cachedInputPerMtok: 0.5,
    outputPerMtok: 22.5,
    notes: 'Long context tier: input > 272K tokens.',
  },
  {
    models: ['gpt-5.4-mini'],
    inputPerMtok: 0.75,
    cachedInputPerMtok: 0.075,
    outputPerMtok: 4.5,
  },
  {
    models: ['gpt-5.4-nano'],
    inputPerMtok: 0.2,
    cachedInputPerMtok: 0.02,
    outputPerMtok: 1.25,
  },
  {
    models: ['gpt-5.5'],
    tier: 'default',
    minInputTokens: 0,
    inputPerMtok: 5.0,
    cachedInputPerMtok: 0.5,
    outputPerMtok: 30.0,
    notes: 'Default tier: input ≤ 272K tokens.',
  },
  {
    models: ['gpt-5.5'],
    tier: 'long_context',
    minInputTokens: 272_001,
    inputPerMtok: 10.0,
    cachedInputPerMtok: 1.0,
    outputPerMtok: 45.0,
    notes: 'Long context tier: input > 272K tokens.',
  },

  // ───────── Google ─────────
  {
    models: ['gemini-2.5-pro'],
    inputPerMtok: 1.25,
    cachedInputPerMtok: 0.125,
    outputPerMtok: 10.0,
  },
  {
    models: ['gemini-3-flash'],
    inputPerMtok: 0.5,
    cachedInputPerMtok: 0.05,
    outputPerMtok: 3.0,
  },
  {
    models: ['gemini-3.1-pro-preview'],
    tier: 'default',
    minInputTokens: 0,
    inputPerMtok: 2.0,
    cachedInputPerMtok: 0.2,
    outputPerMtok: 12.0,
    notes: 'Default tier: input ≤ 200K tokens.',
  },
  {
    models: ['gemini-3.1-pro-preview'],
    tier: 'long_context',
    minInputTokens: 200_001,
    inputPerMtok: 4.0,
    cachedInputPerMtok: 0.4,
    outputPerMtok: 18.0,
    notes: 'Long context tier: input > 200K tokens.',
  },
  {
    models: ['gemini-3.5-flash'],
    inputPerMtok: 1.5,
    cachedInputPerMtok: 0.15,
    outputPerMtok: 9.0,
  },

  // ───────── GitHub fine-tuned ─────────
  {
    models: ['raptor-mini'],
    inputPerMtok: 0.25,
    cachedInputPerMtok: 0.025,
    outputPerMtok: 2.0,
  },

  // ───────── Microsoft ─────────
  {
    models: ['mai-code-1-flash', 'mai-code-1-flash-internal'],
    inputPerMtok: 0.75,
    cachedInputPerMtok: 0.075,
    outputPerMtok: 4.5,
    notes: 'Public + internal variants share the same price.',
  },
];

/**
 * Idempotently seed the model_pricing table with current GH Copilot rates.
 *
 * Safe to call on every boot — each row is upserted by its UNIQUE key
 * (model, tier, min_input_tokens, effective_from, currency) so re-runs are
 * no-ops unless the seed table itself changes.
 */
export function seedDefaultPricing(): { inserted: number; models: number } {
  let inserted = 0;
  let modelCount = 0;
  for (const row of SEED_ROWS) {
    for (const model of row.models) {
      const input: Parameters<typeof upsertPrice>[0] = {
        model,
        inputPerMtok: row.inputPerMtok,
        outputPerMtok: row.outputPerMtok,
        effectiveFrom: DEFAULT_EFFECTIVE_FROM,
        source: DEFAULT_SOURCE,
      };
      if (row.tier !== undefined) input.tier = row.tier;
      if (row.minInputTokens !== undefined) input.minInputTokens = row.minInputTokens;
      if (row.cachedInputPerMtok !== undefined) input.cachedInputPerMtok = row.cachedInputPerMtok;
      if (row.cacheWritePerMtok !== undefined) input.cacheWritePerMtok = row.cacheWritePerMtok;
      if (row.notes !== undefined) input.notes = row.notes;
      upsertPrice(input);
      inserted += 1;
      modelCount += 1;
    }
  }
  return { inserted, models: modelCount };
}
