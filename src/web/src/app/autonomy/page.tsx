'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { io } from 'socket.io-client';
import type {
  AutonomousCampaignAction,
  AutonomousCampaignDetailResponse,
  AutonomousCampaignListResponse,
  CreateAutonomousCampaignRequest,
  CreateAutonomousCampaignResponse,
} from '@shared/types/autonomous-campaign-controls';
import type {
  AutonomousCampaign,
  AutonomousCampaignCycleStatus,
} from '@shared/types/autonomous-campaign-state';
import TopBar from '../../components/TopBar';
import apiClient from '../../lib/api-client';

const SOCKET_URL =
  typeof window !== 'undefined' && window.location.hostname !== 'localhost'
    ? ''
    : 'http://localhost:5001';

const inputClassName =
  'mt-1 w-full rounded-md border border-[#2a2a40] bg-[#090910] px-3 py-2 text-sm text-gray-100 outline-none transition-colors placeholder:text-gray-600 focus:border-cyan-500/70 focus:ring-1 focus:ring-cyan-500/30';

function isTerminalCycle(status: AutonomousCampaignCycleStatus): boolean {
  return status === 'succeeded' || status === 'stopped';
}

function effectiveStatus(detail: AutonomousCampaignDetailResponse): string {
  if (detail.cycle && !isTerminalCycle(detail.cycle.status)) {
    return detail.cycle.status;
  }
  return detail.campaign.status;
}

function getErrorDetails(error: unknown): { message: string; adminDenied: boolean } {
  const message = error instanceof Error ? error.message : String(error);
  const adminDenied =
    message.includes('403') ||
    message.toLowerCase().includes('forbidden') ||
    message.includes('ADMIN_REQUIRED');

  return {
    message: adminDenied ? 'Admin access required.' : message,
    adminDenied,
  };
}

export default function AutonomyPage() {
  const [campaigns, setCampaigns] = useState<AutonomousCampaign[]>([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  const selectedCampaignIdRef = useRef<string | null>(null);
  const [detail, setDetail] = useState<AutonomousCampaignDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adminDenied, setAdminDenied] = useState(false);
  const [creating, setCreating] = useState(false);
  const [actionInProgress, setActionInProgress] =
    useState<AutonomousCampaignAction | null>(null);

  const [repository, setRepository] = useState('crgarcia12/Liliput');
  const [baseBranch, setBaseBranch] = useState('main');
  const [metaAgentModel, setMetaAgentModel] = useState('gpt-5.4');
  const [codingModel, setCodingModel] = useState('gpt-5.4');
  const [reviewModel, setReviewModel] = useState('gpt-5.4');
  const [maxTurns, setMaxTurns] = useState('500');
  const [maxMinutes, setMaxMinutes] = useState('240');
  const [maxCostUsd, setMaxCostUsd] = useState('250');

  const reportError = useCallback((caught: unknown) => {
    const details = getErrorDetails(caught);
    setError(details.message);
    if (details.adminDenied) {
      setAdminDenied(true);
    }
  }, []);

  const loadCampaigns = useCallback(async () => {
    try {
      const response = await apiClient.get<AutonomousCampaignListResponse>(
        '/api/autonomous-campaigns',
      );
      setCampaigns(response.campaigns);
      setAdminDenied(false);
      setError(null);
    } catch (caught) {
      reportError(caught);
    } finally {
      setLoading(false);
    }
  }, [reportError]);

  const loadDetail = useCallback(
    async (campaignId: string) => {
      try {
        const response = await apiClient.get<AutonomousCampaignDetailResponse>(
          `/api/autonomous-campaigns/${campaignId}`,
        );
        setDetail(response);
        setError(null);
      } catch (caught) {
        reportError(caught);
      }
    },
    [reportError],
  );

  const selectCampaign = useCallback(
    (campaignId: string) => {
      selectedCampaignIdRef.current = campaignId;
      setSelectedCampaignId(campaignId);
      void loadDetail(campaignId);
    },
    [loadDetail],
  );

  useEffect(() => {
    void loadCampaigns();

    const socket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
    });
    const handleConnect = () => setConnected(true);
    const handleDisconnect = () => setConnected(false);
    const handleCampaignUpdate = () => {
      void loadCampaigns();
      const campaignId = selectedCampaignIdRef.current;
      if (campaignId) {
        void loadDetail(campaignId);
      }
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('connect_error', handleDisconnect);
    socket.on('autonomous-campaign:updated', handleCampaignUpdate);

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('connect_error', handleDisconnect);
      socket.off('autonomous-campaign:updated', handleCampaignUpdate);
      socket.disconnect();
    };
  }, [loadCampaigns, loadDetail]);

  const createCampaign = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreating(true);
    setError(null);

    const request: CreateAutonomousCampaignRequest = {
      repository: repository.trim(),
      baseBranch: baseBranch.trim(),
      modelConfig: {
        metaAgent: { model: metaAgentModel.trim() },
        coding: { model: codingModel.trim() },
        reviewer: { model: reviewModel.trim() },
      },
      maxTurnsPerAttempt: Number(maxTurns),
      maxMinutesPerAttempt: Number(maxMinutes),
      maxCostUsdPerAttempt: Number(maxCostUsd),
    };

    try {
      const response = await apiClient.post<CreateAutonomousCampaignResponse>(
        '/api/autonomous-campaigns',
        { ...request },
      );
      selectedCampaignIdRef.current = response.campaign.id;
      setSelectedCampaignId(response.campaign.id);
      await Promise.all([loadCampaigns(), loadDetail(response.campaign.id)]);
    } catch (caught) {
      reportError(caught);
    } finally {
      setCreating(false);
    }
  };

  const runAction = async (action: AutonomousCampaignAction) => {
    if (!selectedCampaignId) return;

    setActionInProgress(action);
    setError(null);
    try {
      const response = await apiClient.post<AutonomousCampaignDetailResponse>(
        `/api/autonomous-campaigns/${selectedCampaignId}/${action}`,
      );
      setDetail(response);
      await loadCampaigns();
    } catch (caught) {
      reportError(caught);
    } finally {
      setActionInProgress(null);
    }
  };

  return (
    <div className="min-h-screen bg-[#050510] text-gray-200">
      <TopBar subtitle="Autonomy" connected={connected} />

      <main className="mx-auto w-full max-w-7xl space-y-6 px-6 py-6">
        <header>
          <h1 data-testid="autonomy-heading" className="text-2xl font-bold text-gray-100">
            Autonomous campaigns
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Configure durable engineering campaigns and control their lifecycle.
          </p>
        </header>

        {error && (
          <div
            role="alert"
            data-testid="autonomy-error"
            className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300"
          >
            {error}
          </div>
        )}

        {!adminDenied && (
          <section className="rounded-lg border border-[#1a1a2e] bg-[#0d0d14] p-5">
            <div className="mb-4">
              <h2 className="text-sm font-semibold text-cyan-300">Create campaign</h2>
              <p className="mt-1 text-xs text-gray-500">
                New campaigns remain in draft until explicitly started.
              </p>
            </div>

            <form onSubmit={createCampaign} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <label htmlFor="campaign-repository" className="text-xs text-gray-400">
                  Repository
                  <input
                    id="campaign-repository"
                    data-testid="campaign-repository"
                    value={repository}
                    onChange={(event) => setRepository(event.target.value)}
                    className={inputClassName}
                    placeholder="owner/repository"
                    required
                  />
                </label>
                <label htmlFor="campaign-branch" className="text-xs text-gray-400">
                  Base branch
                  <input
                    id="campaign-branch"
                    data-testid="campaign-branch"
                    value={baseBranch}
                    onChange={(event) => setBaseBranch(event.target.value)}
                    className={inputClassName}
                    required
                  />
                </label>
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <label htmlFor="campaign-meta-agent-model" className="text-xs text-gray-400">
                  Meta-agent model
                  <input
                    id="campaign-meta-agent-model"
                    data-testid="campaign-meta-agent-model"
                    value={metaAgentModel}
                    onChange={(event) => setMetaAgentModel(event.target.value)}
                    className={inputClassName}
                    required
                  />
                </label>
                <label htmlFor="campaign-coding-model" className="text-xs text-gray-400">
                  Coding model
                  <input
                    id="campaign-coding-model"
                    data-testid="campaign-coding-model"
                    value={codingModel}
                    onChange={(event) => setCodingModel(event.target.value)}
                    className={inputClassName}
                    required
                  />
                </label>
                <label htmlFor="campaign-review-model" className="text-xs text-gray-400">
                  Review model
                  <input
                    id="campaign-review-model"
                    data-testid="campaign-review-model"
                    value={reviewModel}
                    onChange={(event) => setReviewModel(event.target.value)}
                    className={inputClassName}
                    required
                  />
                </label>
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <label htmlFor="campaign-max-turns" className="text-xs text-gray-400">
                  Maximum turns
                  <input
                    id="campaign-max-turns"
                    data-testid="campaign-max-turns"
                    type="number"
                    min="1"
                    step="1"
                    value={maxTurns}
                    onChange={(event) => setMaxTurns(event.target.value)}
                    className={inputClassName}
                    required
                  />
                </label>
                <label htmlFor="campaign-max-minutes" className="text-xs text-gray-400">
                  Maximum minutes
                  <input
                    id="campaign-max-minutes"
                    data-testid="campaign-max-minutes"
                    type="number"
                    min="1"
                    step="1"
                    value={maxMinutes}
                    onChange={(event) => setMaxMinutes(event.target.value)}
                    className={inputClassName}
                    required
                  />
                </label>
                <label htmlFor="campaign-max-cost" className="text-xs text-gray-400">
                  Maximum cost (USD)
                  <input
                    id="campaign-max-cost"
                    data-testid="campaign-max-cost"
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={maxCostUsd}
                    onChange={(event) => setMaxCostUsd(event.target.value)}
                    className={inputClassName}
                    required
                  />
                </label>
              </div>

              <button
                type="submit"
                data-testid="campaign-create"
                disabled={creating}
                className="inline-flex h-9 items-center rounded-md bg-cyan-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {creating ? 'Creating…' : 'Create campaign'}
              </button>
            </form>
          </section>
        )}

        {!adminDenied && (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.4fr)]">
            <section className="rounded-lg border border-[#1a1a2e] bg-[#0d0d14] p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-300">Campaigns</h2>
                <button
                  type="button"
                  onClick={() => void loadCampaigns()}
                  className="text-xs text-cyan-400 hover:text-cyan-200"
                >
                  ↻ Refresh
                </button>
              </div>

              <div data-testid="campaign-list" className="space-y-2">
                {loading ? (
                  <p className="text-sm text-gray-500">Loading…</p>
                ) : campaigns.length === 0 ? (
                  <p className="rounded-md border border-dashed border-[#2a2a40] p-4 text-sm text-gray-500">
                    No campaigns configured.
                  </p>
                ) : (
                  campaigns.map((campaign) => (
                    <button
                      key={campaign.id}
                      type="button"
                      aria-label={campaign.repository}
                      onClick={() => selectCampaign(campaign.id)}
                      className={`w-full rounded-md border px-3 py-3 text-left transition-colors ${
                        selectedCampaignId === campaign.id
                          ? 'border-cyan-500/60 bg-cyan-500/10'
                          : 'border-[#242438] bg-[#090910] hover:border-[#3a3a54]'
                      }`}
                    >
                      <span className="block truncate text-sm font-semibold text-gray-200">
                        {campaign.repository}
                      </span>
                      <span className="mt-1 flex items-center justify-between gap-2 text-xs text-gray-500">
                        <span>{campaign.baseBranch}</span>
                        <span className="rounded-full border border-[#34344a] px-2 py-0.5">
                          {campaign.status}
                        </span>
                      </span>
                    </button>
                  ))
                )}
              </div>
            </section>

            <section
              data-testid="campaign-detail"
              className="rounded-lg border border-[#1a1a2e] bg-[#0d0d14] p-5"
            >
              {!detail ? (
                <p className="text-sm text-gray-500">
                  Select a campaign to inspect status and available controls.
                </p>
              ) : (
                <div className="space-y-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="text-lg font-semibold text-gray-100">
                        {detail.campaign.repository}
                      </h2>
                      <p className="mt-1 text-xs text-gray-500">
                        Base branch: <span className="text-gray-300">{detail.campaign.baseBranch}</span>
                      </p>
                    </div>
                    <span
                      data-testid="campaign-status"
                      className="rounded-full border border-cyan-500/40 bg-cyan-500/10 px-3 py-1 text-xs font-semibold text-cyan-300"
                    >
                      {effectiveStatus(detail)}
                    </span>
                  </div>

                  <dl className="grid gap-3 text-xs sm:grid-cols-3">
                    <div className="rounded-md border border-[#242438] bg-[#090910] p-3">
                      <dt className="text-gray-500">Turns / attempt</dt>
                      <dd className="mt-1 text-sm text-gray-200">
                        {detail.campaign.maxTurnsPerAttempt}
                      </dd>
                    </div>
                    <div className="rounded-md border border-[#242438] bg-[#090910] p-3">
                      <dt className="text-gray-500">Minutes / attempt</dt>
                      <dd className="mt-1 text-sm text-gray-200">
                        {detail.campaign.maxMinutesPerAttempt}
                      </dd>
                    </div>
                    <div className="rounded-md border border-[#242438] bg-[#090910] p-3">
                      <dt className="text-gray-500">Cost / attempt</dt>
                      <dd className="mt-1 text-sm text-gray-200">
                        ${detail.campaign.maxCostUsdPerAttempt}
                      </dd>
                    </div>
                  </dl>

                  {detail.cycle && (
                    <div className="rounded-md border border-[#242438] bg-[#090910] p-3 text-xs">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-gray-500">Current cycle</span>
                        <span className="text-amber-300">#{detail.cycle.sequence}</span>
                      </div>
                      <p className="mt-2 text-sm text-gray-200">{detail.cycle.title}</p>
                    </div>
                  )}

                  {detail.allowedActions.length > 0 && (
                    <div className="flex flex-wrap gap-2 border-t border-[#1a1a2e] pt-4">
                      {detail.allowedActions.map((action) => (
                        <button
                          key={action}
                          type="button"
                          data-testid={`campaign-${action}`}
                          disabled={actionInProgress !== null}
                          onClick={() => void runAction(action)}
                          className="rounded-md border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-xs font-semibold text-cyan-200 transition-colors hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {actionInProgress === action
                            ? `${action[0]!.toUpperCase()}${action.slice(1)}ing…`
                            : `${action[0]!.toUpperCase()}${action.slice(1)}`}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
