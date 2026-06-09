/**
 * Pricing store — CRUD over `model_pricing` and the effective-price lookup
 * used by the cost calculator.
 *
 * Pricing rows are versioned by `effective_from` (ISO date) so prices can
 * change without losing historical accuracy. For models with tiered pricing
 * (e.g. GitHub's "Default" vs "Long context" for GPT-5.4/5.5), multiple rows
 * coexist with different `min_input_tokens` thresholds; the lookup picks the
 * highest threshold the call qualifies for.
 *
 * Units: every `*_per_mtok` column is the price per 1,000,000 tokens, in the
 * row's `currency` (default USD). Cost for a single call is:
 *   inputTokens     / 1e6 * input_per_mtok
 * + outputTokens    / 1e6 * output_per_mtok
 * + cacheReadTokens / 1e6 * cached_input_per_mtok (defaults to 0 if NULL)
 * + cacheWriteTokens/ 1e6 * cache_write_per_mtok  (defaults to 0 if NULL)
 */

import { v4 as uuid } from 'uuid';
import type { ModelPrice } from '../../../shared/types/index.js';
import { getDb } from './db.js';

interface ModelPricingRow {
  id: string;
  model: string;
  tier: string;
  min_input_tokens: number;
  currency: string;
  input_per_mtok: number;
  cached_input_per_mtok: number | null;
  cache_write_per_mtok: number | null;
  output_per_mtok: number;
  effective_from: string;
  source: string | null;
  notes: string | null;
  created_at: string;
}

function rowToPrice(row: ModelPricingRow): ModelPrice {
  const price: ModelPrice = {
    id: row.id,
    model: row.model,
    tier: row.tier,
    minInputTokens: row.min_input_tokens,
    currency: row.currency,
    inputPerMtok: row.input_per_mtok,
    outputPerMtok: row.output_per_mtok,
    effectiveFrom: row.effective_from,
    createdAt: row.created_at,
  };
  if (row.cached_input_per_mtok != null) price.cachedInputPerMtok = row.cached_input_per_mtok;
  if (row.cache_write_per_mtok != null) price.cacheWritePerMtok = row.cache_write_per_mtok;
  if (row.source != null) price.source = row.source;
  if (row.notes != null) price.notes = row.notes;
  return price;
}

export interface UpsertPriceInput {
  model: string;
  tier?: string;
  minInputTokens?: number;
  currency?: string;
  inputPerMtok: number;
  cachedInputPerMtok?: number | null;
  cacheWritePerMtok?: number | null;
  outputPerMtok: number;
  effectiveFrom: string;
  source?: string | null;
  notes?: string | null;
}

/** Insert a new price row, or replace the one matching the UNIQUE key
 *  (model, tier, min_input_tokens, effective_from, currency). */
export function upsertPrice(input: UpsertPriceInput): ModelPrice {
  const db = getDb();
  const id = uuid();
  const createdAt = new Date().toISOString();
  const tier = input.tier ?? 'default';
  const minIn = input.minInputTokens ?? 0;
  const currency = input.currency ?? 'USD';

  // Find existing row matching the UNIQUE key; replace its non-key fields if
  // present, otherwise insert a fresh one. We keep `id` stable on replace so
  // any external references survive.
  const existing = db
    .prepare(
      `SELECT * FROM model_pricing
        WHERE model = ? AND tier = ? AND min_input_tokens = ?
          AND effective_from = ? AND currency = ?`,
    )
    .get(input.model, tier, minIn, input.effectiveFrom, currency) as
    | ModelPricingRow
    | undefined;

  if (existing) {
    db.prepare(
      `UPDATE model_pricing
          SET input_per_mtok = ?,
              cached_input_per_mtok = ?,
              cache_write_per_mtok = ?,
              output_per_mtok = ?,
              source = ?,
              notes = ?
        WHERE id = ?`,
    ).run(
      input.inputPerMtok,
      input.cachedInputPerMtok ?? null,
      input.cacheWritePerMtok ?? null,
      input.outputPerMtok,
      input.source ?? null,
      input.notes ?? null,
      existing.id,
    );
    return getPrice(existing.id)!;
  }

  db.prepare(
    `INSERT INTO model_pricing (
       id, model, tier, min_input_tokens, currency,
       input_per_mtok, cached_input_per_mtok, cache_write_per_mtok,
       output_per_mtok, effective_from, source, notes, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.model,
    tier,
    minIn,
    currency,
    input.inputPerMtok,
    input.cachedInputPerMtok ?? null,
    input.cacheWritePerMtok ?? null,
    input.outputPerMtok,
    input.effectiveFrom,
    input.source ?? null,
    input.notes ?? null,
    createdAt,
  );
  return getPrice(id)!;
}

export function getPrice(id: string): ModelPrice | undefined {
  const row = getDb().prepare('SELECT * FROM model_pricing WHERE id = ?').get(id) as
    | ModelPricingRow
    | undefined;
  return row ? rowToPrice(row) : undefined;
}

export function listPrices(filter: { model?: string } = {}): ModelPrice[] {
  const db = getDb();
  const rows = filter.model
    ? (db
        .prepare(
          `SELECT * FROM model_pricing WHERE model = ?
             ORDER BY effective_from DESC, min_input_tokens DESC`,
        )
        .all(filter.model) as ModelPricingRow[])
    : (db
        .prepare(
          `SELECT * FROM model_pricing
             ORDER BY model ASC, effective_from DESC, min_input_tokens DESC`,
        )
        .all() as ModelPricingRow[]);
  return rows.map(rowToPrice);
}

export function deletePrice(id: string): boolean {
  const info = getDb().prepare('DELETE FROM model_pricing WHERE id = ?').run(id);
  return info.changes > 0;
}

/** Resolve the price row that applies to a given LLM call.
 *
 *  Rules (in order):
 *    1. `model` matches exactly
 *    2. `effective_from` <= `occurredAt`
 *    3. `min_input_tokens` <= `inputTokens`
 *  Of the qualifying rows, pick the one with the latest `effective_from`
 *  and, tiebreaking, the highest `min_input_tokens` (so long-context wins
 *  over default when the call qualifies for both).
 *
 *  Returns undefined when no row matches — the call will be reported as
 *  `unpriced` in the cost rollup. */
export function getEffectivePrice(
  model: string,
  occurredAt: string,
  inputTokens: number,
  currency: string = 'USD',
): ModelPrice | undefined {
  const row = getDb()
    .prepare(
      `SELECT * FROM model_pricing
        WHERE model = ?
          AND currency = ?
          AND effective_from <= ?
          AND min_input_tokens <= ?
        ORDER BY effective_from DESC, min_input_tokens DESC
        LIMIT 1`,
    )
    .get(model, currency, occurredAt, inputTokens) as ModelPricingRow | undefined;
  return row ? rowToPrice(row) : undefined;
}
