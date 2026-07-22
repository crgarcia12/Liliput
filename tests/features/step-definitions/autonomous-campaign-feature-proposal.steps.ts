import { After, Given, Then, When } from '@cucumber/cucumber';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import type {
  AutonomousCampaignIdeaSource,
  AutonomousCampaignModelConfig,
} from '../../../src/shared/types/autonomous-campaign-state';
import type { AutonomousCampaignEvidenceSnapshot } from '../../../src/shared/types/autonomous-campaign-evidence';
import * as campaignStore from '../../../src/api/src/stores/autonomous-campaign-store';
import * as evidenceEngine from '../../../src/api/src/engine/autonomous-campaign-evidence';
import { closeDb, getDb } from '../../../src/api/src/stores/db';
import type { CustomWorld } from '../support/world';

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

interface ProposalScenarioState {
  campaignId: string;
  cycleId: string;
  baseSha: string;
  module?: CampaignProposalModule;
  snapshot?: AutonomousCampaignEvidenceSnapshot;
  candidates: CampaignFeatureCandidate[];
  criticDecision: CampaignProposalCriticDecision;
  knownFingerprints: string[];
  generatorCalls: number;
  criticCalls: number;
  generatorContext?: CampaignCandidateGeneratorContext;
  criticContext?: CampaignProposalCriticContext;
  result?: CampaignProposalResult;
  error?: unknown;
  firstProposal?: AcceptedCampaignProposal;
  fingerprintCandidates: {
    a?: Pick<CampaignFeatureCandidate, 'title' | 'problem' | 'scope'>;
    b?: Pick<CampaignFeatureCandidate, 'title' | 'problem' | 'scope'>;
    different?: Pick<CampaignFeatureCandidate, 'title' | 'problem' | 'scope'>;
  };
  fingerprints: { a?: string; b?: string; different?: string };
}

const states = new WeakMap<CustomWorld, ProposalScenarioState>();

const proposalModulePath =
  '../../../src/api/src/engine/autonomous-campaign-proposal';

const allSources: AutonomousCampaignIdeaSource[] = [
  'specs',
  'code',
  'issues',
  'telemetry',
  'ideation',
];

const capturedAt = '2026-07-22T09:00:00Z';
const proposedAt = '2026-07-22T09:05:00Z';

const metaModelConfig: AutonomousCampaignModelConfig = {
  metaAgent: { model: 'gpt-5-meta', reasoningEffort: 'high' },
  coding: { model: 'gpt-5-coder' },
  reviewer: { model: 'gpt-5-reviewer', reasoningEffort: 'medium' },
};

const violationReasons: Record<string, CampaignProposalRejectionReason> = {
  'deletes the target repository': 'repository-deletion',
  'discloses repository or runtime secrets': 'secret-disclosure',
  'disables an existing security control': 'security-weakening',
  'removes or bypasses existing tests': 'test-weakening',
  'requires an irreversible production migration': 'irreversible-change',
  'cannot be verified by tests or a healthy preview': 'untestable',
  'exceeds one medium serial delivery cycle': 'oversized',
};

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

function candidateWithViolation(
  violation: string,
): CampaignFeatureCandidate {
  const reason = violationReasons[violation];
  assert.ok(reason, `unknown violation phrase: ${violation}`);
  const candidate = baseCandidate({
    id: `cand-${reason}`,
    title: `Feature that ${violation}`,
    problem: `A proposed change that ${violation}.`,
  });
  switch (reason) {
    case 'repository-deletion':
      candidate.deletesRepository = true;
      break;
    case 'secret-disclosure':
      candidate.disclosesSecrets = true;
      break;
    case 'security-weakening':
      candidate.weakensSecurity = true;
      break;
    case 'test-weakening':
      candidate.weakensTests = true;
      break;
    case 'irreversible-change':
      candidate.reversible = false;
      break;
    case 'untestable':
      candidate.verifiable = false;
      break;
    case 'oversized':
      candidate.size = 'large';
      break;
    default:
      break;
  }
  return candidate;
}

function evidenceAdapters(): evidenceEngine.CampaignEvidenceAdapters {
  const make =
    (source: AutonomousCampaignIdeaSource): evidenceEngine.CampaignEvidenceAdapter =>
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

function getState(world: CustomWorld): ProposalScenarioState {
  const existing = states.get(world);
  if (existing) return existing;

  const campaign = campaignStore.listCampaigns()[0];
  assert.ok(campaign, 'the background must create a campaign before proposal steps');
  const cycle = campaignStore.getCurrentCycle(campaign.id);
  assert.ok(cycle, 'the background must create a proposing cycle before proposal steps');

  const state: ProposalScenarioState = {
    campaignId: campaign.id,
    cycleId: cycle.id,
    baseSha: cycle.baseSha ?? 'abc123def456',
    candidates: [],
    criticDecision: {},
    knownFingerprints: [],
    generatorCalls: 0,
    criticCalls: 0,
    fingerprintCandidates: {},
    fingerprints: {},
  };
  states.set(world, state);
  return state;
}

async function loadModule(state: ProposalScenarioState): Promise<CampaignProposalModule> {
  if (state.module) return state.module;
  const loaded: unknown = await import(proposalModulePath);
  state.module = loaded as CampaignProposalModule;
  state.module.resetAutonomousCampaignProposalStore();
  return state.module;
}

async function persistEvidence(
  state: ProposalScenarioState,
): Promise<AutonomousCampaignEvidenceSnapshot> {
  const snapshot = await evidenceEngine.captureCampaignEvidence({
    campaignId: state.campaignId,
    cycleId: state.cycleId,
    repository: 'crgarcia12/Liliput',
    baseBranch: 'main',
    enabledSources: allSources,
    resolveBaseSha: async () => state.baseSha,
    adapters: evidenceAdapters(),
    now: () => capturedAt,
  });
  state.snapshot = snapshot;
  return snapshot;
}

async function runProposal(state: ProposalScenarioState): Promise<void> {
  const module = await loadModule(state);
  state.generatorCalls = 0;
  state.criticCalls = 0;
  state.result = undefined;
  state.error = undefined;
  try {
    state.result = await module.generateAndCritiqueCampaignProposal({
      campaignId: state.campaignId,
      cycleId: state.cycleId,
      modelConfig: metaModelConfig,
      knownFingerprints: state.knownFingerprints,
      now: () => proposedAt,
      generateCandidates: async (context) => {
        state.generatorCalls += 1;
        state.generatorContext = context;
        return { candidates: state.candidates };
      },
      critique: async (context) => {
        state.criticCalls += 1;
        state.criticContext = context;
        return state.criticDecision;
      },
    });
  } catch (error) {
    state.error = error;
  }
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    return String((error as { code?: unknown }).code);
  }
  return undefined;
}

After({ tags: '@campaign-proposal' }, async function (this: CustomWorld) {
  closeDb();
  const dbPath = process.env['DB_PATH'];
  if (dbPath && dbPath !== ':memory:') {
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
  }
  process.env['DB_PATH'] = ':memory:';
  states.delete(this);
});

Given(
  'the cycle has a persisted evidence snapshot covering every configured source',
  async function (this: CustomWorld) {
    const state = getState(this);
    const snapshot = await persistEvidence(state);
    assert.equal(snapshot.sources.length, allSources.length);
    assert.ok(evidenceEngine.getCampaignEvidenceSnapshot(state.cycleId));
  },
);

Given(
  'the meta-agent proposes a medium feature to explain failed preview health checks',
  function (this: CustomWorld) {
    const state = getState(this);
    state.candidates = [baseCandidate()];
  },
);

Given(
  'the critic selects that feature as useful, testable, reversible, and non-duplicate',
  function (this: CustomWorld) {
    const state = getState(this);
    const candidate = state.candidates[0];
    assert.ok(candidate, 'a candidate must be proposed before the critic selects it');
    state.criticDecision = { selectedCandidateId: candidate.id };
  },
);

Given(
  'the meta-agent returns three structured feature candidates',
  function (this: CustomWorld) {
    const state = getState(this);
    state.candidates = [
      baseCandidate({
        id: 'cand-1',
        title: 'Surface preview health diagnostics',
        problem: 'Preview failures are opaque.',
        scope: ['show failing probe on preview panel'],
      }),
      baseCandidate({
        id: 'cand-2',
        title: 'Summarize reviewer verdict history',
        problem: 'Operators cannot see reviewer verdict trends.',
        scope: ['aggregate reviewer verdicts per campaign'],
      }),
      baseCandidate({
        id: 'cand-3',
        title: 'Highlight stale open pull requests',
        problem: 'Stale campaign PRs are easy to miss.',
        scope: ['flag campaign PRs older than a threshold'],
      }),
    ];
  },
);

Given('the critic selects the second candidate', function (this: CustomWorld) {
  const state = getState(this);
  const candidate = state.candidates[1];
  assert.ok(candidate, 'three candidates must exist before selecting the second');
  state.criticDecision = { selectedCandidateId: candidate.id };
});

Given(
  'the meta-agent proposes a feature that {string}',
  function (this: CustomWorld, violation: string) {
    const state = getState(this);
    state.candidates = [candidateWithViolation(violation)];
  },
);

Given(
  'the critic rejects the candidate for policy reason {string}',
  function (this: CustomWorld, reason: string) {
    const state = getState(this);
    const candidate = state.candidates[0];
    assert.ok(candidate, 'a candidate must be proposed before the critic rejects it');
    state.criticDecision = {
      rejections: [
        {
          candidateId: candidate.id,
          reason: reason as CampaignProposalRejectionReason,
        },
      ],
    };
  },
);

Given(
  'the meta-agent proposes a medium authentication workflow improvement',
  function (this: CustomWorld) {
    const state = getState(this);
    state.candidates = [
      baseCandidate({
        id: 'cand-auth-workflow',
        title: 'Add step-up authentication to the release workflow',
        problem:
          'The release workflow does not require step-up authentication for sensitive merges.',
        scope: [
          'require step-up authentication before auto-merge',
          'record the authentication decision in the workflow log',
        ],
        affectedComponents: [
          'src/api/src/auth.ts',
          '.github/workflows/deploy.yml',
          'k8s/permissions.yaml',
        ],
        likelyTests: [
          'unit: step-up authentication guard',
          'integration: release workflow requires step-up auth',
        ],
        size: 'medium',
        reversible: true,
        verifiable: true,
      }),
    ];
  },
);

Given(
  'the critic finds it useful, testable, reversible, and non-duplicate',
  function (this: CustomWorld) {
    const state = getState(this);
    const candidate = state.candidates[0];
    assert.ok(candidate, 'a candidate must be proposed before the critic accepts it');
    state.criticDecision = { selectedCandidateId: candidate.id };
  },
);

Given(
  'a previously merged campaign feature has the same normalized fingerprint',
  async function (this: CustomWorld) {
    const state = getState(this);
    const module = await loadModule(state);
    const merged = baseCandidate({
      id: 'cand-merged',
      title: 'Explain failed preview health checks',
      problem:
        'Preview deployments report failed health checks without a clear reason, so operators cannot triage them.',
      scope: [
        'surface the failing health probe result on the preview panel',
        'link the failing check to its runtime logs',
      ],
    });
    state.knownFingerprints = [
      module.calculateCampaignProposalFingerprint(merged),
    ];
  },
);

Given(
  'the meta-agent proposes the equivalent feature with different casing and whitespace',
  function (this: CustomWorld) {
    const state = getState(this);
    state.candidates = [
      baseCandidate({
        id: 'cand-duplicate',
        title: '  EXPLAIN   failed Preview HEALTH checks ',
        problem:
          '  PREVIEW deployments report FAILED health checks without a clear reason, so OPERATORS cannot triage them.  ',
        scope: [
          'LINK the failing check to its runtime logs',
          'SURFACE the failing health probe result on the preview panel',
        ],
      }),
    ];
    state.criticDecision = { selectedCandidateId: 'cand-duplicate' };
  },
);

Given(
  'two candidates describe the same problem and scope with different casing, spacing, and list order',
  function (this: CustomWorld) {
    const state = getState(this);
    state.fingerprintCandidates.a = {
      title: 'Explain failed preview health checks',
      problem: 'Preview health checks fail without a clear reason.',
      scope: [
        'surface the failing health probe result',
        'link the failing check to its logs',
      ],
    };
    state.fingerprintCandidates.b = {
      title: '  explain   FAILED preview HEALTH checks ',
      problem: '   PREVIEW health checks   FAIL without a clear reason.  ',
      scope: [
        'LINK the failing check to its logs',
        'SURFACE the failing health probe result',
      ],
    };
    state.fingerprintCandidates.different = {
      title: 'Explain failed preview health checks',
      problem: 'Preview health checks fail without a clear reason.',
      scope: [
        'surface the failing health probe result',
        'link the failing check to its logs',
        'automatically roll back failed previews',
      ],
    };
  },
);

Given(
  'every structured candidate is rejected by the critic',
  function (this: CustomWorld) {
    const state = getState(this);
    state.candidates = [
      baseCandidate({ id: 'cand-a', title: 'Feature A', problem: 'Problem A.', scope: ['scope a'] }),
      baseCandidate({ id: 'cand-b', title: 'Feature B', problem: 'Problem B.', scope: ['scope b'] }),
      baseCandidate({ id: 'cand-c', title: 'Feature C', problem: 'Problem C.', scope: ['scope c'] }),
    ];
    state.criticDecision = {
      rejections: state.candidates.map((candidate) => ({
        candidateId: candidate.id,
        reason: 'unsupported' as const,
      })),
    };
  },
);

Given(
  'the current cycle already has an accepted feature proposal',
  async function (this: CustomWorld) {
    const state = getState(this);
    await persistEvidence(state);
    state.candidates = [baseCandidate({ id: 'cand-accepted' })];
    state.criticDecision = { selectedCandidateId: 'cand-accepted' };
    await runProposal(state);
    assert.equal(state.result?.status, 'accepted');
    state.firstProposal = state.result?.proposal;
    assert.ok(state.firstProposal, 'the first run must accept a proposal');
  },
);

Given(
  'the current cycle has no persisted evidence snapshot',
  function (this: CustomWorld) {
    const state = getState(this);
    assert.equal(
      evidenceEngine.getCampaignEvidenceSnapshot(state.cycleId),
      undefined,
    );
  },
);

Given(
  'the meta-agent returns output that does not match the candidate schema',
  function (this: CustomWorld) {
    const state = getState(this);
    state.candidates = [
      { title: 'Incomplete candidate' } as unknown as CampaignFeatureCandidate,
    ];
    state.criticDecision = { selectedCandidateId: 'unknown' };
  },
);

When(
  'the campaign generates and critiques feature proposals',
  async function (this: CustomWorld) {
    await runProposal(getState(this));
  },
);

When(
  'the campaign generates and critiques feature proposals again',
  async function (this: CustomWorld) {
    await runProposal(getState(this));
  },
);

When(
  'the campaign tries to generate feature proposals',
  async function (this: CustomWorld) {
    await runProposal(getState(this));
  },
);

When('their proposal fingerprints are calculated', async function (this: CustomWorld) {
  const state = getState(this);
  const module = await loadModule(state);
  assert.ok(state.fingerprintCandidates.a);
  assert.ok(state.fingerprintCandidates.b);
  assert.ok(state.fingerprintCandidates.different);
  state.fingerprints.a = module.calculateCampaignProposalFingerprint(
    state.fingerprintCandidates.a,
  );
  state.fingerprints.b = module.calculateCampaignProposalFingerprint(
    state.fingerprintCandidates.b,
  );
  state.fingerprints.different = module.calculateCampaignProposalFingerprint(
    state.fingerprintCandidates.different,
  );
});

Then(
  'one accepted proposal should be persisted on the current cycle',
  function (this: CustomWorld) {
    const state = getState(this);
    assert.ifError(state.error);
    assert.equal(state.result?.status, 'accepted');
    assert.ok(state.result?.proposal);
    const cycle = campaignStore.getCycle(state.cycleId);
    assert.ok(cycle?.proposal, 'the cycle must persist an accepted proposal');
    assert.ok(cycle?.proposalFingerprint, 'the cycle must persist a fingerprint');
    assert.equal(
      cycle?.proposal?.['candidateId'],
      state.result?.proposal?.candidateId,
    );
    assert.equal(cycle?.proposalFingerprint, state.result?.proposal?.fingerprint);
  },
);

Then(
  'the accepted proposal should include problem, evidence, users, value, scope, non-goals, acceptance criteria, components, tests, risks, rollback, size, and fingerprint',
  function (this: CustomWorld) {
    const state = getState(this);
    const proposal = state.result?.proposal;
    assert.ok(proposal, 'an accepted proposal must exist');
    assert.ok(proposal.title.length > 0);
    assert.ok(proposal.problem.length > 0);
    assert.ok(proposal.evidence.length > 0);
    assert.ok(proposal.targetUsers.length > 0);
    assert.ok(proposal.userValue.length > 0);
    assert.ok(proposal.scope.length > 0);
    assert.ok(proposal.nonGoals.length > 0);
    assert.ok(proposal.acceptanceCriteria.length > 0);
    assert.ok(proposal.affectedComponents.length > 0);
    assert.ok(proposal.likelyTests.length > 0);
    assert.ok(proposal.risks.length > 0);
    assert.ok(proposal.rollback.length > 0);
    assert.ok(proposal.size === 'small' || proposal.size === 'medium');
    assert.ok(proposal.fingerprint.length > 0);
  },
);

Then(
  'the proposal should reference the persisted evidence snapshot and base commit',
  function (this: CustomWorld) {
    const state = getState(this);
    const proposal = state.result?.proposal;
    assert.ok(proposal, 'an accepted proposal must exist');
    assert.ok(state.snapshot, 'evidence must be persisted first');
    assert.equal(proposal.evidenceSnapshotId, state.snapshot.id);
    assert.equal(proposal.baseSha, state.baseSha);
    assert.equal(state.generatorContext?.evidenceSnapshot.id, state.snapshot.id);
    assert.equal(state.generatorContext?.baseSha, state.baseSha);
    assert.deepEqual(state.generatorContext?.modelConfig, metaModelConfig);
  },
);

Then('no workstream or task should be created', function (this: CustomWorld) {
  const state = getState(this);
  const cycle = campaignStore.getCycle(state.cycleId);
  assert.equal(cycle?.workstreamId, undefined);
  assert.equal(cycle?.taskId, undefined);
  const workstreams = getDb()
    .prepare('SELECT COUNT(*) AS count FROM workstreams')
    .get() as { count: number };
  const tasks = getDb()
    .prepare('SELECT COUNT(*) AS count FROM tasks')
    .get() as { count: number };
  assert.equal(workstreams.count, 0);
  assert.equal(tasks.count, 0);
});

Then(
  'the second candidate should be the only accepted proposal',
  function (this: CustomWorld) {
    const state = getState(this);
    assert.ifError(state.error);
    assert.equal(state.result?.status, 'accepted');
    const expected = state.candidates[1];
    assert.ok(expected);
    assert.equal(state.result?.proposal?.candidateId, expected.id);
    assert.equal(state.result?.rejections.length ?? 0, 0);
  },
);

Then(
  'the meta-agent and critic decisions should be retained in proposal history',
  function (this: CustomWorld) {
    const state = getState(this);
    assert.ok(state.module);
    const history = state.module.getCampaignProposalHistory(state.cycleId);
    const accepted = history.find((entry) => entry.outcome === 'accepted');
    assert.ok(accepted, 'proposal history must record the accepted decision');
    assert.equal(accepted.candidateId, state.result?.proposal?.candidateId);
    assert.equal(accepted.cycleId, state.cycleId);
    assert.ok(state.criticCalls > 0, 'the critic must have been consulted');
    assert.ok(state.generatorCalls > 0, 'the meta-agent must have been consulted');
  },
);

Then('no accepted proposal should be persisted', function (this: CustomWorld) {
  const state = getState(this);
  assert.notEqual(state.result?.status, 'accepted');
  assert.equal(state.result?.proposal, undefined);
  const cycle = campaignStore.getCycle(state.cycleId);
  assert.equal(cycle?.proposal, undefined);
  assert.equal(cycle?.proposalFingerprint, undefined);
});

Then(
  'the rejected candidate should be recorded with reason {string}',
  function (this: CustomWorld, reason: string) {
    const state = getState(this);
    assert.ok(state.module);
    const history = state.module.getCampaignProposalHistory(state.cycleId);
    const entry = history.find(
      (item) => item.outcome === 'rejected' && item.reason === reason,
    );
    assert.ok(entry, `history must record a rejection with reason ${reason}`);
    assert.ok(
      state.result?.rejections.some((item) => item.reason === reason),
      `result must report a rejection with reason ${reason}`,
    );
  },
);

Then(
  'the proposal should not be rejected only because authentication or workflow files are affected',
  function (this: CustomWorld) {
    const state = getState(this);
    assert.ifError(state.error);
    assert.notEqual(state.result?.status, 'rejected');
    const affected = state.candidates[0]?.affectedComponents ?? [];
    assert.ok(
      affected.some((component) => /auth|workflow|permission/i.test(component)),
      'the candidate must touch sensitive files to exercise this rule',
    );
  },
);

Then(
  'one accepted proposal should be persisted for normal release gates',
  function (this: CustomWorld) {
    const state = getState(this);
    assert.equal(state.result?.status, 'accepted');
    const cycle = campaignStore.getCycle(state.cycleId);
    assert.ok(cycle?.proposal);
    assert.ok(cycle?.proposalFingerprint);
  },
);

Then('the candidate should be rejected as a duplicate', function (this: CustomWorld) {
  const state = getState(this);
  assert.ifError(state.error);
  assert.equal(state.result?.status, 'rejected');
  assert.ok(
    state.result?.rejections.some((item) => item.reason === 'duplicate'),
    'the result must report a duplicate rejection',
  );
});

Then(
  'the duplicate decision should be recorded in proposal history',
  function (this: CustomWorld) {
    const state = getState(this);
    assert.ok(state.module);
    const history = state.module.getCampaignProposalHistory(state.cycleId);
    assert.ok(
      history.some(
        (entry) => entry.outcome === 'rejected' && entry.reason === 'duplicate',
      ),
      'history must record the duplicate rejection',
    );
  },
);

Then(
  'both candidates should have the same proposal fingerprint',
  function (this: CustomWorld) {
    const state = getState(this);
    assert.ok(state.fingerprints.a);
    assert.ok(state.fingerprints.b);
    assert.equal(state.fingerprints.a, state.fingerprints.b);
  },
);

Then(
  'materially different scope should produce a different proposal fingerprint',
  function (this: CustomWorld) {
    const state = getState(this);
    assert.ok(state.fingerprints.a);
    assert.ok(state.fingerprints.different);
    assert.notEqual(state.fingerprints.a, state.fingerprints.different);
  },
);

Then(
  'every rejected candidate and reason should remain in proposal history',
  function (this: CustomWorld) {
    const state = getState(this);
    assert.ok(state.module);
    const history = state.module.getCampaignProposalHistory(state.cycleId);
    const rejected = history.filter((entry) => entry.outcome === 'rejected');
    assert.equal(rejected.length, state.candidates.length);
    for (const candidate of state.candidates) {
      const entry = rejected.find((item) => item.candidateId === candidate.id);
      assert.ok(entry, `history must record candidate ${candidate.id}`);
      assert.ok(entry.reason, 'each rejected candidate must retain a reason');
    }
  },
);

Then(
  'the current cycle should remain in {string} status',
  function (this: CustomWorld, status: string) {
    const state = getState(this);
    const cycle = campaignStore.getCycle(state.cycleId);
    assert.equal(cycle?.status, status);
  },
);

Then(
  'the existing accepted proposal should be returned',
  function (this: CustomWorld) {
    const state = getState(this);
    assert.ifError(state.error);
    assert.equal(state.result?.status, 'replayed');
    assert.deepEqual(state.result?.proposal, state.firstProposal);
  },
);

Then(
  'neither the meta-agent nor critic should run again',
  function (this: CustomWorld) {
    const state = getState(this);
    assert.equal(state.generatorCalls, 0);
    assert.equal(state.criticCalls, 0);
  },
);

Then(
  'proposal generation should fail with an evidence-required error',
  function (this: CustomWorld) {
    const state = getState(this);
    assert.ok(state.error, 'proposal generation must throw');
    assert.equal(errorCode(state.error), 'evidence-required');
    assert.equal(state.result, undefined);
  },
);

Then('neither the meta-agent nor critic should run', function (this: CustomWorld) {
  const state = getState(this);
  assert.equal(state.generatorCalls, 0);
  assert.equal(state.criticCalls, 0);
});

Then(
  'no accepted proposal, workstream, or task should be persisted',
  function (this: CustomWorld) {
    const state = getState(this);
    const cycle = campaignStore.getCycle(state.cycleId);
    assert.equal(cycle?.proposal, undefined);
    assert.equal(cycle?.proposalFingerprint, undefined);
    assert.equal(cycle?.workstreamId, undefined);
    assert.equal(cycle?.taskId, undefined);
  },
);

Then(
  'proposal generation should fail with a structured-output error',
  function (this: CustomWorld) {
    const state = getState(this);
    assert.ok(state.error, 'proposal generation must throw');
    assert.equal(errorCode(state.error), 'invalid-structured-output');
  },
);

Then(
  'the cycle should retain no accepted proposal or proposal fingerprint',
  function (this: CustomWorld) {
    const state = getState(this);
    const cycle = campaignStore.getCycle(state.cycleId);
    assert.equal(cycle?.proposal, undefined);
    assert.equal(cycle?.proposalFingerprint, undefined);
  },
);
