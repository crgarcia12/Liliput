import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { Server } from 'socket.io';
import { createApp } from '../../src/app.js';
import { resetStore, createTask } from '../../src/stores/task-store.js';
import { getDb } from '../../src/stores/db.js';
import * as turnStore from '../../src/stores/turn-store.js';
import * as pricingStore from '../../src/stores/pricing-store.js';
import * as costStore from '../../src/stores/cost-store.js';

const io = new Server();
const app = createApp(io, { disableAuthMiddleware: true });

beforeEach(() => {
  resetStore();
  // resetStore() does not touch pricing or per-call usage tables. Wipe them
  // here so each test starts with an empty price book and no leftover calls.
  const db = getDb();
  db.exec('DELETE FROM model_pricing; DELETE FROM turn_usage_call;');
});

describe('pricing-store', () => {
  it('upsert is idempotent on the UNIQUE key', () => {
    const a = pricingStore.upsertPrice({
      model: 'gpt-5-mini',
      inputPerMtok: 0.25,
      outputPerMtok: 2.0,
      cachedInputPerMtok: 0.025,
      effectiveFrom: '2026-01-01',
    });
    const b = pricingStore.upsertPrice({
      model: 'gpt-5-mini',
      inputPerMtok: 0.3, // bumped
      outputPerMtok: 2.5,
      cachedInputPerMtok: 0.03,
      effectiveFrom: '2026-01-01',
    });
    expect(b.id).toBe(a.id);
    expect(b.inputPerMtok).toBe(0.3);
    const prices = pricingStore.listPrices({ model: 'gpt-5-mini' });
    expect(prices).toHaveLength(1);
  });

  it('getEffectivePrice picks the row with the latest effective_from <= occurredAt', () => {
    pricingStore.upsertPrice({
      model: 'claude-sonnet-4.5',
      inputPerMtok: 3.0,
      outputPerMtok: 15.0,
      effectiveFrom: '2026-01-01',
    });
    pricingStore.upsertPrice({
      model: 'claude-sonnet-4.5',
      inputPerMtok: 3.5,
      outputPerMtok: 18.0,
      effectiveFrom: '2026-06-01',
    });
    const old = pricingStore.getEffectivePrice('claude-sonnet-4.5', '2026-03-15T00:00:00Z', 1000);
    const newP = pricingStore.getEffectivePrice('claude-sonnet-4.5', '2026-07-15T00:00:00Z', 1000);
    expect(old?.inputPerMtok).toBe(3.0);
    expect(newP?.inputPerMtok).toBe(3.5);
  });

  it('tiered pricing: long_context wins when inputTokens exceeds the threshold', () => {
    pricingStore.upsertPrice({
      model: 'gpt-5.4',
      tier: 'default',
      minInputTokens: 0,
      inputPerMtok: 2.5,
      outputPerMtok: 15.0,
      cachedInputPerMtok: 0.25,
      effectiveFrom: '2026-01-01',
    });
    pricingStore.upsertPrice({
      model: 'gpt-5.4',
      tier: 'long_context',
      minInputTokens: 272_001,
      inputPerMtok: 5.0,
      outputPerMtok: 22.5,
      cachedInputPerMtok: 0.5,
      effectiveFrom: '2026-01-01',
    });
    const small = pricingStore.getEffectivePrice('gpt-5.4', '2026-03-01', 100_000);
    const big = pricingStore.getEffectivePrice('gpt-5.4', '2026-03-01', 300_000);
    expect(small?.tier).toBe('default');
    expect(small?.inputPerMtok).toBe(2.5);
    expect(big?.tier).toBe('long_context');
    expect(big?.inputPerMtok).toBe(5.0);
  });

  it('returns undefined when no row matches', () => {
    const p = pricingStore.getEffectivePrice('unknown-model', '2026-01-01', 0);
    expect(p).toBeUndefined();
  });
});

describe('cost-store', () => {
  it('rolls up cost per task using the per-call price effective at occurred_at', () => {
    pricingStore.upsertPrice({
      model: 'gpt-5-mini',
      inputPerMtok: 0.25,
      outputPerMtok: 2.0,
      cachedInputPerMtok: 0.025,
      effectiveFrom: '2020-01-01',
    });
    const t = createTask('A', 'd', 'crg/foo');
    const turn = turnStore.getCurrentTurn(t.id)!;
    turnStore.recordUsage(turn.id, {
      model: 'gpt-5-mini',
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 2_000_000,
    });
    const cost = costStore.costForTask(t.id);
    // 1.0 * 0.25 + 0.5 * 2.0 + 2.0 * 0.025 = 0.25 + 1.00 + 0.05 = 1.30
    expect(cost.estimatedCost).toBeCloseTo(1.3, 6);
    expect(cost.pricedCalls).toBe(1);
    expect(cost.unpricedCalls).toBe(0);
    expect(cost.perModel).toHaveLength(1);
    expect(cost.perModel[0]!.model).toBe('gpt-5-mini');
    expect(cost.perModel[0]!.hasUnpriced).toBe(false);
  });

  it('counts unpriced calls without aborting the rollup', () => {
    pricingStore.upsertPrice({
      model: 'gpt-5-mini',
      inputPerMtok: 0.25,
      outputPerMtok: 2.0,
      effectiveFrom: '2020-01-01',
    });
    const t = createTask('A', 'd', 'crg/foo');
    const turn = turnStore.getCurrentTurn(t.id)!;
    turnStore.recordUsage(turn.id, {
      model: 'gpt-5-mini',
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    turnStore.recordUsage(turn.id, {
      model: 'mystery-model', // no price entry
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    const cost = costStore.costForTask(t.id);
    expect(cost.pricedCalls).toBe(1);
    expect(cost.unpricedCalls).toBe(1);
    expect(cost.estimatedCost).toBeCloseTo(0.25, 6);
    const mystery = cost.perModel.find((m) => m.model === 'mystery-model');
    expect(mystery?.hasUnpriced).toBe(true);
    expect(mystery?.estimatedCost).toBe(0);
  });
});

describe('pricing + cost API', () => {
  it('POST /api/pricing upserts a row', async () => {
    const r = await request(app).post('/api/pricing').send({
      model: 'claude-haiku-4.5',
      inputPerMtok: 1.0,
      cachedInputPerMtok: 0.1,
      cacheWritePerMtok: 1.25,
      outputPerMtok: 5.0,
      effectiveFrom: '2026-06-09',
      source: 'github-copilot-2026-06-09',
    });
    expect(r.status).toBe(201);
    expect(r.body.model).toBe('claude-haiku-4.5');
    expect(r.body.cacheWritePerMtok).toBe(1.25);
  });

  it('GET /api/pricing lists rows; optional ?model filter', async () => {
    pricingStore.upsertPrice({
      model: 'gpt-5-mini',
      inputPerMtok: 0.25,
      outputPerMtok: 2.0,
      effectiveFrom: '2026-01-01',
    });
    pricingStore.upsertPrice({
      model: 'gpt-5.4',
      inputPerMtok: 2.5,
      outputPerMtok: 15.0,
      effectiveFrom: '2026-01-01',
    });
    const all = await request(app).get('/api/pricing');
    expect(all.status).toBe(200);
    expect(all.body.prices.length).toBe(2);
    const filtered = await request(app).get('/api/pricing?model=gpt-5-mini');
    expect(filtered.body.prices.length).toBe(1);
    expect(filtered.body.prices[0].model).toBe('gpt-5-mini');
  });

  it('DELETE /api/pricing/:id removes the row', async () => {
    const p = pricingStore.upsertPrice({
      model: 'gpt-5-mini',
      inputPerMtok: 0.25,
      outputPerMtok: 2.0,
      effectiveFrom: '2026-01-01',
    });
    const r = await request(app).delete(`/api/pricing/${p.id}`);
    expect(r.status).toBe(204);
    expect(pricingStore.listPrices()).toHaveLength(0);
  });

  it('GET /api/repos/:repo/cost rolls up cost across a repo', async () => {
    pricingStore.upsertPrice({
      model: 'gpt-5-mini',
      inputPerMtok: 0.25,
      outputPerMtok: 2.0,
      effectiveFrom: '2020-01-01',
    });
    const t = createTask('A', 'd', 'crg/foo');
    const turn = turnStore.getCurrentTurn(t.id)!;
    turnStore.recordUsage(turn.id, {
      model: 'gpt-5-mini',
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    const repo = encodeURIComponent('crg/foo');
    const r = await request(app).get(`/api/repos/${repo}/cost`);
    expect(r.status).toBe(200);
    expect(r.body.estimatedCost).toBeCloseTo(0.25, 6);
    expect(r.body.pricedCalls).toBe(1);
  });
});
