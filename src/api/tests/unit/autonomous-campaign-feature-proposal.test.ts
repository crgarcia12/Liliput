import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AutonomousCampaignIdeaSource,
  AutonomousCampaignModelConfig,
} from '../../../../shared/types/autonomous-campaign-state.js';
import type { AutonomousCampaignEvidenceSnapshot } from '../../../../shared/types/autonomous-campaign-evidence.js';
import * as campaignStore from '../../src/stores/autonomous-campaign-store.js';
import * as evidenceEngine from '../../src/engine/autonomous-campaign-evidence.js';
import { closeDb, getDb } from '../../src/stores/db.js';

type CampaignProposalSize = 'small' | 'medium' | 'large';

type CampaignProposalRejectionReason =
  | 'duplicate'
  | 'repository-deletion'
  | 'secret-disclosure'
  | 'security-weakening'
  | 'test-weakening'
  | 'irreversible-change'
  | 'untestable'
  | 'oversized'
  | 'unsupported';

interface CampaignFeatureCandidate {
  id: string;
  title: string;
  problem: string;
  evidence: string[];
  targetUsers: string[];
  userValue: string;
  scope: string[];
  nonGoals: string[];
  acceptanceCriteria: string[];
  affectedComponents: string[];
  likelyTests: string[];
  risks: string[];
  rollback: string;
  size: CampaignProposalSize;
  deletesRepository?: boolean;
  disclosesSecrets?: boolean;
  weakensSecurity?: boolean;
  weakensTests?: boolean;
  reversible?: boolean;
  verifiable?: boolean;
}

interface AcceptedCampaignProposal {
  candidateId: string;
  title: string;
  problem: string;
  evidence: string[];
  targetUsers: string[];
  userValue: string;
  scope: string[];
  nonGoals: string[];
  acceptanceCriteria: string[];
  affectedComponents: string[];
  likelyTests: string[];
  risks: string[];
  rollback: string;
  size: 'small' | 'medium';
  fingerprint: string;
  evidenceSnapshotId: string;
  baseSha: string;
}

interface CampaignProposalRejection {
  candidateId: string;
  reason: CampaignProposalRejectionReason;
}

interface CampaignProposalHistoryEntry {
  cycleId: string;
  outcome: 'accepted' | 'rejected';
  candidateId: string;
  title: string;
  fingerprint: string;
  reason?: CampaignProposalRejectionReason;
  recordedAt: string;
}

interface CampaignProposalResult {
  status: 'accepted' | 'rejected' | 'replayed';
  proposal?: AcceptedCampaignProposal;
  rejections: CampaignProposalRejection[];
  history: CampaignProposalHistoryEntry[];
}

interface CampaignCandidateGeneratorContext {
  evidenceSnapshot: AutonomousCampaignEvidenceSnapshot;
  baseSha: string;
  modelConfig: AutonomousCampaignModelConfig;
}

interface CampaignProposalCriticContext {
  candidates: CampaignFeatureCandidate[];
  evidenceSnapshot: AutonomousCampaignEvidenceSnapshot;
  fingerprints: Record<string, string>;
}

interface CampaignProposalCriticDecision {
  selectedCandidateId?: string;
  rejections?: CampaignProposalRejection[];
}

interface GenerateAndCritiqueCampaignProposalInput {
  campaignId: string;
  cycleId: string;
  modelConfig: AutonomousCampaignModelConfig;
  knownFingerprints?: string[];
  generateCandidates: (
    context: CampaignCandidateGeneratorContext,
  ) => Promise<{ candidates: CampaignFeatureCandidate[] }>;
  critique: (
    context: CampaignProposalCriticContext,
  ) => Promise<CampaignProposalCriticDecision>;
  now?: () => string;
}

interface CampaignProposalModule {
  generateAndCritiqueCampaignProposal(
    input: GenerateAndCritiqueCampaignProposalInput,
  ): Promise<CampaignProposalResult>;
  calculateCampaignProposalFingerprint(
    candidate: Pick<CampaignFeatureCandidate, 'title' | 'problem' | 'scope'>,
  ): string;
  getCampaignProposalHistory(cycleId: string): CampaignProposalHistoryEntry[];
  resetAutonomousCampaignProposalStore(): void;
}

const proposalModulePath = '../../src/engine/autonomous-campaign-proposal.js';

const allSources: AutonomousCampaignIdeaSource[] = [
  'specs',
  'code',
  'issues',
  'telemetry',
  'ideation',
];

const baseSha = 'abc123def456';
const capturedAt = '2026-07-22T09:00:00Z';
const proposedAt = '2026-07-22T09:05:00Z';

const metaModelConfig: AutonomousCampaignModelConfig = {
  metaAgent: { model: 'gpt-5-meta', reasoningEffort: 'high' },
  coding: { model: 'gpt-5-coder' },
  reviewer: { model: 'gpt-5-reviewer', reasoningEffort: 'medium' },
};

let dbPath = '';
let proposal: CampaignProposalModule;

async function loadProposalModule(): Promise<CampaignProposalModule> {
  const loaded: unknown = await import(proposalModulePath);
  return loaded as CampaignProposalModule;
}

function baseCandidate(
  overrides: Partial<CampaignFeatureCandidate> = {},
): CampaignFeatureCandidate {
  return {
    id: 'cand-preview-health',
    title: 'Explain failed preview health checks',
    problem:
      'Preview deployments report failed health checks without a clear reason, so operators cannot triage them.',
    evidence: [
      'telemetry: preview health probe failed for task-runtime-1',
      'issues: reviewers ask why previews go red',
    ],
    targetUsers: ['campaign operators', 'reviewers'],
    userValue:
      'Operators can immediately see why a preview is unhealthy and act on it.',
    scope: [
      'surface the failing health probe result on the preview panel',
      'link the failing check to its runtime logs',
    ],
    nonGoals: ['redesigning the preview infrastructure'],
    acceptanceCriteria: [
      'a failed preview shows the failing probe name and message',
      'the failing check links to the relevant log entry',
    ],
    affectedComponents: ['src/web/app/previews', 'src/api/src/engine'],
    likelyTests: [
      'unit: preview health formatter',
      'e2e: failed preview shows diagnostic',
    ],
    risks: ['diagnostic text could leak internal detail'],
    rollback: 'Feature-flag the diagnostic panel and disable it if needed.',
    size: 'medium',
    reversible: true,
    verifiable: true,
    ...overrides,
  };
}

function evidenceAdapters(): evidenceEngine.CampaignEvidenceAdapters {
  const make =
    (
      source: AutonomousCampaignIdeaSource,
    ): evidenceEngine.CampaignEvidenceAdapter =>
    async () => ({
      items: [
        {
          id: `${source}-1`,
          label: `${source} evidence`,
          content: `${source} evidence body`,
          trust: 'untrusted' as const,
          origin: { reference: `${source}-1` },
        },
      ],
    });
  return {
    specs: make('specs'),
    code: make('code'),
    issues: make('issues'),
    telemetry: make('telemetry'),
    ideation: make('ideation'),
  };
}

function createRunningCycle(): { campaignId: string; cycleId: string } {
  const campaign = campaignStore.createCampaign({
    repository: 'crgarcia12/Liliput',
    baseBranch: 'main',
    ideaSources: allSources,
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
  return { campaignId: campaign.id, cycleId: cycle.id };
}

async function persistEvidence(cycle: {
  campaignId: string;
  cycleId: string;
}): Promise<AutonomousCampaignEvidenceSnapshot> {
  return evidenceEngine.captureCampaignEvidence({
    campaignId: cycle.campaignId,
    cycleId: cycle.cycleId,
    repository: 'crgarcia12/Liliput',
    baseBranch: 'main',
    enabledSources: allSources,
    resolveBaseSha: async () => baseSha,
    adapters: evidenceAdapters(),
    now: () => capturedAt,
  });
}

async function generate(
  cycle: { campaignId: string; cycleId: string },
  options: {
    candidates: CampaignFeatureCandidate[] | unknown[];
    decision: CampaignProposalCriticDecision;
    knownFingerprints?: string[];
    generate?: ReturnType<typeof vi.fn>;
    critique?: ReturnType<typeof vi.fn>;
  },
): Promise<CampaignProposalResult> {
  const generateCandidates =
    options.generate ??
    vi.fn(async () => ({
      candidates: options.candidates as CampaignFeatureCandidate[],
    }));
  const critique = options.critique ?? vi.fn(async () => options.decision);
  return proposal.generateAndCritiqueCampaignProposal({
    campaignId: cycle.campaignId,
    cycleId: cycle.cycleId,
    modelConfig: metaModelConfig,
    knownFingerprints: options.knownFingerprints,
    now: () => proposedAt,
    generateCandidates,
    critique,
  });
}

beforeEach(async () => {
  closeDb();
  dbPath = path.join(
    os.tmpdir(),
    `liliput-campaign-proposal-${process.pid}-${randomUUID()}.db`,
  );
  process.env['DB_PATH'] = dbPath;
  campaignStore.resetAutonomousCampaignStore();
  evidenceEngine.resetAutonomousCampaignEvidenceStore();
  proposal = await loadProposalModule();
  proposal.resetAutonomousCampaignProposalStore();
});

afterEach(() => {
  closeDb();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  process.env['DB_PATH'] = ':memory:';
});

describe('generateAndCritiqueCampaignProposal', () => {
  it('should accept and persist one critic-selected medium feature', async () => {
    const cycle = createRunningCycle();
    const snapshot = await persistEvidence(cycle);
    const candidate = baseCandidate();

    const result = await generate(cycle, {
      candidates: [candidate],
      decision: { selectedCandidateId: candidate.id },
    });

    expect(result.status).toBe('accepted');
    expect(result.proposal).toMatchObject({
      candidateId: candidate.id,
      title: candidate.title,
      problem: candidate.problem,
      evidence: candidate.evidence,
      targetUsers: candidate.targetUsers,
      userValue: candidate.userValue,
      scope: candidate.scope,
      nonGoals: candidate.nonGoals,
      acceptanceCriteria: candidate.acceptanceCriteria,
      affectedComponents: candidate.affectedComponents,
      likelyTests: candidate.likelyTests,
      risks: candidate.risks,
      rollback: candidate.rollback,
      size: 'medium',
      evidenceSnapshotId: snapshot.id,
      baseSha,
    });
    expect(result.proposal?.fingerprint).toMatch(/^[a-f0-9]{16,}$/);
    expect(result.rejections).toHaveLength(0);
  });

  it('should persist the proposal and fingerprint immutably on the cycle before any workstream or task', async () => {
    const cycle = createRunningCycle();
    await persistEvidence(cycle);
    const candidate = baseCandidate();

    const result = await generate(cycle, {
      candidates: [candidate],
      decision: { selectedCandidateId: candidate.id },
    });

    const stored = campaignStore.getCycle(cycle.cycleId);
    expect(stored?.proposal?.['candidateId']).toBe(candidate.id);
    expect(stored?.proposalFingerprint).toBe(result.proposal?.fingerprint);
    expect(stored?.workstreamId).toBeUndefined();
    expect(stored?.taskId).toBeUndefined();

    const workstreams = getDb()
      .prepare('SELECT COUNT(*) AS count FROM workstreams')
      .get() as { count: number };
    const tasks = getDb()
      .prepare('SELECT COUNT(*) AS count FROM tasks')
      .get() as { count: number };
    expect(workstreams.count).toBe(0);
    expect(tasks.count).toBe(0);
  });

  it('should record the accepted decision in proposal history', async () => {
    const cycle = createRunningCycle();
    await persistEvidence(cycle);
    const candidate = baseCandidate();

    const result = await generate(cycle, {
      candidates: [candidate],
      decision: { selectedCandidateId: candidate.id },
    });

    const history = proposal.getCampaignProposalHistory(cycle.cycleId);
    const accepted = history.find((entry) => entry.outcome === 'accepted');
    expect(accepted).toMatchObject({
      cycleId: cycle.cycleId,
      candidateId: candidate.id,
      fingerprint: result.proposal?.fingerprint,
      recordedAt: proposedAt,
    });
  });

  it('should pass the persisted snapshot, base SHA, and meta-agent model config to the generator', async () => {
    const cycle = createRunningCycle();
    const snapshot = await persistEvidence(cycle);
    const candidate = baseCandidate();
    const generateSpy = vi.fn(async () => ({ candidates: [candidate] }));

    await generate(cycle, {
      candidates: [candidate],
      decision: { selectedCandidateId: candidate.id },
      generate: generateSpy,
    });

    expect(generateSpy).toHaveBeenCalledTimes(1);
    const context = generateSpy.mock
      .calls[0][0] as CampaignCandidateGeneratorContext;
    expect(context.evidenceSnapshot.id).toBe(snapshot.id);
    expect(context.baseSha).toBe(baseSha);
    expect(context.modelConfig).toEqual(metaModelConfig);
  });

  it('should give the critic the candidates and evidence and honour its selection', async () => {
    const cycle = createRunningCycle();
    const snapshot = await persistEvidence(cycle);
    const candidates = [
      baseCandidate({ id: 'cand-1', problem: 'A.', scope: ['a'] }),
      baseCandidate({ id: 'cand-2', problem: 'B.', scope: ['b'] }),
      baseCandidate({ id: 'cand-3', problem: 'C.', scope: ['c'] }),
    ];
    const critique = vi.fn(async () => ({ selectedCandidateId: 'cand-2' }));

    const result = await generate(cycle, {
      candidates,
      decision: { selectedCandidateId: 'cand-2' },
      critique,
    });

    expect(critique).toHaveBeenCalledTimes(1);
    const context = critique.mock.calls[0][0] as CampaignProposalCriticContext;
    expect(context.candidates).toHaveLength(3);
    expect(context.evidenceSnapshot.id).toBe(snapshot.id);
    expect(result.status).toBe('accepted');
    expect(result.proposal?.candidateId).toBe('cand-2');
  });

  it('should not reject a candidate merely because it affects authentication, workflow, or permission files', async () => {
    const cycle = createRunningCycle();
    await persistEvidence(cycle);
    const candidate = baseCandidate({
      id: 'cand-auth',
      affectedComponents: [
        'src/api/src/auth.ts',
        '.github/workflows/deploy.yml',
        'k8s/permissions.yaml',
      ],
    });

    const result = await generate(cycle, {
      candidates: [candidate],
      decision: { selectedCandidateId: candidate.id },
    });

    expect(result.status).toBe('accepted');
    expect(campaignStore.getCycle(cycle.cycleId)?.proposal).toBeDefined();
  });

  it.each<[string, Partial<CampaignFeatureCandidate>, CampaignProposalRejectionReason]>([
    ['repository deletion', { deletesRepository: true }, 'repository-deletion'],
    ['secret disclosure', { disclosesSecrets: true }, 'secret-disclosure'],
    ['security weakening', { weakensSecurity: true }, 'security-weakening'],
    ['test weakening', { weakensTests: true }, 'test-weakening'],
    ['irreversible change', { reversible: false }, 'irreversible-change'],
    ['untestable work', { verifiable: false }, 'untestable'],
    ['oversized work', { size: 'large' }, 'oversized'],
  ])(
    'should reject %s and record the policy reason',
    async (_label, overrides, reason) => {
      const cycle = createRunningCycle();
      await persistEvidence(cycle);
      const candidate = baseCandidate({ id: `cand-${reason}`, ...overrides });

      const result = await generate(cycle, {
        candidates: [candidate],
        decision: {
          rejections: [{ candidateId: candidate.id, reason }],
        },
      });

      expect(result.status).toBe('rejected');
      expect(result.proposal).toBeUndefined();
      expect(result.rejections).toContainEqual({
        candidateId: candidate.id,
        reason,
      });
      const stored = campaignStore.getCycle(cycle.cycleId);
      expect(stored?.proposal).toBeUndefined();
      expect(stored?.proposalFingerprint).toBeUndefined();
      const history = proposal.getCampaignProposalHistory(cycle.cycleId);
      expect(
        history.some(
          (entry) => entry.outcome === 'rejected' && entry.reason === reason,
        ),
      ).toBe(true);
    },
  );

  it('should reject a duplicate of a previously merged fingerprint even when the critic selects it', async () => {
    const cycle = createRunningCycle();
    await persistEvidence(cycle);
    const merged = baseCandidate({ id: 'cand-merged' });
    const knownFingerprint =
      proposal.calculateCampaignProposalFingerprint(merged);
    const duplicate = baseCandidate({
      id: 'cand-duplicate',
      title: '  EXPLAIN   failed Preview HEALTH checks ',
      problem:
        '  PREVIEW deployments report FAILED health checks without a clear reason, so OPERATORS cannot triage them.  ',
      scope: [
        'LINK the failing check to its runtime logs',
        'SURFACE the failing health probe result on the preview panel',
      ],
    });

    const result = await generate(cycle, {
      candidates: [duplicate],
      decision: { selectedCandidateId: 'cand-duplicate' },
      knownFingerprints: [knownFingerprint],
    });

    expect(result.status).toBe('rejected');
    expect(result.rejections).toContainEqual({
      candidateId: 'cand-duplicate',
      reason: 'duplicate',
    });
    expect(
      proposal
        .getCampaignProposalHistory(cycle.cycleId)
        .some((entry) => entry.reason === 'duplicate'),
    ).toBe(true);
  });

  it('should record every candidate when the critic rejects the entire set', async () => {
    const cycle = createRunningCycle();
    await persistEvidence(cycle);
    const candidates = [
      baseCandidate({ id: 'cand-a', problem: 'A.', scope: ['a'] }),
      baseCandidate({ id: 'cand-b', problem: 'B.', scope: ['b'] }),
      baseCandidate({ id: 'cand-c', problem: 'C.', scope: ['c'] }),
    ];

    const result = await generate(cycle, {
      candidates,
      decision: {
        rejections: candidates.map((candidate) => ({
          candidateId: candidate.id,
          reason: 'unsupported' as const,
        })),
      },
    });

    expect(result.status).toBe('rejected');
    const history = proposal.getCampaignProposalHistory(cycle.cycleId);
    const rejected = history.filter((entry) => entry.outcome === 'rejected');
    expect(rejected).toHaveLength(3);
    expect(new Set(rejected.map((entry) => entry.candidateId))).toEqual(
      new Set(['cand-a', 'cand-b', 'cand-c']),
    );
    expect(campaignStore.getCycle(cycle.cycleId)?.status).toBe('proposing');
  });

  it('should be idempotent and replay the accepted proposal without invoking the agents or creating a cycle', async () => {
    const cycle = createRunningCycle();
    await persistEvidence(cycle);
    const candidate = baseCandidate();
    const first = await generate(cycle, {
      candidates: [candidate],
      decision: { selectedCandidateId: candidate.id },
    });

    const generateSpy = vi.fn(async () => ({ candidates: [candidate] }));
    const critiqueSpy = vi.fn(async () => ({
      selectedCandidateId: candidate.id,
    }));
    const replay = await generate(cycle, {
      candidates: [candidate],
      decision: { selectedCandidateId: candidate.id },
      generate: generateSpy,
      critique: critiqueSpy,
    });

    expect(replay.status).toBe('replayed');
    expect(replay.proposal).toEqual(first.proposal);
    expect(generateSpy).not.toHaveBeenCalled();
    expect(critiqueSpy).not.toHaveBeenCalled();
    const cycles = getDb()
      .prepare(
        'SELECT COUNT(*) AS count FROM autonomous_cycles WHERE campaign_id = ?',
      )
      .get(cycle.campaignId) as { count: number };
    expect(cycles.count).toBe(1);
  });

  it('should fail with an evidence-required error and not invoke the agents when no snapshot exists', async () => {
    const cycle = createRunningCycle();
    const generateSpy = vi.fn(async () => ({ candidates: [baseCandidate()] }));
    const critiqueSpy = vi.fn(async () => ({ selectedCandidateId: 'x' }));

    await expect(
      generate(cycle, {
        candidates: [baseCandidate()],
        decision: { selectedCandidateId: 'x' },
        generate: generateSpy,
        critique: critiqueSpy,
      }),
    ).rejects.toMatchObject({ code: 'evidence-required' });

    expect(generateSpy).not.toHaveBeenCalled();
    expect(critiqueSpy).not.toHaveBeenCalled();
    const stored = campaignStore.getCycle(cycle.cycleId);
    expect(stored?.proposal).toBeUndefined();
    expect(stored?.proposalFingerprint).toBeUndefined();
  });

  it('should fail with a structured-output error and not mutate the cycle for schema-invalid output', async () => {
    const cycle = createRunningCycle();
    await persistEvidence(cycle);
    const critiqueSpy = vi.fn(async () => ({ selectedCandidateId: 'x' }));

    await expect(
      generate(cycle, {
        candidates: [{ title: 'Incomplete' } as unknown as CampaignFeatureCandidate],
        decision: { selectedCandidateId: 'x' },
        critique: critiqueSpy,
      }),
    ).rejects.toMatchObject({ code: 'invalid-structured-output' });

    expect(critiqueSpy).not.toHaveBeenCalled();
    const stored = campaignStore.getCycle(cycle.cycleId);
    expect(stored?.proposal).toBeUndefined();
    expect(stored?.proposalFingerprint).toBeUndefined();
  });
});

describe('calculateCampaignProposalFingerprint', () => {
  it('should be stable across casing, whitespace, and scope list order', () => {
    const a = proposal.calculateCampaignProposalFingerprint({
      title: 'Explain failed preview health checks',
      problem: 'Preview health checks fail without a clear reason.',
      scope: [
        'surface the failing health probe result',
        'link the failing check to its logs',
      ],
    });
    const b = proposal.calculateCampaignProposalFingerprint({
      title: '  explain   FAILED preview HEALTH checks ',
      problem: '   PREVIEW health checks   FAIL without a clear reason.  ',
      scope: [
        'LINK the failing check to its logs',
        'SURFACE the failing health probe result',
      ],
    });
    expect(a).toBe(b);
  });

  it('should change when scope differs materially', () => {
    const a = proposal.calculateCampaignProposalFingerprint({
      title: 'Explain failed preview health checks',
      problem: 'Preview health checks fail without a clear reason.',
      scope: ['surface the failing health probe result'],
    });
    const different = proposal.calculateCampaignProposalFingerprint({
      title: 'Explain failed preview health checks',
      problem: 'Preview health checks fail without a clear reason.',
      scope: [
        'surface the failing health probe result',
        'automatically roll back failed previews',
      ],
    });
    expect(a).not.toBe(different);
  });
});
