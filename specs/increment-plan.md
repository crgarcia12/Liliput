# Increment Plan

## Extension impact analysis: Autonomous Workstream Campaigns

The extension adds a durable hierarchy above existing workstreams:

```text
Autonomous Campaign
  -> Cycle (one selected feature)
      -> Attempt (one bounded delivery try)
          -> existing Workstream
              -> existing Task
```

The existing workstream, task, branch, test, preview, reviewer, and GitHub
services remain the delivery engine. New code coordinates them serially,
persists recovery checkpoints, and gives campaign pull requests one explicit
merge authority.

Affected surfaces:

- SQLite schema and stores;
- model pricing eligibility;
- shared API types;
- API startup and background scheduling;
- task/workstream creation idempotency;
- evidence assembly, feature proposal, and critic agents;
- task pipeline handoff, interruption, and bounded attempts;
- campaign-specific reviewer decisions and release gates;
- GitHub PR labeling, RM dispatcher exclusion, merge confirmation, and conflict
  handling;
- authenticated Web portal controls, alerts, history, and live state;
- Socket.IO campaign events; and
- unit, integration, Cucumber, and Playwright coverage.

No new Azure resource, workflow engine, or npm package is planned.

## ext-pre-001: Add durable campaign state and coordinator primitives

- **Type:** extension prerequisite
- **Effort:** M
- **FRD:** `specs/liliput/frd-autonomous-workstream-campaigns.md`
- **Scope:** Add campaign, cycle, and attempt tables; typed stores; transactional
  state transitions; unique active-campaign and active-cycle constraints;
  renewable leases; deterministic idempotency keys; retry scheduling; and
  budget-accounting primitives. No agent work is scheduled in this increment.
- **Acceptance Criteria:**
  - [ ] Campaign, cycle, and attempt records survive API restart.
  - [ ] Only one unexpired lease owner can transition a campaign.
  - [ ] One active campaign is allowed per repository/base branch.
  - [ ] One active cycle is allowed per campaign.
  - [ ] Replaying a transition is idempotent.
  - [ ] Existing task and workstream schemas remain backward compatible.
- **Test Strategy:**
  - Unit tests for migrations, stores, state transitions, leases, fake-clock
    expiry, unique constraints, idempotency, backoff, and budget calculations.
  - Restart test against a temporary SQLite database.
  - Regression: all existing store and task tests remain green.
- **Gherkin Deltas:**
  - New: `Scenario: Campaign state survives an API restart`.
  - New: `Scenario: Competing coordinators cannot own the same campaign`.
  - Regression: existing task and workstream persistence scenarios are unchanged.
- **Integration Points:**
  - `src/api/src/stores/db.ts`
  - new campaign/cycle/attempt stores
  - `src/shared/types/index.ts`
- **Dependencies:** none
- **Rollback Plan:** Stop the coordinator, remove new stores and types, and leave
  additive tables unused. Existing task data is unaffected.

## ext-pre-002: Require priced models for bounded campaign cost

- **Type:** extension prerequisite
- **Effort:** S
- **FRD:** `specs/liliput/frd-autonomous-workstream-campaigns.md`
- **Scope:** Add campaign model-eligibility checks backed by the existing
  `model_pricing` store and pricing API. Filter campaign model selectors to
  models with an effective price. Allow operators to add verified pricing rows;
  never guess a price or count unknown usage as zero.
- **Acceptance Criteria:**
  - [ ] Campaign creation rejects every selected model without effective pricing.
  - [ ] Existing pricing CRUD can make a model eligible without a deployment.
  - [ ] Removing pricing mid-campaign moves the cycle to
        `waiting_for_external` before another model turn.
  - [ ] Cost calculation uses the price effective at each recorded usage call.
  - [ ] Current manual tasks may continue to use unpriced models unchanged.
- **Test Strategy:**
  - Pricing lookup, eligibility, effective-date, and mid-campaign removal tests.
  - Route tests for explicit validation errors.
  - Regression: existing cost and pricing-store tests remain green.
- **Gherkin Deltas:**
  - New: `Scenario: Unpriced model cannot start an autonomous campaign`.
  - New: `Scenario: Restored model pricing resumes a waiting campaign`.
  - Regression: manual task model selection remains unchanged.
- **Integration Points:**
  - `src/api/src/stores/pricing-store.ts`
  - `src/api/src/stores/cost-store.ts`
  - existing `/api/pricing` routes
  - campaign creation validation and portal model selectors
- **Dependencies:** `ext-pre-001`
- **Rollback Plan:** Disable cost-bounded campaigns while preserving existing
  pricing data and manual task behavior.

## ext-001: Add campaign API and portal controls

- **Type:** extension
- **Effort:** M
- **FRD:** `specs/liliput/frd-autonomous-workstream-campaigns.md`
- **Scope:** Add admin-only campaign CRUD and start/pause/resume/stop endpoints,
  shared contracts, and an Autonomy portal surface. Configure one selected repo,
  all five idea sources, unrestricted gated auto-merge, attempt bounds, retry
  cap, cooldown, and non-blocking alert thresholds. Starting reaches `proposing`
  but does not call an LLM yet.
- **Acceptance Criteria:**
  - [ ] Admins can create and control a campaign.
  - [ ] Non-admin mutations return 403.
  - [ ] Repository, branch, model, pricing, and limit validation is explicit.
  - [ ] Defaults are 500 turns, 240 minutes, USD 250, 60-minute retry cap,
        5-minute cooldown, 3-failure alert, and USD 50 cumulative-cost alert.
  - [ ] Pause is non-destructive and resume retains the same cycle.
  - [ ] Stop is terminal and does not delete repository history.
  - [ ] The portal renders all campaign states and valid actions accessibly.
- **Test Strategy:**
  - Supertest route and RBAC coverage.
  - Web component tests for form validation, controls, alerts, and state.
  - Socket.IO event contract tests.
  - Regression: auth, navigation, and manual new-task flows remain green.
- **Gherkin Deltas:**
  - New: `Scenario: Admin creates and starts an autonomous campaign`.
  - New: `Scenario: Operator pauses and resumes a campaign`.
  - New: `Scenario: Operator permanently stops a campaign`.
  - New: `Scenario: Non-admin cannot control a campaign`.
- **Integration Points:**
  - new `/api/autonomous-campaigns` router
  - existing auth/RBAC middleware
  - Web navigation and API hooks
  - Socket.IO event publication
- **Dependencies:** `ext-pre-002`
- **Rollback Plan:** Disable the route and navigation entry. Persisted campaign
  rows remain inert.

## ext-002: Assemble a redacted feature-evidence snapshot

- **Type:** extension
- **Effort:** M
- **FRD:** `specs/liliput/frd-autonomous-workstream-campaigns.md`
- **Scope:** Capture a base-SHA-consistent snapshot from specs/TODOs,
  code/architecture, issues/PR feedback, Liliput runtime evidence, and model
  ideation context. Label and delimit untrusted text, remove tokens and
  secret-shaped values, and persist source metadata. Do not generate a feature
  yet.
- **Acceptance Criteria:**
  - [ ] Every enabled source has an explicit success, empty, or error result.
  - [ ] Repo text is represented as untrusted data, not executable instruction.
  - [ ] Tokens and secret-shaped values are absent from persisted/promoted data.
  - [ ] Snapshot is tied to one repository and base SHA.
  - [ ] Replaying snapshot capture does not create a second cycle.
- **Test Strategy:**
  - Unit tests for source adapters, redaction, delimiters, source failures, and
    base-SHA consistency.
  - Prompt-injection fixtures in issues and review comments.
  - Regression: GitHub issue/PR and log retrieval behavior remains green.
- **Gherkin Deltas:**
  - New: `Scenario: Campaign captures all configured evidence sources`.
  - New: `Scenario: Prompt-injected issue text remains inert evidence`.
  - New: `Scenario: Evidence snapshot excludes secrets`.
- **Integration Points:**
  - GitHub issue/PR services
  - repository workspace readers
  - task, log, verdict, activity, and usage stores
- **Dependencies:** `ext-001`
- **Rollback Plan:** Pause campaigns before proposal generation. Existing
  snapshots remain read-only evidence.

## ext-003: Generate, critique, and persist one feature proposal

- **Type:** extension
- **Effort:** M
- **FRD:** `specs/liliput/frd-autonomous-workstream-campaigns.md`
- **Scope:** Add structured candidate generation, a separate critic pass,
  duplicate and size checks, rollback/testability checks, immutable accepted
  proposal persistence, and rejected-candidate history. No workstream is created
  until one proposal is accepted.
- **Acceptance Criteria:**
  - [ ] The meta-agent uses the persisted evidence snapshot.
  - [ ] The critic selects one useful medium-or-smaller feature or rejects all.
  - [ ] Duplicate, repository-deleting, secret-disclosing, test-weakening,
        irreversible, and untestable proposals are rejected.
  - [ ] Sensitive files or permission changes are not category-blocked; they use
        the normal release gates per ADR-002.
  - [ ] Accepted proposal includes problem, evidence, user value, scope,
        non-goals, AC, likely tests, risks, rollback, and fingerprint.
  - [ ] Proposal replay does not create a second accepted cycle.
- **Test Strategy:**
  - Structured-output and schema tests with deterministic SDK fixtures.
  - Critic, duplicate, fingerprint, size, and rejection tests.
  - Regression: existing feature decomposer tests remain green.
- **Gherkin Deltas:**
  - New: `Scenario: Meta-agent selects a useful feature from evidence`.
  - New: `Scenario: Critic rejects a duplicate feature`.
  - New: `Scenario: Rejected proposal never creates a workstream`.
- **Integration Points:**
  - `feature-decomposer-runner.ts` structured-output patterns
  - Copilot SDK client and role model config
  - campaign cycle store
- **Dependencies:** `ext-002`
- **Rollback Plan:** Remove the proposal worker and retain captured evidence for
  manual inspection.

## ext-004: Create one workstream and enter the existing delivery pipeline

- **Type:** extension
- **Effort:** M
- **FRD:** `specs/liliput/frd-autonomous-workstream-campaigns.md`
- **Scope:** Add the serial coordinator worker, exactly-once workstream/task
  creation, generated-spec handoff, lease renewal, and task-pipeline completion
  detection. A successful handoff reaches the existing review/release state;
  attempt budgets and interruption are deferred to the next increment.
- **Acceptance Criteria:**
  - [ ] One accepted cycle creates exactly one workstream and task.
  - [ ] The proposal becomes the task intent and spec input.
  - [ ] Existing plan/build/test/preview/review stages are reused.
  - [ ] No second cycle begins while the current cycle is non-terminal.
  - [ ] Restart recovery finds persisted workstream, task, branch, image,
        preview, and PR identifiers instead of recreating them.
  - [ ] Task completion is not treated as confirmed merge success.
- **Test Strategy:**
  - Coordinator tests with fake lease owner.
  - Integration tests with mocked Copilot, GitHub, ACR, and Kubernetes clients.
  - Fault injection after each local and remote resource creation boundary.
  - Regression: normal task execution and manual task creation remain green.
- **Gherkin Deltas:**
  - New: `Scenario: Accepted proposal creates one serial workstream`.
  - New: `Scenario: Existing delivery pipeline executes the campaign task`.
  - New: `Scenario: Restart does not duplicate delivery resources`.
- **Integration Points:**
  - `src/api/src/index.ts`
  - `src/api/src/routes/tasks.ts`
  - `src/api/src/engine/agent-engine.ts`
  - workstream/task stores
- **Dependencies:** `ext-003`
- **Rollback Plan:** Disable coordinator startup. Accepted proposals remain
  paused; manual tasks continue normally.

## ext-005: Enforce bounded attempts and operator interruption

- **Type:** extension
- **Effort:** M
- **FRD:** `specs/liliput/frd-autonomous-workstream-campaigns.md`
- **Scope:** Track attempts, enforce 500-turn/240-minute/USD-250 limits before
  another model action, implement pause/stop cancellation boundaries, persist
  failure stage and usage, schedule exponential retry up to 60 minutes, and
  resume the same proposal after restart.
- **Acceptance Criteria:**
  - [ ] Another model action is not scheduled after any attempt limit is reached.
  - [ ] Failed or bounded attempts retry the same proposal.
  - [ ] Pause blocks new turns/stages and preserves resumable work.
  - [ ] Stop prevents all future retries/cycles without deleting evidence.
  - [ ] External waits do not consume model turns or cost.
  - [ ] Retry continues indefinitely until success, pause, or stop.
- **Test Strategy:**
  - Fake-clock and fake-usage budget tests.
  - Cancellation tests at SDK, build, deploy, and review boundaries.
  - Restart during `retry_wait` and `paused`.
  - Regression: existing task interruption and bounded autopilot tests.
- **Gherkin Deltas:**
  - New: `Scenario: Delivery attempt stops at its configured budget`.
  - New: `Scenario: Failed attempt retries the same feature`.
  - New: `Scenario: Paused delivery resumes the same feature`.
  - New: `Scenario: Stopped campaign schedules no further work`.
- **Integration Points:**
  - `src/api/src/engine/autopilot.ts`
  - existing task interruption path
  - usage and cost stores
  - coordinator retry scheduler
- **Dependencies:** `ext-004`
- **Rollback Plan:** Pause all campaigns and disable retry scheduling. Existing
  task evidence remains intact.

## ext-006: Add one campaign release authority and repeat after merge

- **Type:** extension
- **Effort:** M
- **FRD:** `specs/liliput/frd-autonomous-workstream-campaigns.md`
- **Scope:** Persist a structured campaign reviewer decision; create/reuse one
  campaign-marked PR; exclude campaign PRs from `rm:review`, webhook RM dispatch,
  and polling RM reconciliation; evaluate release gates; perform an explicit
  merge; confirm the base SHA; cool down for 5 minutes; and start the next cycle.
- **Acceptance Criteria:**
  - [ ] Campaign coordinator is the only merge authority for campaign PRs.
  - [ ] Campaign PRs never receive `rm:review`.
  - [ ] Webhook and polling RM workers skip campaign-marked PRs.
  - [ ] A paused/stopped campaign PR cannot merge through another worker.
  - [ ] Coder self-verdict is not campaign reviewer acceptance.
  - [ ] Task `completed` is not merge success.
  - [ ] Auto-merge requires tests, persisted reviewer acceptance, healthy
        preview, conflict cleanliness, no pause/stop, and branch-policy success.
  - [ ] A swallowed or failed merge remains retryable and cannot complete a
        cycle.
  - [ ] Cycle success requires the merge SHA to exist on the base branch.
  - [ ] Next cycle starts from that SHA after a 5-minute cooldown.
- **Test Strategy:**
  - Release-gate pass/fail matrix.
  - RM webhook/reconciler exclusion tests.
  - Paused-campaign merge-race test.
  - Explicit GitHub merge and base-SHA confirmation fixtures.
  - Multi-cycle serial advancement test.
  - Regression: manual `rm:review`, ship, direct, and PR modes remain unchanged.
- **Gherkin Deltas:**
  - New: `Scenario: Healthy reviewed campaign feature auto-merges`.
  - New: `Scenario: Paused campaign PR is skipped by Release Manager workers`.
  - New: `Scenario: Failed merge never records cycle success`.
  - New: `Scenario: Next feature starts from the prior merge`.
- **Integration Points:**
  - existing reviewer loop with new persisted campaign decision
  - webhook dispatcher and loop reconciler
  - GitHub PR/merge services
  - conflict guard and preview health state
- **Dependencies:** `ext-005`
- **Rollback Plan:** Mark campaigns paused/manual, remove campaign merge
  scheduling, and leave campaign PRs available for explicit operator action.

## ext-007: Harden recovery and expose complete campaign evidence

- **Type:** extension
- **Effort:** M
- **FRD:** `specs/liliput/frd-autonomous-workstream-campaigns.md`
- **Scope:** Complete startup reconciliation, infrastructure waiting states,
  lease-loss handling, structured pino logging, non-blocking alerts after 3
  consecutive failures and USD 50 cumulative cost, campaign history, live
  portal updates, and deterministic end-to-end tests.
- **Acceptance Criteria:**
  - [ ] AKS-off, GitHub-auth, pricing, ACR, DNS, ingress, and branch-policy waits
        are distinct and visible.
  - [ ] External waits do not consume model turns or cost.
  - [ ] Losing the coordinator lease stops local execution immediately.
  - [ ] Failure and cumulative-cost alerts are durable and do not pause retries.
  - [ ] Portal shows evidence snapshot, candidates, critic result, attempts,
        budgets, reviewer decision, gates, failures, merge, retry, and cooldown.
  - [ ] Full API and AKS restart tests resume without duplicate work.
  - [ ] Existing manual workflows remain unchanged when no campaign is active.
- **Test Strategy:**
  - Startup/restart integration matrix.
  - Infrastructure outage and recovery fixtures.
  - Structured logging and alert assertions.
  - Cucumber lifecycle and error scenarios.
  - Playwright multi-cycle portal flow with mocked external systems.
  - Full API, Cucumber, Playwright, and CLI regression.
- **Gherkin Deltas:**
  - New: `Scenario: Campaign waits while AKS is unavailable`.
  - New: `Scenario: Campaign emits failure and spend alerts but keeps retrying`.
  - New: `Scenario: Campaign resumes after cluster restart`.
  - New: `Scenario: Operator inspects complete cycle evidence`.
- **Integration Points:**
  - startup reconciliation in `src/api/src/index.ts`
  - pino logging
  - Socket.IO activity stream
  - Autonomy list/detail portal
  - all external service adapters
- **Dependencies:** `ext-006`
- **Rollback Plan:** Disable campaign scheduling and retain read-only history.
  Manual task execution and all existing APIs remain available.
