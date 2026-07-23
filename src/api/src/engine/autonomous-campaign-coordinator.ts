import type {
  AutonomousCampaign,
  AutonomousCampaignCycle,
  AutonomousCampaignDeliveryErrorCode,
  AutonomousCampaignDeliveryOutcome,
  AutonomousCampaignCoordinatorTickResult,
  AutonomousCampaignReasoningEffort,
  Task,
  Workstream,
} from '../../../shared/types/index.js';
import {
  AUTONOMOUS_CAMPAIGN_CYCLE_MISMATCH,
  AUTONOMOUS_CAMPAIGN_NOT_RUNNING,
  AUTONOMOUS_CAMPAIGN_PROPOSAL_REQUIRED,
  AUTONOMOUS_CAMPAIGN_TASK_NOT_FOUND,
} from '../../../shared/types/autonomous-campaign-delivery.js';
import type { AcceptedCampaignProposal } from '../../../shared/types/autonomous-campaign-proposal.js';
import type { PullRequest } from './github-pr.js';
import { logger } from '../logger.js';
import * as campaignStore from '../stores/autonomous-campaign-store.js';
import { getEffectivePrice } from '../stores/pricing-store.js';
import * as taskStore from '../stores/task-store.js';
import * as workstreamStore from '../stores/workstream-store.js';
import {
  createAutonomousCampaignAttemptManager,
  type AutonomousCampaignTaskInterruptReason,
} from './autonomous-campaign-attempt-manager.js';
import {
  cancelAutonomousCampaignProposal,
  prepareConfiguredCampaignProposal,
} from './autonomous-campaign-proposal.js';
import { getPodId } from './pod-identity.js';

const DEFAULT_COORDINATOR_INTERVAL_MS = 5_000;
const DEFAULT_COORDINATOR_INITIAL_DELAY_MS = 30_000;
const DEFAULT_COORDINATOR_LEASE_TTL_MS = 60_000;

function pendingUsageCostUsd(
  usage: campaignStore.AutonomousCampaignPendingUsage,
): number | undefined {
  const price = getEffectivePrice(
    usage.model,
    usage.occurredAt,
    usage.inputTokens,
  );
  if (!price) return undefined;
  return (
    (usage.inputTokens * price.inputPerMtok +
      usage.outputTokens * price.outputPerMtok +
      usage.cacheReadTokens * (price.cachedInputPerMtok ?? 0) +
      usage.cacheWriteTokens * (price.cacheWritePerMtok ?? 0)) /
    1_000_000
  );
}

export class AutonomousCampaignDeliveryError extends Error {
  constructor(
    readonly code: AutonomousCampaignDeliveryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AutonomousCampaignDeliveryError';
  }
}

export interface CampaignDeliveryCycle extends AutonomousCampaignCycle {
  imageRef?: string;
  previewNamespace?: string;
  previewUrl?: string;
  pullRequestNumber?: number;
}

export interface CampaignDeliveryHandoff {
  cycle: CampaignDeliveryCycle;
  workstream: Workstream;
  task: Task;
  replayed: boolean;
}

export interface CampaignDeliveryReconciliation {
  outcome: AutonomousCampaignDeliveryOutcome;
  cycle: CampaignDeliveryCycle;
  task: Task;
}

export interface CampaignCoordinatorHooks {
  afterWorkstreamCreated?: (workstream: Workstream) => void;
  afterTaskCreated?: (task: Task) => void;
}

export interface CampaignCoordinatorOptions {
  owner: string;
  leaseTtlMs: number;
  now: () => number;
  startTaskPipeline: (taskId: string) => void;
  resumeTaskPipeline?: (taskId: string) => void;
  interruptTask?: (
    taskId: string,
    reason: AutonomousCampaignTaskInterruptReason,
  ) => void;
  findPullRequest?: (
    repository: string,
    branch: string,
    baseBranch: string,
  ) => Promise<PullRequest | undefined>;
  prepareProposal?: (
    campaign: AutonomousCampaign,
    cycle: AutonomousCampaignCycle,
  ) => Promise<void>;
  cancelProposal?: (campaignId: string, cycleId: string) => void;
  hooks?: CampaignCoordinatorHooks;
}

export interface AutonomousCampaignCoordinator {
  handoffAcceptedProposal(
    campaignId: string,
    cycleId: string,
  ): Promise<CampaignDeliveryHandoff>;
  reconcileDelivery(
    campaignId: string,
    cycleId: string,
  ): Promise<CampaignDeliveryReconciliation>;
  renewLease(campaignId: string): Promise<{
    claimed: boolean;
    leaseOwner?: string;
    leaseExpiresAt?: number;
  }>;
  runOnce(): Promise<AutonomousCampaignCoordinatorTickResult>;
}

interface OwnedCampaignCycle {
  campaign: AutonomousCampaign;
  cycle: AutonomousCampaignCycle;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AutonomousCampaignDeliveryError(
      AUTONOMOUS_CAMPAIGN_PROPOSAL_REQUIRED,
      `${field} is required`,
    );
  }
  return value.trim();
}

function requiredStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AutonomousCampaignDeliveryError(
      AUTONOMOUS_CAMPAIGN_PROPOSAL_REQUIRED,
      `${field} must contain at least one value`,
    );
  }
  return value.map((item, index) =>
    requiredString(item, `${field}[${index}]`),
  );
}

function parseAcceptedProposal(
  cycle: AutonomousCampaignCycle,
): AcceptedCampaignProposal {
  const value: unknown = cycle.proposal;
  if (!isRecord(value) || !cycle.proposalFingerprint) {
    throw new AutonomousCampaignDeliveryError(
      AUTONOMOUS_CAMPAIGN_PROPOSAL_REQUIRED,
      `Cycle ${cycle.id} has no accepted proposal`,
    );
  }
  const size = value['size'];
  if (size !== 'small' && size !== 'medium') {
    throw new AutonomousCampaignDeliveryError(
      AUTONOMOUS_CAMPAIGN_PROPOSAL_REQUIRED,
      `Cycle ${cycle.id} has an invalid accepted proposal size`,
    );
  }
  const proposal = {
    candidateId: requiredString(value['candidateId'], 'proposal.candidateId'),
    title: requiredString(value['title'], 'proposal.title'),
    problem: requiredString(value['problem'], 'proposal.problem'),
    evidence: requiredStringArray(value['evidence'], 'proposal.evidence'),
    targetUsers: requiredStringArray(
      value['targetUsers'],
      'proposal.targetUsers',
    ),
    userValue: requiredString(value['userValue'], 'proposal.userValue'),
    scope: requiredStringArray(value['scope'], 'proposal.scope'),
    nonGoals: requiredStringArray(value['nonGoals'], 'proposal.nonGoals'),
    acceptanceCriteria: requiredStringArray(
      value['acceptanceCriteria'],
      'proposal.acceptanceCriteria',
    ),
    affectedComponents: requiredStringArray(
      value['affectedComponents'],
      'proposal.affectedComponents',
    ),
    likelyTests: requiredStringArray(
      value['likelyTests'],
      'proposal.likelyTests',
    ),
    risks: requiredStringArray(value['risks'], 'proposal.risks'),
    rollback: requiredString(value['rollback'], 'proposal.rollback'),
    size,
    fingerprint: requiredString(value['fingerprint'], 'proposal.fingerprint'),
    evidenceSnapshotId: requiredString(
      value['evidenceSnapshotId'],
      'proposal.evidenceSnapshotId',
    ),
    baseSha: requiredString(value['baseSha'], 'proposal.baseSha'),
  } satisfies AcceptedCampaignProposal;
  if (proposal.fingerprint !== cycle.proposalFingerprint) {
    throw new AutonomousCampaignDeliveryError(
      AUTONOMOUS_CAMPAIGN_PROPOSAL_REQUIRED,
      `Cycle ${cycle.id} proposal fingerprint does not match persisted state`,
    );
  }
  return proposal;
}

function proposalDescription(proposal: AcceptedCampaignProposal): string {
  return [
    proposal.problem,
    '',
    `Expected value: ${proposal.userValue}`,
    '',
    'Acceptance criteria:',
    ...proposal.acceptanceCriteria.map((criterion) => `- ${criterion}`),
  ].join('\n');
}

function markdownList(values: string[]): string {
  return values.map((value) => `- ${value}`).join('\n');
}

function proposalSpecification(proposal: AcceptedCampaignProposal): string {
  return [
    `# ${proposal.title}`,
    '',
    '## Problem',
    proposal.problem,
    '',
    '## Evidence',
    markdownList(proposal.evidence),
    '',
    '## Target users',
    markdownList(proposal.targetUsers),
    '',
    '## Expected value',
    proposal.userValue,
    '',
    '## Scope',
    markdownList(proposal.scope),
    '',
    '## Non-goals',
    markdownList(proposal.nonGoals),
    '',
    '## Acceptance criteria',
    markdownList(proposal.acceptanceCriteria),
    '',
    '## Affected components',
    markdownList(proposal.affectedComponents),
    '',
    '## Likely tests',
    markdownList(proposal.likelyTests),
    '',
    '## Risks',
    markdownList(proposal.risks),
    '',
    '## Rollback',
    proposal.rollback,
  ].join('\n');
}

function modelSelection(
  campaign: AutonomousCampaign,
  role: 'coding' | 'reviewer',
): {
  model?: string;
  reasoningEffort?: AutonomousCampaignReasoningEffort;
} {
  const selection = campaign.modelConfig[role];
  return selection
    ? {
        model: selection.model,
        reasoningEffort: selection.reasoningEffort,
      }
    : {};
}

function requireOwnedCampaignCycle(
  campaignId: string,
  cycleId: string,
  owner: string,
  nowMs: number,
): OwnedCampaignCycle {
  const campaign = campaignStore.getCampaign(campaignId);
  if (!campaign || campaign.status !== 'running') {
    throw new AutonomousCampaignDeliveryError(
      AUTONOMOUS_CAMPAIGN_NOT_RUNNING,
      `Campaign ${campaignId} is not running`,
    );
  }
  if (
    campaign.leaseOwner !== owner ||
    campaign.leaseExpiresAt === undefined ||
    campaign.leaseExpiresAt <= nowMs
  ) {
    throw new campaignStore.AutonomousCampaignConflictError(
      `Campaign ${campaignId} is not leased by ${owner}`,
    );
  }
  const cycle = campaignStore.getCycle(cycleId);
  if (
    !cycle ||
    cycle.campaignId !== campaignId ||
    campaign.currentCycleId !== cycleId
  ) {
    throw new AutonomousCampaignDeliveryError(
      AUTONOMOUS_CAMPAIGN_CYCLE_MISMATCH,
      `Cycle ${cycleId} is not current for campaign ${campaignId}`,
    );
  }
  return { campaign, cycle };
}

function recoverTask(cycle: AutonomousCampaignCycle): Task | undefined {
  if (cycle.taskId) {
    const byId = taskStore.getTask(cycle.taskId);
    if (byId) return byId;
  }
  return taskStore.getTaskByCampaignCycleId(cycle.id);
}

function recoverWorkstream(
  cycle: AutonomousCampaignCycle,
): Workstream | undefined {
  if (cycle.workstreamId) {
    const byId = workstreamStore.getWorkstream(cycle.workstreamId);
    if (byId) return byId;
  }
  return workstreamStore.getWorkstreamByCampaignCycleId(cycle.id);
}

export function createAutonomousCampaignCoordinator(
  options: CampaignCoordinatorOptions,
): AutonomousCampaignCoordinator {
  if (!options.owner.trim()) {
    throw new Error('Campaign coordinator owner is required');
  }
  if (!Number.isFinite(options.leaseTtlMs) || options.leaseTtlMs <= 0) {
    throw new RangeError('Campaign coordinator leaseTtlMs must be positive');
  }
  let lastProcessedCampaignId: string | undefined;
  const proposalPreparations = new Map<string, Promise<void>>();
  const attemptManager = createAutonomousCampaignAttemptManager({
    owner: options.owner,
    now: options.now,
    interruptTask: options.interruptTask ?? (() => undefined),
  });
  const prepareProposal =
    options.prepareProposal ??
    (async (
      campaign: AutonomousCampaign,
      cycle: AutonomousCampaignCycle,
    ): Promise<void> => {
      await prepareConfiguredCampaignProposal({
        campaignId: campaign.id,
        cycleId: cycle.id,
        modelConfig: campaign.modelConfig,
      });
    });
  const cancelProposal =
    options.cancelProposal ?? cancelAutonomousCampaignProposal;

  const handoffAcceptedProposal = async (
    campaignId: string,
    cycleId: string,
  ): Promise<CampaignDeliveryHandoff> => {
    const nowMs = options.now();
    let { campaign, cycle } = requireOwnedCampaignCycle(
      campaignId,
      cycleId,
      options.owner,
      nowMs,
    );
    if (cycle.status !== 'proposing' && cycle.status !== 'delivering') {
      throw new AutonomousCampaignDeliveryError(
        AUTONOMOUS_CAMPAIGN_CYCLE_MISMATCH,
        `Cycle ${cycleId} cannot be handed off from ${cycle.status}`,
      );
    }
    const proposal = parseAcceptedProposal(cycle);

    let workstream = recoverWorkstream(cycle);
    let workstreamCreated = false;
    if (!workstream) {
      const result = workstreamStore.ensureCampaignWorkstream({
        campaignCycleId: cycle.id,
        repository: campaign.repository,
        name: proposal.title,
        description: proposal.problem,
      });
      workstream = result.workstream;
      workstreamCreated = result.created;
    }
    if (cycle.workstreamId !== workstream.id) {
      cycle = campaignStore.updateCycleDelivery({
        campaignId,
        cycleId,
        leaseOwner: options.owner,
        nowMs,
        workstreamId: workstream.id,
      });
    }
    if (workstreamCreated) {
      options.hooks?.afterWorkstreamCreated?.(workstream);
    }

    let task = recoverTask(cycle);
    let taskCreated = false;
    if (!task) {
      const coding = modelSelection(campaign, 'coding');
      const reviewer = modelSelection(campaign, 'reviewer');
      task = taskStore.createTask(
        proposal.title,
        proposalDescription(proposal),
        campaign.repository,
        {
          baseBranch: campaign.baseBranch,
          commitMode: 'pr',
          workstreamId: workstream.id,
          campaignCycleId: cycle.id,
          ...(coding.model ? { model: coding.model } : {}),
          ...(coding.reasoningEffort
            ? { reasoningEffort: coding.reasoningEffort }
            : {}),
          ...(reviewer.model ? { reviewerModel: reviewer.model } : {}),
          ...(reviewer.reasoningEffort
            ? { reviewerReasoningEffort: reviewer.reasoningEffort }
            : {}),
          reviewerEnabled: Boolean(reviewer.model),
        },
      );
      taskCreated = true;
    }
    if (taskCreated) {
      options.hooks?.afterTaskCreated?.(task);
    }
    if (
      cycle.taskId !== task.id ||
      cycle.workstreamId !== workstream.id ||
      cycle.status !== 'delivering'
    ) {
      cycle = campaignStore.updateCycleDelivery({
        campaignId,
        cycleId,
        leaseOwner: options.owner,
        nowMs,
        status: 'delivering',
        workstreamId: workstream.id,
        taskId: task.id,
      });
    }
    if (!campaignStore.getLatestAttempt(cycle.id)) {
      campaignStore.createAttempt({
        cycleId: cycle.id,
        attemptNumber: 1,
        status: 'running',
        idempotencyKey: `${cycle.id}-attempt-1`,
        leaseOwner: options.owner,
        nowMs,
      });
    }

    let pipelineStarted = false;
    if (task.status === 'clarifying' || task.status === 'specifying') {
      const prepared = taskStore.updateTask(task.id, {
        spec: proposalSpecification(proposal),
        status: 'building',
      });
      if (!prepared) {
        throw new AutonomousCampaignDeliveryError(
          AUTONOMOUS_CAMPAIGN_TASK_NOT_FOUND,
          `Campaign task ${task.id} disappeared before pipeline start`,
        );
      }
      task = prepared;
      pipelineStarted = true;
      options.startTaskPipeline(task.id);
    }

    campaign = campaignStore.getCampaign(campaignId) ?? campaign;
    cycle = campaignStore.getCycle(cycleId) ?? cycle;
    logger.info(
      {
        campaignId,
        cycleId,
        workstreamId: workstream.id,
        taskId: task.id,
        pipelineStarted,
      },
      'autonomous-campaign: delivery handoff ready',
    );
    return {
      cycle,
      workstream,
      task,
      replayed: !workstreamCreated && !taskCreated,
    };
  };

  const reconcileDelivery = async (
    campaignId: string,
    cycleId: string,
  ): Promise<CampaignDeliveryReconciliation> => {
    const nowMs = options.now();
    const { cycle } = requireOwnedCampaignCycle(
      campaignId,
      cycleId,
      options.owner,
      nowMs,
    );
    let task = recoverTask(cycle);
    if (!task) {
      throw new AutonomousCampaignDeliveryError(
        AUTONOMOUS_CAMPAIGN_TASK_NOT_FOUND,
        `No campaign task exists for cycle ${cycleId}`,
      );
    }
    if (
      options.findPullRequest &&
      task.repository &&
      task.branch &&
      !task.pullRequestUrl &&
      (task.status === 'review' ||
        task.status === 'completed' ||
        task.status === 'failed')
    ) {
      const pullRequest = await options.findPullRequest(
        task.repository,
        task.branch,
        task.baseBranch ?? 'main',
      );
      if (pullRequest) {
        task =
          taskStore.updateTask(task.id, {
            pullRequestUrl: pullRequest.htmlUrl,
            pullRequestNumber: pullRequest.number,
          }) ?? task;
      }
    }
    task = taskStore.getTask(task.id) ?? task;
    const workstream = recoverWorkstream(cycle);
    let outcome: AutonomousCampaignDeliveryOutcome = 'active';
    let status: AutonomousCampaignCycle['status'] = 'delivering';
    let lastError: string | undefined;
    if (task.status === 'review') {
      outcome = 'ready-to-release';
      status = 'ready_to_release';
    } else if (task.status === 'completed') {
      outcome = 'awaiting-merge-confirmation';
      status = 'ready_to_release';
    } else if (
      task.status === 'failed' ||
      task.status === 'discarded' ||
      task.status === 'deleting'
    ) {
      outcome = 'failed';
      lastError =
        task.errorMessage ??
        `Campaign task entered non-success status ${task.status}`;
    }
    const updated = campaignStore.updateCycleDelivery({
      campaignId,
      cycleId,
      leaseOwner: options.owner,
      nowMs: options.now(),
      expectedStatus: cycle.status,
      status,
      ...(workstream ? { workstreamId: workstream.id } : {}),
      taskId: task.id,
      ...(task.branch ? { branchName: task.branch } : {}),
      ...(task.imageRef ? { imageRef: task.imageRef } : {}),
      ...(task.devNamespace ? { previewNamespace: task.devNamespace } : {}),
      ...(task.devUrl ? { previewUrl: task.devUrl } : {}),
      ...(task.pullRequestUrl
        ? { pullRequestUrl: task.pullRequestUrl }
        : {}),
      ...(task.pullRequestNumber !== undefined
        ? { pullRequestNumber: task.pullRequestNumber }
        : {}),
      ...(lastError ? { lastError } : {}),
    });
    return { outcome, cycle: updated, task };
  };

  const renewLease = async (
    campaignId: string,
  ): Promise<{
    claimed: boolean;
    leaseOwner?: string;
    leaseExpiresAt?: number;
  }> => {
    const result = campaignStore.claimCampaignLease({
      campaignId,
      owner: options.owner,
      nowMs: options.now(),
      ttlMs: options.leaseTtlMs,
    });
    return {
      claimed: result.claimed,
      leaseOwner: result.campaign.leaseOwner,
      leaseExpiresAt: result.campaign.leaseExpiresAt,
    };
  };

  const prepareProposalWithLease = async (
    campaign: AutonomousCampaign,
    cycle: AutonomousCampaignCycle,
  ): Promise<void> => {
    const heartbeatIntervalMs = Math.max(
      10,
      Math.floor(options.leaseTtlMs / 3),
    );
    let heartbeatFailure: unknown;
    let heartbeatPromise: Promise<void> | undefined;
    const heartbeat = (): void => {
      if (heartbeatPromise || heartbeatFailure) return;
      heartbeatPromise = renewLease(campaign.id)
        .then((lease) => {
          if (!lease.claimed) {
            throw new campaignStore.AutonomousCampaignConflictError(
              `Campaign ${campaign.id} lost its coordinator lease while preparing cycle ${cycle.id}`,
            );
          }
        })
        .catch((error: unknown) => {
          heartbeatFailure = error;
          cancelProposal(campaign.id, cycle.id);
        })
        .finally(() => {
          heartbeatPromise = undefined;
        });
    };
    const timer = setInterval(heartbeat, heartbeatIntervalMs);
    timer.unref();
    try {
      await prepareProposal(campaign, cycle);
      if (heartbeatPromise) {
        await heartbeatPromise;
      }
      if (heartbeatFailure) {
        throw heartbeatFailure;
      }
      const lease = await renewLease(campaign.id);
      if (!lease.claimed) {
        cancelProposal(campaign.id, cycle.id);
        throw new campaignStore.AutonomousCampaignConflictError(
          `Campaign ${campaign.id} lost its coordinator lease while preparing cycle ${cycle.id}`,
        );
      }
    } finally {
      clearInterval(timer);
    }
  };

  const proposalPreparationKey = (
    campaignId: string,
    cycleId: string,
  ): string => `${campaignId}:${cycleId}`;

  const startProposalPreparation = (
    campaign: AutonomousCampaign,
    cycle: AutonomousCampaignCycle,
  ): boolean => {
    const key = proposalPreparationKey(campaign.id, cycle.id);
    if (proposalPreparations.has(key)) return false;
    const preparation = prepareProposalWithLease(campaign, cycle)
      .catch((error: unknown) => {
        const details = {
          campaignId: campaign.id,
          cycleId: cycle.id,
          err: error instanceof Error ? error.message : String(error),
        };
        if (
          error instanceof Error &&
          error.name === 'AutonomousCampaignProposalCancelledError'
        ) {
          logger.info(
            details,
            'autonomous-campaign: proposal preparation cancelled',
          );
          return;
        }
        logger.warn(
          details,
          'autonomous-campaign: proposal preparation failed',
        );
      })
      .finally(() => {
        proposalPreparations.delete(key);
      });
    proposalPreparations.set(key, preparation);
    return true;
  };

  const runOnce = async (): Promise<AutonomousCampaignCoordinatorTickResult> => {
    const candidates = campaignStore.listRunningCampaigns();
    const heartbeatNow = options.now();
    for (const campaign of candidates) {
      if (campaign.leaseOwner === options.owner) {
        campaignStore.claimCampaignLease({
          campaignId: campaign.id,
          owner: options.owner,
          nowMs: heartbeatNow,
          ttlMs: options.leaseTtlMs,
        });
      }
    }
    const previousIndex = lastProcessedCampaignId
      ? candidates.findIndex((campaign) => campaign.id === lastProcessedCampaignId)
      : -1;
    const orderedCandidates =
      previousIndex >= 0
        ? [
            ...candidates.slice(previousIndex + 1),
            ...candidates.slice(0, previousIndex + 1),
          ]
        : candidates;
    for (const candidate of orderedCandidates) {
      const pendingCycle = campaignStore.getCurrentCycle(candidate.id);
      if (pendingCycle?.status === 'waiting_for_external') {
        const waitingCycle = pendingCycle;
        const pendingAttempt = campaignStore.getLatestAttempt(waitingCycle.id);
        const pendingUsage = pendingAttempt
          ? campaignStore.listPendingAttemptUsage(pendingAttempt.id)
          : [];
        const pendingCosts = pendingUsage.map(pendingUsageCostUsd);
        if (pendingCosts.some((cost) => cost === undefined)) continue;
        const pricingMatch = waitingCycle.lastError?.match(
          /^model-pricing-missing:(.+)$/,
        );
        if (
          pricingMatch &&
          !getEffectivePrice(
            pricingMatch[1] ?? '',
            new Date(options.now()).toISOString(),
            0,
          )
        ) {
          continue;
        }
        const externalRetryAt = Number(
          waitingCycle.lastError?.match(
            /^(?:transient-image-build|kubernetes-cluster-unavailable)-until=(\d+):/,
          )?.[1] ?? 0,
        );
        if (externalRetryAt > options.now()) continue;
        const lease = await renewLease(candidate.id);
        if (!lease.claimed) continue;
        if (pendingAttempt) {
          pendingUsage.forEach((usage, index) => {
            attemptManager.recordUsage(candidate.id, waitingCycle.id, {
              usageEventId: usage.usageEventId,
              turns: 0,
              estimatedCostUsd: pendingCosts[index] ?? 0,
            });
            campaignStore.deletePendingAttemptUsage(
              pendingAttempt.id,
              usage.usageEventId,
            );
          });
        }
        const resumed = attemptManager.resumeExternalWait(
          candidate.id,
          waitingCycle.id,
        );
        const task = recoverTask(resumed.cycle);
        if (!task) {
          throw new AutonomousCampaignDeliveryError(
            AUTONOMOUS_CAMPAIGN_TASK_NOT_FOUND,
            `No campaign task exists for external-wait cycle ${resumed.cycle.id}`,
          );
        }
        taskStore.updateTask(task.id, {
          status: 'building',
          errorMessage: undefined,
        });
        if (task.branch && options.resumeTaskPipeline) {
          options.resumeTaskPipeline(task.id);
        } else {
          options.startTaskPipeline(task.id);
        }
        lastProcessedCampaignId = candidate.id;
        return {
          outcome: 'handed-off',
          campaignId: candidate.id,
          cycleId: resumed.cycle.id,
          taskId: task.id,
        };
      }
      if (
        pendingCycle?.status === 'proposing' &&
        (!pendingCycle.proposal || !pendingCycle.proposalFingerprint)
      ) {
        if (
          proposalPreparations.has(
            proposalPreparationKey(candidate.id, pendingCycle.id),
          )
        ) {
          continue;
        }
        const lease = await renewLease(candidate.id);
        if (!lease.claimed) continue;
        logger.info(
          { campaignId: candidate.id, cycleId: pendingCycle.id },
          'autonomous-campaign: preparing proposal',
        );
        startProposalPreparation(candidate, pendingCycle);
        lastProcessedCampaignId = candidate.id;
        return {
          outcome: 'idle',
          campaignId: candidate.id,
          cycleId: pendingCycle.id,
        };
      }
      if (
        !pendingCycle ||
        !pendingCycle.proposal ||
        !pendingCycle.proposalFingerprint ||
        pendingCycle.status === 'succeeded' ||
        pendingCycle.status === 'stopped' ||
        pendingCycle.status === 'paused' ||
        pendingCycle.status === 'cooldown' ||
        pendingCycle.status === 'releasing'
      ) {
        continue;
      }
      if (pendingCycle.status === 'retry_wait') {
        const lease = await renewLease(candidate.id);
        if (!lease.claimed) continue;
        const retry = attemptManager.startDueRetry(
          candidate.id,
          pendingCycle.id,
        );
        if (!retry.started) continue;
        const task = recoverTask(retry.cycle);
        if (!task) {
          throw new AutonomousCampaignDeliveryError(
            AUTONOMOUS_CAMPAIGN_TASK_NOT_FOUND,
            `No campaign task exists for retry cycle ${retry.cycle.id}`,
          );
        }
        taskStore.updateTask(task.id, {
          status: 'building',
          errorMessage: undefined,
        });
        if (task.branch && options.resumeTaskPipeline) {
          options.resumeTaskPipeline(task.id);
        } else {
          options.startTaskPipeline(task.id);
        }
        lastProcessedCampaignId = candidate.id;
        return {
          outcome: 'handed-off',
          campaignId: candidate.id,
          cycleId: retry.cycle.id,
          taskId: task.id,
        };
      }
      const lease = await renewLease(candidate.id);
      if (!lease.claimed) continue;
      const cycle = campaignStore.getCurrentCycle(candidate.id);
      if (
        !cycle ||
        !cycle.proposal ||
        !cycle.proposalFingerprint ||
        cycle.status === 'succeeded' ||
        cycle.status === 'stopped' ||
        cycle.status === 'paused' ||
        cycle.status === 'cooldown' ||
        cycle.status === 'waiting_for_external' ||
        cycle.status === 'releasing'
      ) {
        continue;
      }
      if (
        cycle.status === 'delivering' &&
        !campaignStore.getLatestAttempt(cycle.id)
      ) {
        campaignStore.createAttempt({
          cycleId: cycle.id,
          attemptNumber: 1,
          status: 'running',
          idempotencyKey: `${cycle.id}-attempt-1`,
          leaseOwner: options.owner,
          nowMs: options.now(),
        });
      }
      lastProcessedCampaignId = candidate.id;
      const linkedTask = recoverTask(cycle);
      if (
        (cycle.status === 'proposing' || cycle.status === 'delivering') &&
        (!linkedTask ||
          linkedTask.status === 'clarifying' ||
          linkedTask.status === 'specifying')
      ) {
        const handoff = await handoffAcceptedProposal(candidate.id, cycle.id);
        return {
          outcome: 'handed-off',
          campaignId: candidate.id,
          cycleId: cycle.id,
          taskId: handoff.task.id,
        };
      }
      const reconciled = await reconcileDelivery(candidate.id, cycle.id);
      if (
        reconciled.outcome === 'failed' &&
        reconciled.cycle.status === 'delivering'
      ) {
        attemptManager.failAttempt(candidate.id, cycle.id, {
          stage: 'agent-turn',
          message:
            reconciled.cycle.lastError ??
            reconciled.task.errorMessage ??
            'Campaign task failed',
        });
      }
      return {
        outcome: reconciled.outcome,
        campaignId: candidate.id,
        cycleId: cycle.id,
        taskId: reconciled.task.id,
      };
    }
    return { outcome: 'idle' };
  };

  return {
    handoffAcceptedProposal,
    reconcileDelivery,
    renewLease,
    runOnce,
  };
}

export interface StartAutonomousCampaignCoordinatorOptions {
  startTaskPipeline: (taskId: string) => void;
  resumeTaskPipeline?: (taskId: string) => void;
  interruptTask?: CampaignCoordinatorOptions['interruptTask'];
  findPullRequest?: CampaignCoordinatorOptions['findPullRequest'];
  owner?: string;
  intervalMs?: number;
  initialDelayMs?: number;
  leaseTtlMs?: number;
}

let coordinatorTimer: NodeJS.Timeout | undefined;
let coordinatorStarted = false;

export function startAutonomousCampaignCoordinator(
  options: StartAutonomousCampaignCoordinatorOptions,
): () => void {
  if (coordinatorStarted) return stopAutonomousCampaignCoordinator;
  const intervalMs =
    options.intervalMs ?? DEFAULT_COORDINATOR_INTERVAL_MS;
  const initialDelayMs =
    options.initialDelayMs ?? DEFAULT_COORDINATOR_INITIAL_DELAY_MS;
  const leaseTtlMs =
    options.leaseTtlMs ?? DEFAULT_COORDINATOR_LEASE_TTL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError('Campaign coordinator intervalMs must be positive');
  }
  if (!Number.isFinite(initialDelayMs) || initialDelayMs < 0) {
    throw new RangeError(
      'Campaign coordinator initialDelayMs must be non-negative',
    );
  }
  const coordinator = createAutonomousCampaignCoordinator({
    owner: options.owner ?? getPodId(),
    leaseTtlMs,
    now: Date.now,
    startTaskPipeline: options.startTaskPipeline,
    ...(options.resumeTaskPipeline
      ? { resumeTaskPipeline: options.resumeTaskPipeline }
      : {}),
    ...(options.interruptTask
      ? { interruptTask: options.interruptTask }
      : {}),
    ...(options.findPullRequest
      ? { findPullRequest: options.findPullRequest }
      : {}),
  });
  coordinatorStarted = true;
  const schedule = (delayMs: number): void => {
    coordinatorTimer = setTimeout(() => {
      coordinatorTimer = undefined;
      void coordinator
        .runOnce()
        .catch((error: unknown) => {
          logger.warn(
            {
              err: error instanceof Error ? error.message : String(error),
            },
            'autonomous-campaign: coordinator tick failed',
          );
        })
        .finally(() => {
          if (coordinatorStarted) schedule(intervalMs);
        });
    }, delayMs);
    coordinatorTimer.unref();
  };
  logger.info(
    {
      owner: options.owner ?? getPodId(),
      intervalMs,
      initialDelayMs,
      leaseTtlMs,
    },
    'autonomous-campaign: coordinator starting',
  );
  schedule(initialDelayMs);
  return stopAutonomousCampaignCoordinator;
}

export function stopAutonomousCampaignCoordinator(): void {
  coordinatorStarted = false;
  if (coordinatorTimer) {
    clearTimeout(coordinatorTimer);
    coordinatorTimer = undefined;
  }
}
