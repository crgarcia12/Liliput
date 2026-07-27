export interface PullRequestCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface PullRequestCommitStatus {
  context: string;
  state: string;
}

export interface PullRequestChecksSnapshot {
  checkRuns: PullRequestCheckRun[];
  statuses: PullRequestCommitStatus[];
}

export interface PullRequestCheckEvaluation {
  state: 'none' | 'passing' | 'pending' | 'failing';
  details: string[];
}

export interface VerifiedPullRequestChecks extends PullRequestCheckEvaluation {
  headSha: string;
}

export interface PullRequestCheckGateOptions {
  fetchImpl?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  noChecksGraceMs?: number;
  pollIntervalMs?: number;
  passingStabilityMs?: number;
}

const PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
const FAILING_CONCLUSIONS = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'startup_failure',
  'stale',
]);

export function evaluatePullRequestChecks(
  snapshot: PullRequestChecksSnapshot,
): PullRequestCheckEvaluation {
  if (snapshot.checkRuns.length === 0 && snapshot.statuses.length === 0) {
    return { state: 'none', details: [] };
  }

  const failures: string[] = [];
  const pending: string[] = [];

  for (const run of snapshot.checkRuns) {
    const status = run.status.toLowerCase();
    const conclusion = run.conclusion?.toLowerCase() ?? null;
    if (status !== 'completed' || conclusion === null) {
      pending.push(`${run.name} (${run.status})`);
    } else if (
      FAILING_CONCLUSIONS.has(conclusion) ||
      !PASSING_CONCLUSIONS.has(conclusion)
    ) {
      failures.push(`${run.name} (${run.conclusion})`);
    }
  }

  for (const status of snapshot.statuses) {
    const state = status.state.toLowerCase();
    if (state === 'pending') {
      pending.push(`${status.context} (${status.state})`);
    } else if (state !== 'success') {
      failures.push(`${status.context} (${status.state})`);
    }
  }

  if (failures.length > 0) return { state: 'failing', details: failures };
  if (pending.length > 0) return { state: 'pending', details: pending };
  return { state: 'passing', details: [] };
}

interface PullRequestResponse {
  head?: { sha?: string };
}

interface CheckRunsResponse {
  check_runs?: Array<{
    name?: string;
    status?: string;
    conclusion?: string | null;
  }>;
}

interface CombinedStatusResponse {
  statuses?: Array<{
    context?: string;
    state?: string;
  }>;
}

const CHECK_GATE_TIMEOUT_MS = parseInt(
  process.env['GITHUB_CHECK_GATE_TIMEOUT_MS'] ?? '600000',
  10,
);
const CHECK_GATE_NO_CHECKS_GRACE_MS = parseInt(
  process.env['GITHUB_CHECK_GATE_NO_CHECKS_GRACE_MS'] ?? '30000',
  10,
);
const CHECK_GATE_POLL_INTERVAL_MS = parseInt(
  process.env['GITHUB_CHECK_GATE_POLL_INTERVAL_MS'] ?? '5000',
  10,
);
const CHECK_GATE_PASSING_STABILITY_MS = parseInt(
  process.env['GITHUB_CHECK_GATE_PASSING_STABILITY_MS'] ?? '5000',
  10,
);

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function githubJson<T>(
  url: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<T> {
  const response = await fetchImpl(url, {
    headers: {
      Authorization: ['Bearer', token].join(' '),
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub check query failed (${response.status}): ${body.slice(0, 500)}`,
    );
  }
  return response.json() as Promise<T>;
}

async function readChecksSnapshot(
  repo: string,
  sha: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<PullRequestChecksSnapshot> {
  const [checkRunsResponse, statusResponse] = await Promise.all([
    githubJson<CheckRunsResponse>(
      `https://api.github.com/repos/${repo}/commits/${sha}/check-runs?per_page=100`,
      token,
      fetchImpl,
    ),
    githubJson<CombinedStatusResponse>(
      `https://api.github.com/repos/${repo}/commits/${sha}/status`,
      token,
      fetchImpl,
    ),
  ]);

  return {
    checkRuns: (checkRunsResponse.check_runs ?? []).map((run) => ({
      name: run.name ?? '(unnamed check)',
      status: run.status ?? 'unknown',
      conclusion: run.conclusion ?? null,
    })),
    statuses: (statusResponse.statuses ?? []).map((status) => ({
      context: status.context ?? '(unnamed status)',
      state: status.state ?? 'unknown',
    })),
  };
}

export async function assertPullRequestChecksPassing(
  repo: string,
  prNumber: number,
  token: string,
  options: PullRequestCheckGateOptions = {},
): Promise<VerifiedPullRequestChecks> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? delay;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? CHECK_GATE_TIMEOUT_MS;
  const noChecksGraceMs = options.noChecksGraceMs ?? CHECK_GATE_NO_CHECKS_GRACE_MS;
  const pollIntervalMs = options.pollIntervalMs ?? CHECK_GATE_POLL_INTERVAL_MS;
  const passingStabilityMs =
    options.passingStabilityMs ?? CHECK_GATE_PASSING_STABILITY_MS;
  const pullRequest = await githubJson<PullRequestResponse>(
    `https://api.github.com/repos/${repo}/pulls/${prNumber}`,
    token,
    fetchImpl,
  );
  const sha = pullRequest.head?.sha?.trim();
  if (!sha) {
    throw new Error(`Pull request #${prNumber} has no readable head SHA.`);
  }

  const startedAt = now();
  let passingSince: number | undefined;
  let lastEvaluation: PullRequestCheckEvaluation = { state: 'none', details: [] };
  while (true) {
    const snapshot = await readChecksSnapshot(repo, sha, token, fetchImpl);
    const evaluation = evaluatePullRequestChecks(snapshot);
    lastEvaluation = evaluation;
    const elapsedMs = now() - startedAt;

    if (evaluation.state === 'failing') {
      throw new Error(
        `Pull request #${prNumber} checks failed for ${sha}: ${evaluation.details.join(', ')}`,
      );
    }
    if (evaluation.state === 'none') {
      passingSince = undefined;
      if (elapsedMs >= noChecksGraceMs) {
        return { ...evaluation, headSha: sha };
      }
    } else if (evaluation.state === 'passing') {
      passingSince ??= now();
      if (now() - passingSince >= passingStabilityMs) {
        return { ...evaluation, headSha: sha };
      }
    } else {
      passingSince = undefined;
    }

    if (elapsedMs >= timeoutMs) {
      const details =
        lastEvaluation.details.length > 0
          ? `: ${lastEvaluation.details.join(', ')}`
          : '';
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for pull request #${prNumber} checks on ${sha} (${lastEvaluation.state})${details}`,
      );
    }
    await sleep(Math.min(pollIntervalMs, Math.max(1, timeoutMs - elapsedMs)));
  }
}
