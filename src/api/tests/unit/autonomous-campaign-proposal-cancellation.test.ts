import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/engine/copilot-client.js', () => ({
  getCopilotClient: vi.fn(),
  isSdkConnectionClosed: vi.fn(() => true),
  resetCopilotClient: vi.fn(async () => undefined),
}));

import { getCopilotClient, resetCopilotClient } from '../../src/engine/copilot-client.js';
import {
  cancelAutonomousCampaignProposal,
  prepareConfiguredCampaignProposal,
} from '../../src/engine/autonomous-campaign-proposal.js';
import { captureCampaignEvidence } from '../../src/engine/autonomous-campaign-evidence.js';
import * as campaignStore from '../../src/stores/autonomous-campaign-store.js';
import { closeDb } from '../../src/stores/db.js';

const mockedGetCopilotClient = vi.mocked(getCopilotClient);
const mockedResetCopilotClient = vi.mocked(resetCopilotClient);

let dbPath = '';

beforeEach(() => {
  closeDb();
  dbPath = path.join(
    os.tmpdir(),
    `liliput-campaign-proposal-cancel-${process.pid}-${randomUUID()}.db`,
  );
  process.env['DB_PATH'] = dbPath;
  campaignStore.resetAutonomousCampaignStore();
  vi.clearAllMocks();
});

afterEach(() => {
  closeDb();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  process.env['DB_PATH'] = ':memory:';
});

describe('autonomous campaign proposal cancellation', () => {
  it('should abort every active session and propagate cancellation without retrying', async () => {
    const campaign = campaignStore.createCampaign({
      repository: 'crgarcia12/Liliput',
      baseBranch: 'main',
      ideaSources: ['ideation'],
      modelConfig: {
        metaAgent: { model: 'gpt-5.6-sol' },
        reviewer: { model: 'gpt-5.6-luna' },
      },
    });
    campaignStore.transitionCampaign({
      campaignId: campaign.id,
      expectedStatus: 'draft',
      nextStatus: 'running',
      idempotencyKey: `${campaign.id}-start`,
    });
    const cycle = campaignStore.createCycle({
      campaignId: campaign.id,
      sequence: 1,
      title: 'Pending proposal',
      status: 'proposing',
    });
    await captureCampaignEvidence({
      campaignId: campaign.id,
      cycleId: cycle.id,
      repository: campaign.repository,
      baseBranch: campaign.baseBranch,
      enabledSources: ['ideation'],
      resolveBaseSha: async () => 'abc123def456',
      adapters: {
        ideation: async () => ({
          items: [
            {
              label: 'Opportunity',
              content: 'Operators need clearer campaign progress.',
              trust: 'untrusted',
            },
          ],
        }),
      },
    });

    const sessions: Array<{
      abort: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
      rejectSend: (error: Error) => void;
    }> = [];
    let startedSessions = 0;
    let resolveAllStarted: (() => void) | undefined;
    const allStarted = new Promise<void>((resolve) => {
      resolveAllStarted = resolve;
    });
    mockedGetCopilotClient.mockResolvedValue({
      createSession: vi.fn(async () => {
        let rejectSend: (error: Error) => void = () => undefined;
        const session = {
          sendAndWait: vi.fn(
            () =>
              new Promise<never>((_resolve, reject) => {
                rejectSend = reject;
                startedSessions += 1;
                if (startedSessions === 2) resolveAllStarted?.();
              }),
          ),
          abort: vi.fn(async () => {
            rejectSend(new Error('connection is closed'));
          }),
          disconnect: vi.fn(async () => undefined),
        };
        sessions.push({
          abort: session.abort,
          disconnect: session.disconnect,
          rejectSend: (error) => rejectSend(error),
        });
        return session;
      }),
    } as unknown as Awaited<ReturnType<typeof getCopilotClient>>);

    const first = prepareConfiguredCampaignProposal({
      campaignId: campaign.id,
      cycleId: cycle.id,
      modelConfig: campaign.modelConfig,
    });
    const second = prepareConfiguredCampaignProposal({
      campaignId: campaign.id,
      cycleId: cycle.id,
      modelConfig: campaign.modelConfig,
    });
    await allStarted;

    cancelAutonomousCampaignProposal(campaign.id, cycle.id);

    await expect(first).rejects.toMatchObject({
      name: 'AutonomousCampaignProposalCancelledError',
    });
    await expect(second).rejects.toMatchObject({
      name: 'AutonomousCampaignProposalCancelledError',
    });
    expect(sessions).toHaveLength(2);
    for (const session of sessions) {
      expect(session.abort).toHaveBeenCalledOnce();
      expect(session.disconnect).toHaveBeenCalledOnce();
    }
    expect(mockedResetCopilotClient).not.toHaveBeenCalled();

    cancelAutonomousCampaignProposal(campaign.id, cycle.id);
    for (const session of sessions) {
      expect(session.abort).toHaveBeenCalledOnce();
    }
  });
});
