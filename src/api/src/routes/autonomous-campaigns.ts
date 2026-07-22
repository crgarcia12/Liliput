import { Router, type Request, type Response } from 'express';
import type { Server as SocketServer } from 'socket.io';
import type {
  AutonomousCampaignIdeaSource,
  AutonomousCampaignModelConfig,
  AutonomousCampaignReasoningEffort,
  CreateAutonomousCampaignInput,
} from '../../../shared/types/autonomous-campaign-state.js';
import type {
  AutonomousCampaignApiError,
  AutonomousCampaignDetailResponse,
  AutonomousCampaignEvent,
  AutonomousCampaignEventAction,
  VerifyCampaignRepositoryBranchResult,
} from '../../../shared/types/autonomous-campaign-controls.js';
import {
  AutonomousCampaignControlError,
  getCampaignDetail,
  pauseCampaign,
  resumeCampaign,
  startCampaign,
  stopCampaign,
} from '../engine/autonomous-campaign-control.js';
import {
  AutonomousCampaignPricingError,
  createPricedCampaign,
} from '../engine/autonomous-campaign-pricing.js';
import { verifyRepositoryBranchAccess } from '../engine/github-pr.js';
import { logger } from '../logger.js';
import { requireAdmin, type AuthRequest } from '../middleware/auth-middleware.js';
import {
  AutonomousCampaignConflictError,
  AutonomousCampaignStoreError,
  listCampaigns,
} from '../stores/autonomous-campaign-store.js';

const IDEA_SOURCES = new Set<AutonomousCampaignIdeaSource>([
  'specs',
  'code',
  'issues',
  'telemetry',
  'ideation',
]);
const REASONING_EFFORTS = new Set<AutonomousCampaignReasoningEffort>([
  'low',
  'medium',
  'high',
  'xhigh',
]);

export interface AutonomousCampaignsRouterDeps {
  verifyRepositoryBranch?: (
    repository: string,
    branch: string,
  ) => Promise<VerifyCampaignRepositoryBranchResult>;
  now?: () => string;
}

class CampaignRequestValidationError extends Error {
  readonly code = 'CAMPAIGN_VALIDATION_FAILED';

  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
    this.name = 'CampaignRequestValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  field: string,
  pattern?: RegExp,
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CampaignRequestValidationError(`${field} is required.`, field);
  }
  const normalized = value.trim();
  if (pattern && !pattern.test(normalized)) {
    throw new CampaignRequestValidationError(`${field} is invalid.`, field);
  }
  return normalized;
}

function positiveNumber(
  body: Record<string, unknown>,
  field: string,
  integer: boolean,
): number | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    (integer && !Number.isInteger(value))
  ) {
    throw new CampaignRequestValidationError(
      `${field} must be a positive ${integer ? 'integer' : 'number'}.`,
      field,
    );
  }
  return value;
}

function parseIdeaSources(
  value: unknown,
): AutonomousCampaignIdeaSource[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new CampaignRequestValidationError(
      'ideaSources must contain at least one source.',
      'ideaSources',
    );
  }
  const sources = value.map((source) => {
    if (typeof source !== 'string' || !IDEA_SOURCES.has(source as AutonomousCampaignIdeaSource)) {
      throw new CampaignRequestValidationError(
        'ideaSources contains an unsupported source.',
        'ideaSources',
      );
    }
    return source as AutonomousCampaignIdeaSource;
  });
  return Array.from(new Set(sources));
}

function parseModelConfig(value: unknown): AutonomousCampaignModelConfig {
  if (!isRecord(value)) {
    throw new CampaignRequestValidationError(
      'modelConfig is required.',
      'modelConfig',
    );
  }

  const config: AutonomousCampaignModelConfig = {};
  for (const role of ['metaAgent', 'coding', 'reviewer'] as const) {
    const selection = value[role];
    if (selection === undefined) continue;
    if (!isRecord(selection)) {
      throw new CampaignRequestValidationError(
        `${role} model selection is invalid.`,
        `modelConfig.${role}`,
      );
    }
    const model = requiredString(
      selection['model'],
      `modelConfig.${role}.model`,
      /^[A-Za-z0-9][A-Za-z0-9._-]+$/,
    );
    const effort = selection['reasoningEffort'];
    if (
      effort !== undefined &&
      (typeof effort !== 'string' ||
        !REASONING_EFFORTS.has(effort as AutonomousCampaignReasoningEffort))
    ) {
      throw new CampaignRequestValidationError(
        `${role} reasoning effort is invalid.`,
        `modelConfig.${role}.reasoningEffort`,
      );
    }
    config[role] = {
      model,
      ...(effort
        ? { reasoningEffort: effort as AutonomousCampaignReasoningEffort }
        : {}),
    };
  }

  if (!config.metaAgent && !config.coding && !config.reviewer) {
    throw new CampaignRequestValidationError(
      'At least one campaign model must be selected.',
      'modelConfig',
    );
  }
  return config;
}

function parseCreateInput(
  body: unknown,
  createdBy: string,
): CreateAutonomousCampaignInput {
  if (!isRecord(body)) {
    throw new CampaignRequestValidationError(
      'Campaign request body is required.',
      'body',
    );
  }
  const repository = requiredString(
    body['repository'],
    'repository',
    /^[^/\s]+\/[^/\s]+$/,
  );
  const baseBranch = requiredString(
    body['baseBranch'],
    'baseBranch',
    /^(?!.*(?:\.\.|@\{|[\s~^:?*\[\\]))(?!\/)(?!.*\/$).+$/,
  );
  const releasePolicy = body['releasePolicy'];
  if (
    releasePolicy !== undefined &&
    releasePolicy !== 'auto-merge-after-gates'
  ) {
    throw new CampaignRequestValidationError(
      'releasePolicy is invalid.',
      'releasePolicy',
    );
  }
  const ideaSources = parseIdeaSources(body['ideaSources']);
  const maxTurnsPerAttempt = positiveNumber(
    body,
    'maxTurnsPerAttempt',
    true,
  );
  const maxMinutesPerAttempt = positiveNumber(
    body,
    'maxMinutesPerAttempt',
    true,
  );
  const maxCostUsdPerAttempt = positiveNumber(
    body,
    'maxCostUsdPerAttempt',
    false,
  );

  return {
    repository,
    baseBranch,
    ...(releasePolicy ? { releasePolicy } : {}),
    ...(ideaSources ? { ideaSources } : {}),
    modelConfig: parseModelConfig(body['modelConfig']),
    ...(maxTurnsPerAttempt !== undefined ? { maxTurnsPerAttempt } : {}),
    ...(maxMinutesPerAttempt !== undefined ? { maxMinutesPerAttempt } : {}),
    ...(maxCostUsdPerAttempt !== undefined ? { maxCostUsdPerAttempt } : {}),
    createdBy,
  };
}

function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function apiError(
  res: Response,
  status: number,
  error: AutonomousCampaignApiError,
): void {
  res.status(status).json(error);
}

function emitUpdate(
  io: SocketServer,
  action: AutonomousCampaignEventAction,
  detail: AutonomousCampaignDetailResponse,
  occurredAt: string,
): void {
  const event: AutonomousCampaignEvent = {
    action,
    campaign: detail.campaign,
    cycle: detail.cycle,
    occurredAt,
  };
  io.emit('autonomous-campaign:updated', event);
}

function handleRouteError(
  res: Response,
  error: unknown,
  operation: string,
): void {
  if (error instanceof CampaignRequestValidationError) {
    apiError(res, 400, {
      error: error.message,
      code: error.code,
      field: error.field,
    });
    return;
  }
  if (error instanceof AutonomousCampaignPricingError) {
    apiError(res, 422, {
      error: error.message,
      code: 'CAMPAIGN_MODEL_UNPRICED',
      unpricedModels: error.unpricedModels,
    });
    return;
  }
  if (error instanceof AutonomousCampaignControlError) {
    apiError(res, error.code === 'CAMPAIGN_NOT_FOUND' ? 404 : 409, {
      error: error.message,
      code: error.code,
    });
    return;
  }
  if (error instanceof AutonomousCampaignStoreError) {
    apiError(res, 404, {
      error: error.message,
      code: 'CAMPAIGN_NOT_FOUND',
    });
    return;
  }
  if (error instanceof AutonomousCampaignConflictError) {
    apiError(res, 409, {
      error: error.message,
      code: 'ACTIVE_CAMPAIGN_EXISTS',
    });
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  logger.error({ err: message, operation }, 'Autonomous campaign control failed');
  apiError(res, 500, {
    error: 'Autonomous campaign control failed.',
    code: 'CAMPAIGN_CONTROL_FAILED',
  });
}

function requestUserId(req: AuthRequest): string {
  const user = req.user as
    | { id?: string; userId?: string; username?: string }
    | undefined;
  return user?.id ?? user?.userId ?? user?.username ?? 'admin';
}

export function createAutonomousCampaignsRouter(
  io: SocketServer,
  deps: AutonomousCampaignsRouterDeps = {},
): Router {
  const router = Router();
  const verifyRepositoryBranch =
    deps.verifyRepositoryBranch ?? verifyRepositoryBranchAccess;
  const currentTime = deps.now ?? (() => new Date().toISOString());

  router.use('/api/autonomous-campaigns', requireAdmin);

  router.get('/api/autonomous-campaigns', (_req: Request, res: Response) => {
    res.json({ campaigns: listCampaigns() });
  });

  router.post(
    '/api/autonomous-campaigns',
    async (req: AuthRequest, res: Response) => {
      try {
        const occurredAt = currentTime();
        const input = parseCreateInput(req.body, requestUserId(req));
        const verification = await verifyRepositoryBranch(
          input.repository,
          input.baseBranch,
        );
        if (!verification.ok) {
          apiError(res, 400, {
            error: verification.reason,
            code: 'CAMPAIGN_BRANCH_INACCESSIBLE',
            field: 'baseBranch',
          });
          return;
        }
        const campaign = createPricedCampaign(input, { occurredAt });
        const detail = getCampaignDetail(campaign.id);
        emitUpdate(io, 'created', detail, occurredAt);
        logger.info(
          {
            campaignId: campaign.id,
            repository: campaign.repository,
            baseBranch: campaign.baseBranch,
          },
          'Autonomous campaign created',
        );
        res.status(201).json({ campaign });
      } catch (error) {
        handleRouteError(res, error, 'create');
      }
    },
  );

  router.get(
    '/api/autonomous-campaigns/:id',
    (req: Request, res: Response) => {
      try {
        res.json(getCampaignDetail(routeParam(req, 'id')));
      } catch (error) {
        handleRouteError(res, error, 'detail');
      }
    },
  );

  const actions = {
    start: startCampaign,
    pause: pauseCampaign,
    resume: resumeCampaign,
    stop: stopCampaign,
  } as const;

  for (const [action, control] of Object.entries(actions) as Array<
    [keyof typeof actions, (campaignId: string, nowMs?: number) => AutonomousCampaignDetailResponse]
  >) {
    router.post(
      `/api/autonomous-campaigns/:id/${action}`,
      (req: Request, res: Response) => {
        try {
          const occurredAt = currentTime();
          const detail = control(
            routeParam(req, 'id'),
            new Date(occurredAt).getTime(),
          );
          const eventAction: Record<
            keyof typeof actions,
            AutonomousCampaignEventAction
          > = {
            start: 'started',
            pause: 'paused',
            resume: 'resumed',
            stop: 'stopped',
          };
          emitUpdate(
            io,
            eventAction[action],
            detail,
            occurredAt,
          );
          res.json(detail);
        } catch (error) {
          handleRouteError(res, error, action);
        }
      },
    );
  }

  return router;
}
