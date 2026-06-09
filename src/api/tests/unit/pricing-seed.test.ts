import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../../src/stores/db.js';
import { resetStore, createTask } from '../../src/stores/task-store.js';
import * as turnStore from '../../src/stores/turn-store.js';
import * as costStore from '../../src/stores/cost-store.js';
import * as pricingStore from '../../src/stores/pricing-store.js';
import { seedDefaultPricing } from '../../src/stores/pricing-seed.js';
import { backfillUsageCalls } from '../../src/stores/usage-backfill.js';

beforeEach(() => {
  resetStore();
  const db = getDb();
  db.exec('DELETE FROM model_pricing; DELETE FROM turn_usage_call;');
});

describe('pricing-seed', () => {
  it('seeds the default GH Copilot price book and is idempotent', () => {
    const first = seedDefaultPricing();
    expect(first.inserted).toBeGreaterThan(20);

    // Spot-check a handful of well-known entries.
    const sonnet = pricingStore.getEffectivePrice(
      'claude-sonnet-4.6',
      '2026-06-09T00:00:00Z',
      1000,
    );
    expect(sonnet?.inputPerMtok).toBe(3.0);
    expect(sonnet?.outputPerMtok).toBe(15.0);
    expect(sonnet?.cacheWritePerMtok).toBe(3.75);

    const haiku = pricingStore.getEffectivePrice(
      'claude-haiku-4.5',
      '2026-06-09T00:00:00Z',
      1000,
    );
    expect(haiku?.inputPerMtok).toBe(1.0);

    // Internal variant resolves to the Opus 4.7 base price (we expanded the
    // SDK ids into individual rows in the seed).
    const opusHigh = pricingStore.getEffectivePrice(
      'claude-opus-4.7-high',
      '2026-06-09T00:00:00Z',
      1000,
    );
    expect(opusHigh?.inputPerMtok).toBe(5.0);
    expect(opusHigh?.outputPerMtok).toBe(25.0);

    // Re-running the seed must not duplicate rows or change behaviour.
    const second = seedDefaultPricing();
    expect(second.inserted).toBe(first.inserted);
    const allOpus = pricingStore.listPrices({ model: 'claude-opus-4.7' });
    expect(allOpus).toHaveLength(1);
  });

  it('picks the long-context tier when input tokens cross the threshold', () => {
    seedDefaultPricing();

    // gpt-5.5: default ≤ 272K, long_context > 272K
    const defaultTier = pricingStore.getEffectivePrice(
      'gpt-5.5',
      '2026-06-09T00:00:00Z',
      100_000,
    );
    expect(defaultTier?.inputPerMtok).toBe(5.0);
    expect(defaultTier?.tier).toBe('default');

    const longCtx = pricingStore.getEffectivePrice(
      'gpt-5.5',
      '2026-06-09T00:00:00Z',
      500_000,
    );
    expect(longCtx?.inputPerMtok).toBe(10.0);
    expect(longCtx?.tier).toBe('long_context');

    // gemini-3.1-pro-preview: default ≤ 200K, long > 200K
    const gemDef = pricingStore.getEffectivePrice(
      'gemini-3.1-pro-preview',
      '2026-06-09T00:00:00Z',
      100_000,
    );
    expect(gemDef?.inputPerMtok).toBe(2.0);

    const gemLong = pricingStore.getEffectivePrice(
      'gemini-3.1-pro-preview',
      '2026-06-09T00:00:00Z',
      300_000,
    );
    expect(gemLong?.inputPerMtok).toBe(4.0);
  });

  it('leaves unsupported model ids unpriced (e.g. gpt-4.1, auto)', () => {
    seedDefaultPricing();
    const gpt41 = pricingStore.getEffectivePrice('gpt-4.1', '2026-06-09T00:00:00Z', 1000);
    expect(gpt41).toBeUndefined();
    const auto = pricingStore.getEffectivePrice('auto', '2026-06-09T00:00:00Z', 1000);
    expect(auto).toBeUndefined();
  });
});

describe('usage-backfill', () => {
  it('synthesises one turn_usage_call per historical turn with tokens, idempotently', () => {
    const db = getDb();
    const task = createTask('backfill demo', 'd', 'owner/repo');

    // Create a historical turn with non-zero token aggregates and NO
    // per-call rows (simulates a turn from before turn_usage_call existed).
    db.prepare(
      `INSERT INTO turns (
         id, task_id, position, status, title, user_message, model,
         started_at, completed_at, duration_ms,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         nano_aiu, call_count
       ) VALUES (?, ?, 0, 'completed', 'old', 'hi', 'claude-sonnet-4.6',
                 '2026-05-01T00:00:00Z', '2026-05-01T00:00:30Z', 30000,
                 1_000_000, 500_000, 100_000, 200_000, NULL, 0)`,
    ).run('turn-1', task.id);

    // A second turn with zero tokens — must NOT be backfilled.
    db.prepare(
      `INSERT INTO turns (
         id, task_id, position, status, title, user_message, model,
         started_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, call_count
       ) VALUES (?, ?, 1, 'open', 'empty', 'hi', 'claude-sonnet-4.6',
                 '2026-05-02T00:00:00Z', 0, 0, 0, 0, 0)`,
    ).run('turn-2', task.id);

    // A turn with no model — must be skipped (no pricing key available).
    db.prepare(
      `INSERT INTO turns (
         id, task_id, position, status, title, user_message, model,
         started_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, call_count
       ) VALUES (?, ?, 2, 'completed', 'unknown', 'hi', NULL,
                 '2026-05-03T00:00:00Z', 1000, 1000, 0, 0, 0)`,
    ).run('turn-3', task.id);

    const r1 = backfillUsageCalls(db);
    expect(r1.synthesised).toBe(1);
    expect(r1.skipped).toBe(1);

    // Re-running is a no-op.
    const r2 = backfillUsageCalls(db);
    expect(r2.synthesised).toBe(0);

    // The synthesised row inherits all of the turn's totals at started_at.
    const synth = db
      .prepare(`SELECT * FROM turn_usage_call WHERE turn_id = ?`)
      .get('turn-1') as {
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      occurred_at: string;
      model: string;
    };
    expect(synth.input_tokens).toBe(1_000_000);
    expect(synth.output_tokens).toBe(500_000);
    expect(synth.cache_read_tokens).toBe(100_000);
    expect(synth.cache_write_tokens).toBe(200_000);
    expect(synth.occurred_at).toBe('2026-05-01T00:00:00Z');
    expect(synth.model).toBe('claude-sonnet-4.6');

    // End-to-end: after seed + backfill, the task has a non-zero cost.
    seedDefaultPricing();
    const cost = costStore.costForTask(task.id);
    // 1M input * $3 + 0.5M output * $15 + 0.1M cached * $0.3 + 0.2M cache-write * $3.75
    // = 3.00 + 7.50 + 0.03 + 0.75 = 11.28
    expect(cost.estimatedCost).toBeCloseTo(11.28, 2);
    expect(cost.pricedCalls).toBe(1);
    expect(cost.unpricedCalls).toBe(0);
  });

  it('does not double-count when fresh turn_usage_call rows already exist', () => {
    const db = getDb();
    const task = createTask('live demo', 'd', 'owner/repo');

    // Create a turn that's modern: it has both aggregate AND a real per-call row.
    db.prepare(
      `INSERT INTO turns (
         id, task_id, position, status, title, user_message, model,
         started_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, call_count
       ) VALUES (?, ?, 0, 'completed', 'live', 'hi', 'claude-sonnet-4.6',
                 '2026-06-08T00:00:00Z', 1_000_000, 500_000, 0, 0, 1)`,
    ).run('turn-live', task.id);

    // Record the per-call row via the live path.
    turnStore.recordUsage('turn-live', {
      model: 'claude-sonnet-4.6',
      occurredAt: '2026-06-08T00:00:00Z',
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    const beforeCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM turn_usage_call WHERE turn_id = ?`).get('turn-live') as {
        n: number;
      }
    ).n;
    expect(beforeCount).toBe(1);

    backfillUsageCalls(db);

    const afterCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM turn_usage_call WHERE turn_id = ?`).get('turn-live') as {
        n: number;
      }
    ).n;
    expect(afterCount).toBe(1);
  });
});
