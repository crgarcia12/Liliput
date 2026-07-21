import { describe, expect, it } from 'vitest';

interface AttemptLimits {
  maxTurns: number;
  maxElapsedMs: number;
  maxEstimatedCostUsd: number;
}

interface AttemptUsage {
  turnsUsed: number;
  elapsedMs: number;
  estimatedCostUsd: number;
}

interface CampaignPrimitivesModule {
  nextRetryDelayMinutes(
    previousDelayMinutes: number,
    capMinutes: number,
  ): number;
  canScheduleCampaignAction(
    limits: AttemptLimits,
    usage: AttemptUsage,
  ): { allowed: boolean; reason?: 'turns' | 'time' | 'cost' };
  isCampaignLeaseClaimable(
    leaseExpiresAtMs: number | undefined,
    nowMs: number,
  ): boolean;
}

const primitivesModulePath =
  '../../src/engine/autonomous-campaign-primitives.js';

async function loadPrimitives(): Promise<CampaignPrimitivesModule> {
  const loaded: unknown = await import(primitivesModulePath);
  return loaded as CampaignPrimitivesModule;
}

describe('autonomous campaign primitives', () => {
  it('should double retry delay when below the configured cap', async () => {
    const primitives = await loadPrimitives();

    expect(primitives.nextRetryDelayMinutes(5, 60)).toBe(10);
  });

  it('should cap retry delay when exponential backoff reaches the limit', async () => {
    const primitives = await loadPrimitives();

    expect(primitives.nextRetryDelayMinutes(60, 60)).toBe(60);
  });

  it('should allow another action when every attempt budget is below its limit', async () => {
    const primitives = await loadPrimitives();

    expect(
      primitives.canScheduleCampaignAction(
        {
          maxTurns: 500,
          maxElapsedMs: 240 * 60_000,
          maxEstimatedCostUsd: 250,
        },
        {
          turnsUsed: 499,
          elapsedMs: 240 * 60_000 - 1,
          estimatedCostUsd: 249.99,
        },
      ),
    ).toEqual({ allowed: true });
  });

  it('should block another action when the turn budget is reached', async () => {
    const primitives = await loadPrimitives();

    expect(
      primitives.canScheduleCampaignAction(
        {
          maxTurns: 500,
          maxElapsedMs: 240 * 60_000,
          maxEstimatedCostUsd: 250,
        },
        {
          turnsUsed: 500,
          elapsedMs: 1,
          estimatedCostUsd: 1,
        },
      ),
    ).toEqual({ allowed: false, reason: 'turns' });
  });

  it('should block another action when the wall-clock budget is reached', async () => {
    const primitives = await loadPrimitives();

    expect(
      primitives.canScheduleCampaignAction(
        {
          maxTurns: 500,
          maxElapsedMs: 240 * 60_000,
          maxEstimatedCostUsd: 250,
        },
        {
          turnsUsed: 1,
          elapsedMs: 240 * 60_000,
          estimatedCostUsd: 1,
        },
      ),
    ).toEqual({ allowed: false, reason: 'time' });
  });

  it('should block another action when the cost budget is reached', async () => {
    const primitives = await loadPrimitives();

    expect(
      primitives.canScheduleCampaignAction(
        {
          maxTurns: 500,
          maxElapsedMs: 240 * 60_000,
          maxEstimatedCostUsd: 250,
        },
        {
          turnsUsed: 1,
          elapsedMs: 1,
          estimatedCostUsd: 250,
        },
      ),
    ).toEqual({ allowed: false, reason: 'cost' });
  });

  it('should allow takeover only when a lease is absent or expired', async () => {
    const primitives = await loadPrimitives();

    expect(primitives.isCampaignLeaseClaimable(undefined, 10_000)).toBe(true);
    expect(primitives.isCampaignLeaseClaimable(9_999, 10_000)).toBe(true);
    expect(primitives.isCampaignLeaseClaimable(10_001, 10_000)).toBe(false);
  });
});
