/**
 * PM agent — emits one GitHub issue per Feature on the target repo.
 *
 * Flow (recoverable, idempotent):
 *   1. Skip if `feature.githubIssueNumber` already persisted.
 *   2. Ensure `workstream:<slug>` and `pm:ready` labels exist on the repo.
 *      (Other state-machine labels — `dev:in-progress`, `rm:review`, etc. —
 *       are owned by the bootstrap step in PR-4; we only touch the two we
 *       need so this flow stays useful even before bootstrap automation lands.)
 *   3. Persist `workstream.githubLabel = "workstream:<slug>"` if missing.
 *   4. Create the issue WITHOUT `pm:ready` so a webhook for `issues.labeled`
 *      can never fire before the DB knows the issue number.
 *   5. Persist `feature.githubIssueNumber` / `feature.githubIssueUrl`.
 *   6. Apply `pm:ready` (and `workstream:<slug>`) — only NOW is the issue
 *      considered handed off to the Dev agent.
 *
 * The `<!-- liliput:feature-id=... -->` HTML comment embedded in the body
 * is the durable fallback for the reconciler: if step 5 crashed and the DB
 * has no `githubIssueNumber`, we can repair the mapping by scanning open
 * `pm:ready` issues and parsing the marker.
 *
 * Failure handling: each step is wrapped so a transient GitHub error leaves
 * the system in a recoverable state. We only mark the feature as "PM-emitted"
 * once `pm:ready` has been successfully applied.
 */

import * as featureStore from '../stores/feature-store.js';
import * as workstreamStore from '../stores/workstream-store.js';
import { logger } from '../logger.js';
import {
  ensureLabel,
  createIssue,
  addLabels,
  GitHubApiError,
  type FetchImpl,
} from './github-rest.js';
import { ensureTargetRepoBootstrapped } from './target-repo-bootstrap.js';
import type { Feature, Workstream } from '../../../shared/types/index.js';

/** Label colours we use when CREATING (existing labels are left alone). */
const LABEL_COLORS = {
  'pm:ready': '0e8a16',
  'workstream': 'c5def5',
} as const;

const FEATURE_MARKER_RE = /<!--\s*liliput:feature-id=([A-Za-z0-9_-]+)\s*-->/i;

export interface PmEmitDeps {
  fetchImpl?: FetchImpl;
  /** Override store hooks for unit tests. Defaults to the real stores. */
  features?: Pick<
    typeof featureStore,
    'getFeature' | 'updateFeature'
  >;
  workstreams?: Pick<
    typeof workstreamStore,
    'getWorkstream' | 'setGithubLabel'
  >;
}

export interface CreateIssueForFeatureResult {
  /** 'created' = brand-new issue; 'existing' = feature already had one. */
  status: 'created' | 'existing';
  issueNumber: number;
  issueUrl: string;
}

/**
 * Create — or recover — the GitHub issue for a single Feature.
 *
 * @returns the issue number + url. Never throws on "already exists" cases.
 * @throws on transient GitHub failures (5xx, 4xx other than label-exists). The
 *         caller (decomposer hook) is expected to swallow and log so feature
 *         persistence is never blocked by GitHub flakiness.
 */
export async function createIssueForFeature(
  repository: string,
  workstream: Workstream,
  feature: Feature,
  deps: PmEmitDeps = {},
): Promise<CreateIssueForFeatureResult> {
  const features = deps.features ?? featureStore;
  const workstreams = deps.workstreams ?? workstreamStore;
  const fetchImpl = deps.fetchImpl;

  // Step 1: idempotency short-circuit. Re-read so we never trust a stale arg.
  const fresh = features.getFeature(feature.id);
  if (fresh?.githubIssueNumber && fresh?.githubIssueUrl) {
    return {
      status: 'existing',
      issueNumber: fresh.githubIssueNumber,
      issueUrl: fresh.githubIssueUrl,
    };
  }

  const workstreamLabel = `workstream:${workstream.name}`;

  // Step 2: ensure the two labels we need exist. If GitHub is unreachable
  // this throws and we bail BEFORE creating an orphan issue with no labels.
  await ensureLabel({
    repo: repository,
    name: workstreamLabel,
    color: LABEL_COLORS.workstream,
    description: `Liliput workstream: ${workstream.name}`,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  await ensureLabel({
    repo: repository,
    name: 'pm:ready',
    color: LABEL_COLORS['pm:ready'],
    description: 'Liliput PM has handed off this issue to a Dev agent.',
    ...(fetchImpl ? { fetchImpl } : {}),
  });

  // Step 3: persist the workstream label tag so the reconciler can find
  // every Feature issue of this workstream by label query.
  if (!workstream.githubLabel) {
    workstreams.setGithubLabel(workstream.id, workstreamLabel);
  }

  // Step 4: create the issue (NO pm:ready yet — see module docstring).
  const body = renderIssueBody(workstream, feature);
  const issue = await createIssue({
    repo: repository,
    title: renderIssueTitle(feature),
    body,
    labels: [workstreamLabel],
    ...(fetchImpl ? { fetchImpl } : {}),
  });

  // Step 5: persist the mapping. Do this BEFORE applying pm:ready so the
  // webhook receiver can always look up the Feature when it fires.
  features.updateFeature(feature.id, {
    githubIssueNumber: issue.number,
    githubIssueUrl: issue.htmlUrl,
  });

  // Step 6: hand off to the Dev agent by applying pm:ready. If this fails
  // the reconciler can retry safely — the feature row already knows the
  // issue number and `pm:ready` is missing on GitHub, so the next pass
  // picks up exactly where we left off.
  try {
    await addLabels({
      repo: repository,
      issueNumber: issue.number,
      labels: ['pm:ready'],
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  } catch (err) {
    const e = err instanceof GitHubApiError ? err : null;
    logger.warn(
      {
        repo: repository,
        featureId: feature.id,
        issue: issue.number,
        status: e?.status,
        err: err instanceof Error ? err.message : String(err),
      },
      'pm-issue-flow: pm:ready label apply failed — issue persisted, reconciler will retry',
    );
    // Intentionally don't rethrow — the issue exists, the mapping is saved,
    // and the reconciler heals the missing label. Throwing here would make
    // callers think creation failed and retry, which would double-emit.
  }

  logger.info(
    {
      repo: repository,
      featureId: feature.id,
      workstreamId: workstream.id,
      issue: issue.number,
      url: issue.htmlUrl,
    },
    'pm-issue-flow: issue created',
  );

  return { status: 'created', issueNumber: issue.number, issueUrl: issue.htmlUrl };
}

/**
 * Best-effort batch emit for every Feature freshly persisted by the
 * decomposer. Skips `integration` kind (no human-actionable issue today —
 * the integration agent is internal Liliput plumbing). Each per-feature
 * failure is logged but does not abort the loop.
 */
export async function emitIssuesForWorkstream(
  repository: string,
  workstream: Workstream,
  features: Feature[],
  deps: PmEmitDeps = {},
): Promise<{ created: number; existing: number; failed: number; bootstrap?: string }> {
  // Ensure the target repo has its labels + webhook in place. This is cheap
  // when state='ready' (single DB read). On first call per repo this hits
  // GitHub. Failure here only blocks the batch when labels couldn't be
  // created (loop literally can't function without `pm:ready`).
  const bootstrap = await ensureTargetRepoBootstrapped(repository, {
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  if (bootstrap.bootstrapState !== 'ready') {
    logger.warn(
      { repo: repository, state: bootstrap.bootstrapState, warnings: bootstrap.warnings },
      'pm-emit: target repo not ready — aborting batch',
    );
    return { created: 0, existing: 0, failed: features.length, bootstrap: bootstrap.bootstrapState };
  }
  let created = 0;
  let existing = 0;
  let failed = 0;
  for (const feature of features) {
    if (feature.kind === 'integration') continue;
    try {
      const r = await createIssueForFeature(repository, workstream, feature, deps);
      if (r.status === 'created') created++;
      else existing++;
    } catch (err) {
      failed++;
      logger.warn(
        {
          repo: repository,
          featureId: feature.id,
          err: err instanceof Error ? err.message : String(err),
        },
        'pm-issue-flow: per-feature emit failed — continuing batch',
      );
    }
  }
  return { created, existing, failed, bootstrap: bootstrap.bootstrapState };
}

export function renderIssueTitle(feature: Feature): string {
  // Keep title short and PR-friendly. The slug helps humans scan the list.
  return `${feature.name}`;
}

/**
 * Render the GitHub issue body for a Feature. The hidden HTML marker is
 * required — the reconciler uses it to repair lost mappings.
 */
export function renderIssueBody(workstream: Workstream, feature: Feature): string {
  const lines: string[] = [];
  lines.push(`<!-- liliput:feature-id=${feature.id} -->`);
  lines.push(`<!-- liliput:workstream-id=${workstream.id} -->`);
  lines.push('');
  lines.push(`> **Workstream:** \`${workstream.name}\``);
  if (feature.slug) lines.push(`> **Feature slug:** \`${feature.slug}\``);
  if (feature.specPath) lines.push(`> **Spec:** \`${feature.specPath}\``);
  lines.push('');
  if (feature.description) {
    lines.push('## What');
    lines.push(feature.description.trim());
    lines.push('');
  }
  lines.push('## Acceptance criteria');
  lines.push('');
  lines.push('<!-- Filled in by the PM agent — keep Gherkin Given/When/Then style. -->');
  lines.push('- [ ] _to be authored_');
  lines.push('');
  lines.push('## Definition of done');
  lines.push('- [ ] Code change merged to the integration branch');
  lines.push('- [ ] Tests added/updated and passing');
  lines.push('- [ ] No regressions in the green baseline');
  lines.push('');
  lines.push('---');
  lines.push('_Created by Liliput PM agent. The Release Manager will close this issue once the linked PR is merged and verified._');
  return lines.join('\n');
}

/** Parse the hidden feature-id marker out of an issue body. Used by the
 *  reconciler in PR-7. Exported here so it lives next to the renderer that
 *  emits it (single source of truth for the marker format). */
export function extractFeatureIdMarker(body: string | null | undefined): string | null {
  if (!body) return null;
  const m = body.match(FEATURE_MARKER_RE);
  return m ? (m[1] ?? null) : null;
}
