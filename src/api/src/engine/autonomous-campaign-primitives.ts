import type {
  AutonomousCampaignActionDecision,
  AutonomousCampaignAttemptLimits,
  AutonomousCampaignAttemptUsage,
} from '../../../shared/types/autonomous-campaign-state.js';

export function nextRetryDelayMinutes(
  previousDelayMinutes: number,
  capMinutes: number,
): number {
  if (!Number.isFinite(previousDelayMinutes) || previousDelayMinutes < 0) {
    throw new RangeError('previousDelayMinutes must be a non-negative number');
  }
  if (!Number.isFinite(capMinutes) || capMinutes <= 0) {
    throw new RangeError('capMinutes must be a positive number');
  }

  return Math.min(Math.max(1, previousDelayMinutes * 2), capMinutes);
}

export function canScheduleCampaignAction(
  limits: AutonomousCampaignAttemptLimits,
  usage: AutonomousCampaignAttemptUsage,
): AutonomousCampaignActionDecision {
  if (usage.turnsUsed >= limits.maxTurns) {
    return { allowed: false, reason: 'turns' };
  }
  if (usage.elapsedMs >= limits.maxElapsedMs) {
    return { allowed: false, reason: 'time' };
  }
  if (usage.estimatedCostUsd >= limits.maxEstimatedCostUsd) {
    return { allowed: false, reason: 'cost' };
  }
  return { allowed: true };
}

export function isCampaignLeaseClaimable(
  leaseExpiresAtMs: number | undefined,
  nowMs: number,
): boolean {
  return leaseExpiresAtMs === undefined || leaseExpiresAtMs <= nowMs;
}
