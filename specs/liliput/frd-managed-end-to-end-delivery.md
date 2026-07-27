# FRD: Managed End-to-End Delivery

**Status:** Implemented
**Product:** Liliput

## Overview

Managed End-to-End Delivery makes Liliput retain the full delivery contract
through every agent turn and fail closed when implementation, validation, or
release evidence is incomplete.

The feature addresses a recurring failure mode: a detailed initial request could
produce a partial application because follow-up and fixer turns lost the original
task or specification, local completion was confused with deployed health, and
weak validation or Git safeguards allowed false completion.

## User Stories

- As an operator, I want every coder and fixer turn to retain the original task,
  approved specification, repository, branch, and base revision so recovery work
  cannot optimize for only the latest error message.
- As an operator, I want Liliput to distinguish locally complete implementation
  from deployment verification so agents do not claim a deployment they cannot
  observe.
- As an operator, I want specification, validation, CI, Git, and merge failures to
  stop delivery explicitly so a task cannot appear complete without evidence.
- As an operator, I want a rebuild of the current commit to produce a real rollout
  without polluting the source repository with marker commits.
- As a campaign operator, I want autonomous proposals to include a concrete
  production or operator capability so campaigns do not spend cycles on
  documentation-only work.

## Integration Points

- **Coder session (`src/api/src/engine/agent-loop.ts`)** - injects one managed
  delivery contract into initial, follow-up, build-fixer, deploy-fixer,
  validation-fixer, Git-fixer, and conflict-resolution turns.
- **Task pipeline (`src/api/src/engine/agent-engine.ts`)** - supplies immutable
  repository identity, treats unhealthy validation as failure, reuses clean
  commits for rebuilds, and requires confirmed release operations.
- **Specification generation (`src/api/src/engine/spec-generator.ts`)** - fails
  closed when repository grounding or model generation fails.
- **Task creation (`src/api/src/routes/tasks.ts`)** - returns failed specification
  generation to `clarifying` so the operator can retry without a false spec.
- **Git client (`src/api/src/engine/git-client.ts`)** - verifies origin and branch
  identity and rejects generated, cached, secret-bearing, or unapproved build
  output before commit and push.
- **Validation (`src/api/src/engine/gherkin-runner.ts`)** - passes every discovered
  feature path explicitly to Cucumber and rejects zero-scenario success.
- **GitHub release (`src/api/src/engine/github-check-gate.ts`,
  `src/api/src/engine/github-pr.ts`)** - waits for checks to appear and finish,
  then pins merge to the exact checked pull-request head SHA.
- **Reviewer (`src/api/src/engine/reviewer-loop.ts`)** - may execute relevant
  verification and must reject missing coverage or generated artifacts.
- **Kubernetes deployment (`src/api/src/engine/k8s-deployer.ts`)** - stamps the pod
  template so rebuilding an existing SHA still creates a new rollout.
- **Campaign proposals (`src/api/src/engine/autonomous-campaign-proposal.ts`)** -
  requires an explicit production-code, data, or operator-capability component.
- **Shared campaign types (`src/shared/types/autonomous-campaign-proposal.ts`)** -
  exposes the `non-delivery` rejection reason.

## Acceptance Criteria

- [x] Initial and follow-up coder prompts contain the original task,
      specification, repository, base branch, task branch, base SHA, and workspace.
- [x] Purpose-built fixer and conflict prompts are prefixed with the same managed
      delivery contract.
- [x] `VERDICT: done` means locally implementation-ready and does not claim
      deployment health.
- [x] Repository-grounding or model failures cannot generate a generic fallback
      specification.
- [x] Failed specification generation returns the task to `clarifying`.
- [x] Commit and push operations fail when origin or checked-out branch identity
      differs from the task contract.
- [x] Commit operations reject dependency caches, environment files, runtime
      caches, and unapproved `dist/` or `build/` output.
- [x] Repositories that intentionally version build output can use a committed,
      exact-path allowlist.
- [x] Cucumber receives all discovered feature paths explicitly.
- [x] Cucumber exit code zero with zero executed scenarios is a validation failure.
- [x] An unhealthy preview transitions the task to `failed`, not `review`.
- [x] Direct delivery waits for GitHub checks, fails on pending or failed checks,
      and merges only the exact checked head SHA.
- [x] Rebuild-only requests do not create `.liliput-rebuild` or any other no-op
      source commit.
- [x] Rebuilding the same SHA forces a Kubernetes rollout through pod-template
      metadata.
- [x] Autonomous campaign proposals without a production, data, or operator
      delivery surface are rejected as `non-delivery`.
- [x] Pull-request descriptions summarize completed work without copying the
      originating user prompt.

## Edge Cases

- **Repository has no GitHub checks:** wait through the check-discovery grace
  period, then allow direct delivery while still pinning the merge to the observed
  head SHA.
- **Checks remain pending:** stop direct delivery at the configured timeout and
  leave the pull request unmerged.
- **A new commit reaches the pull request after checks:** the SHA-pinned merge
  fails rather than merging unchecked code.
- **Cucumber is missing or broken:** fail validation when feature files exist.
- **Feature files are nested:** recursively discover all ordinary directories
  while ignoring generated directories and symlinked directory loops.
- **Repository intentionally versions build output:** accept only exact `dist` or
  `build` prefixes committed before the task starts.
- **Agent makes no edit during a rebuild request:** build and redeploy the current
  commit directly.
- **Campaign proposes an unknown support file:** reject it unless another affected
  component proves production, data, or operator capability.

## Error Handling

- Specification failures expose a typed error and preserve a retryable task state.
- Git identity and staged-artifact mismatches throw before commit or push.
- GitHub query, pending-check timeout, failed check, stale-SHA merge, and
  unconfirmed merge responses fail the release operation.
- Missing Cucumber, zero executed scenarios, test failure, timeout, or spawn error
  fail validation with captured diagnostics.
- Deployment health failure is persisted and surfaced instead of being converted
  into review-ready state.

## Non-Functional Requirements

- **Reliability:** completion requires explicit evidence at specification,
  implementation, validation, deployment, review, CI, and merge boundaries.
- **Security:** never commit environment files, dependency caches, or secret-shaped
  artifacts; never merge a SHA different from the checked SHA.
- **Performance:** GitHub checks use bounded polling and configurable discovery,
  stabilization, polling, and timeout intervals.
- **Compatibility:** repositories without Cucumber or GitHub checks keep working
  when no corresponding feature files or checks exist.
- **Observability:** failures retain structured diagnostics through the existing
  pino and task activity paths.
