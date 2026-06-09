/**
 * One-shot backfill of `turn_usage_call` from historical `turns` rows.
 *
 * The `turn_usage_call` table was added after Liliput had been running for
 * months — existing `turns` rows have running aggregates (input_tokens,
 * output_tokens, cache_read_tokens, cache_write_tokens) but no per-call
 * rows. Without per-call rows the cost calculator reports every historical
 * call as `unpriced` (because there's nothing for it to join against the
 * price book).
 *
 * Strategy: for every turn with a non-zero token total AND zero per-call
 * rows in turn_usage_call, synthesise ONE row that carries the full token
 * aggregate at the turn's `started_at` (when prices were in effect) using
 * the turn's recorded `model`. This loses per-call granularity for the
 * past but recovers the cost rollup completely.
 *
 * Idempotent: re-running finds zero turns to backfill (each is filtered
 * out by `NOT EXISTS (SELECT 1 FROM turn_usage_call ...)`).
 */

import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { logger } from '../logger.js';

interface TurnRow {
  id: string;
  task_id: string;
  model: string | null;
  started_at: string;
  duration_ms: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  nano_aiu: number | null;
}

export function backfillUsageCalls(db: Database.Database): { synthesised: number; skipped: number } {
  const rows = db
    .prepare(
      `SELECT t.id, t.task_id, t.model, t.started_at, t.duration_ms,
              t.input_tokens, t.output_tokens, t.cache_read_tokens, t.cache_write_tokens,
              t.nano_aiu
         FROM turns t
        WHERE (t.input_tokens > 0 OR t.output_tokens > 0
               OR t.cache_read_tokens > 0 OR t.cache_write_tokens > 0)
          AND NOT EXISTS (
            SELECT 1 FROM turn_usage_call c WHERE c.turn_id = t.id
          )`,
    )
    .all() as TurnRow[];

  if (rows.length === 0) return { synthesised: 0, skipped: 0 };

  const insert = db.prepare(
    `INSERT INTO turn_usage_call (
       id, turn_id, task_id, agent_id, model,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       nano_aiu, duration_ms, occurred_at
     ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let synthesised = 0;
  let skipped = 0;

  const txn = db.transaction((batch: TurnRow[]) => {
    for (const r of batch) {
      // Skip turns where we don't know the model — pricing can't be resolved
      // without it, so the synthetic row would still be `unpriced` AND we'd
      // be storing a bogus model='' row. Better to leave the turn out of
      // the cost rollup until someone backfills the model manually.
      if (!r.model || r.model === '') {
        skipped += 1;
        continue;
      }
      insert.run(
        uuid(),
        r.id,
        r.task_id,
        r.model,
        r.input_tokens,
        r.output_tokens,
        r.cache_read_tokens,
        r.cache_write_tokens,
        r.nano_aiu,
        r.duration_ms,
        r.started_at,
      );
      synthesised += 1;
    }
  });
  txn(rows);

  logger.info(
    { synthesised, skippedMissingModel: skipped, turns: rows.length },
    'Backfilled turn_usage_call rows from historical turns',
  );

  return { synthesised, skipped };
}
