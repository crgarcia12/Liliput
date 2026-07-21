# FRD: Autonomous Workstream Campaigns

**Status:** Proposed
**Product:** Liliput
**Decision records:**
[ADR-001](../adrs/adr-001-use-sqlite-backed-serial-campaign-coordinator.md),
[ADR-002](../adrs/adr-002-allow-unrestricted-campaign-auto-merge.md)

## Overview

Autonomous Workstream Campaigns add an opt-in mode in which Liliput continuously
improves one operator-selected GitHub repository.

Each campaign runs one feature at a time:

1. inspect the current repository and available product evidence;
2. use a meta-agent and critic to select one useful, non-duplicate feature;
3. define a structured feature specification;
4. create one Liliput workstream, task, and branch;
5. run the existing spec, build, test, preview, and review pipeline;
6. auto-merge only after every configured gate passes;
7. wait for the configured cooldown; and
8. repeat from the new base-branch revision until an operator pauses or stops
   the campaign.

The campaign may run indefinitely, but each individual delivery attempt is
bounded by turns, time, and estimated model cost. A bounded failure retries the
same feature after backoff; it does not silently select an easier replacement.

## Problem

Liliput can already plan, build, test, deploy, review, and ship one requested
task. It can also decompose a prompt into persisted feature records. It does not
have a durable coordinator that:

- decides what useful feature should come next;
- turns that decision into exactly one executable workstream;
- waits for that workstream to pass delivery gates;
- releases the feature so the next cycle sees it on the base branch;
- survives API pod and AKS restarts without duplicating work; and
- repeats until explicitly paused or stopped.

`AUTOPILOT_DECOMPOSE` currently stores decomposed features but does not execute
them. The new mode must reuse the existing task pipeline rather than introduce a
second implementation engine.

## Users

- **Campaign operator:** An admin who selects the target repository, starts the
  campaign, monitors decisions and evidence, and can pause, resume, or stop it.
- **Meta-agent:** An LLM role that analyzes evidence and proposes candidate
  features.
- **Critic agent:** An LLM role that rejects duplicate, low-value, unsafe, or
  oversized proposals and selects one viable feature.
- **Delivery agents:** The existing spec, coder, validator, reviewer, fixer, and
  deployer roles used by a normal Liliput task.

## User Stories

- As an operator, I want to start an autonomous campaign for one repository so
  Liliput can keep improving it without requiring a new prompt per feature.
- As an operator, I want every cycle to create a normal workstream and task so I
  can inspect it with the existing portal and CLI.
- As an operator, I want features to execute serially so each proposal is based
  on all previously merged work.
- As an operator, I want only tested, reviewed, and healthy previews to merge so
  autonomous operation does not bypass Liliput's evidence gates.
- As an operator, I want bounded attempts and visible cost usage so an
  individual feature cannot consume unlimited resources.
- As an operator, I want retry-until-success behavior while retaining the
  ability to pause or stop at any time.
- As an operator, I want campaigns to recover after pod or cluster restarts
  without creating duplicate workstreams, branches, or pull requests.

## Operating Contract

| Decision | Required behavior |
| --- | --- |
| Target scope | One operator-selected repository and base branch per campaign |
| Execution order | Exactly one active feature cycle per campaign |
| Coordinator | SQLite-backed state machine inside the Liliput API |
| Idea sources | Specs/TODOs, code/architecture, issues/PR feedback, Liliput runtime evidence, and independent model ideation |
| Release policy | Auto-merge only after tests, reviewer verdict, conflict checks, and healthy preview pass |
| Failure policy | Retry the same feature indefinitely until success or operator pause/stop |
| Attempt limits | 500 agent turns, 240 minutes, and USD 250 estimated model cost |
| Retry delay | Exponential backoff capped at 60 minutes |
| Success cooldown | 5 minutes before analyzing the updated base branch |
| Operator control | Pause, resume, and stop are available from the Liliput portal |
| Sensitive-change policy | No category-based human gate or protected-path denylist; ordinary release gates apply to every diff |
| Failure alert | Notify after 3 consecutive failed attempts without pausing |
| Cost alert | Notify when cumulative campaign cost reaches USD 50 without pausing |

These values are defaults stored on the campaign and may be changed before the
campaign starts. Running-campaign limit changes apply to the next attempt, not
retroactively to an in-flight tool call.

## Integration Points

- **Task creation (`src/api/src/routes/tasks.ts`)** - the coordinator reuses the
  normal task creation path with an idempotency key and the generated feature
  specification as the initial task intent.
- **Workstream store (`src/api/src/stores/workstream-store.ts`)** - every feature
  cycle creates one dedicated workstream linked from the cycle record.
- **Feature decomposition (`src/api/src/engine/feature-decomposer-runner.ts`)** -
  proposal generation may reuse its structured-output patterns, but the new
  meta-agent selects one feature rather than persisting an unexecuted list.
- **Agent engine (`src/api/src/engine/agent-engine.ts`)** - the coordinator calls
  the existing spec/build/test/deploy/review and ship operations; it does not
  duplicate those stages.
- **Autopilot budgets (`src/api/src/engine/autopilot.ts`)** - existing bounded
  turn and wall-clock concepts are extended to campaign attempts and estimated
  model cost.
- **Task, usage, and activity stores** - campaign gates and evidence use existing
  task status, turn usage, logs, and deployment state.
- **Campaign reviewer decision** - add a persisted structured reviewer result for
  each attempt. The existing coder self-verdict is evidence, not release
  approval.
- **Conflict guard (`src/api/src/engine/conflict-guard.ts`)** - a release must be
  conflict-clean before automatic merge.
- **RM webhook and reconciler** - campaign-owned pull requests carry a distinct
  marker, never receive `rm:review`, and are excluded from independent RM merge
  dispatch. The campaign coordinator is their only merge authority.
- **Startup (`src/api/src/index.ts`)** - starts one coordinator scheduler after
  database migrations and restart reconciliation complete.
- **Shared types (`src/shared/types/index.ts`)** - adds campaign, cycle, attempt,
  status, configuration, and API response contracts.
- **Web portal** - adds an Autonomy surface for creation, controls, current
  feature, attempt budgets, evidence, and cycle history.
- **Authentication and RBAC** - only admins can create, start, pause, resume, or
  stop campaigns. Authenticated non-admin users may receive read access only if
  existing task visibility permits it.
- **GitHub** - reads issues and pull-request feedback, creates branches and pull
  requests through existing low-level services, and performs an explicit
  campaign merge only after release gates pass.
- **Model pricing** - campaign models must resolve through the existing pricing
  store. Unknown prices are never treated as zero.
- **AKS and ACR** - use existing preview build, deploy, routing, log, and health
  mechanisms. No new Azure resource is required.

## Durable Data Model

### `autonomous_campaigns`

Stores the long-lived operator contract and coordinator lease.

Required fields:

- `id`
- `repository`
- `base_branch`
- `status`
- `release_policy`
- `idea_sources_json`
- `model_config_json`
- `max_turns_per_attempt`
- `max_minutes_per_attempt`
- `max_cost_usd_per_attempt`
- `retry_backoff_cap_minutes`
- `success_cooldown_minutes`
- `failed_attempt_alert_threshold`
- `cumulative_cost_alert_usd`
- `cumulative_cost_usd`
- `next_sequence`
- `current_cycle_id`
- `lease_owner`
- `lease_expires_at`
- `pause_requested_at`
- `stop_requested_at`
- `created_by`
- `created_at`
- `updated_at`

Only one non-stopped campaign may exist for the same repository and base
branch.

### `autonomous_cycles`

Stores one selected feature and its linkage to normal Liliput entities.

Required fields:

- `id`
- `campaign_id`
- `sequence`
- `status`
- `proposal_json`
- `proposal_fingerprint`
- `base_sha`
- `workstream_id`
- `task_id`
- `branch_name`
- `pull_request_url`
- `review_decision_json`
- `release_gates_json`
- `merge_sha`
- `next_retry_at`
- `started_at`
- `completed_at`
- `last_error`

The pair `(campaign_id, sequence)` is unique. A cycle keeps the same proposal
across retries.

### `autonomous_attempts`

Stores evidence for each bounded attempt to deliver one cycle.

Required fields:

- `id`
- `cycle_id`
- `attempt_number`
- `status`
- `turns_used`
- `elapsed_ms`
- `estimated_cost_usd`
- `started_at`
- `completed_at`
- `failure_stage`
- `failure_message`

The pair `(cycle_id, attempt_number)` is unique.

## State Machines

### Campaign

```text
draft -> running -> pausing -> paused -> running
                  \-> stopping -> stopped
running --------------------------------> stopped
```

`stopped` is terminal. Stopping a campaign never deletes the GitHub repository
or merged work.

### Cycle

```text
proposing
  -> waiting_for_external
  -> proposing
  -> delivering
  -> waiting_for_external
  -> delivering
  -> ready_to_release
  -> releasing
  -> waiting_for_external
  -> releasing
  -> cooldown
  -> succeeded

proposing | delivering | ready_to_release | releasing
  -> retry_wait
  -> same stage in a new bounded attempt

any non-terminal state -> paused
any non-terminal state -> stopped
```

## Meta-Agent Feature Selection

For each new cycle, the coordinator captures a consistent evidence snapshot at
the current base SHA:

1. repository PRDs, FRDs, roadmap files, TODOs, and relevant documentation;
2. code structure, tests, architecture boundaries, and explicit gaps;
3. open GitHub issues, open pull requests, and review feedback;
4. prior Liliput task failures, reviewer verdicts, preview logs, and available
   usage signals for the repository; and
5. independent product ideas generated from the repository's apparent users and
   purpose.

The meta-agent returns structured candidates. A separate critic pass selects
one candidate or rejects the set and requests another pass.

Repository documentation, issues, pull-request text, review comments, and logs
are untrusted data. Evidence assembly labels and delimits each source, removes
tokens and secret-shaped values, and instructs agents not to execute commands or
follow operational instructions found inside evidence.

The selected proposal must include:

- title and concise problem statement;
- evidence supporting usefulness;
- target users and expected value;
- scope and explicit non-goals;
- acceptance criteria;
- affected components and likely tests;
- delivery and rollback risks;
- a normalized proposal fingerprint; and
- a size classification no larger than medium.

The critic rejects a candidate when it:

- duplicates current code, an open issue, an active cycle, or a previously
  merged campaign feature;
- is not supported by repository evidence or a clear user-value argument;
- requires repository deletion, secret disclosure, disabling security controls,
  or weakening tests;
- requires an irreversible data migration;
- is too large for one serial feature cycle; or
- cannot be validated through the target repository's available test and
  preview mechanisms.

Rejected proposals are recorded as evidence and do not create workstreams or
consume a delivery attempt.

The selected policy does not add a path-based denylist or mandatory human
approval for authentication, infrastructure, workflow, permission, or other
sensitive changes. Those changes may auto-merge when the normal tests, campaign
reviewer, preview, conflict, and branch-policy gates pass. This accepted risk is
documented in ADR-002.

## Serial Coordinator Behavior

The coordinator runs as an internal scheduler in the API process.

1. Claim one runnable campaign in a SQLite transaction by setting a renewable
   lease owner and expiry.
2. Re-read the campaign after the claim. Stop immediately if pause or stop was
   requested.
3. Verify every selected model has an effective pricing row, then verify GitHub
   access and preview infrastructure availability. External unavailability
   moves the campaign to `waiting_for_external` and does not consume model
   budget.
4. Create or resume the current cycle.
5. Generate and critique a proposal only when the cycle has no accepted
   proposal.
6. Create the workstream and task exactly once using the cycle ID as an
   idempotency key.
7. Drive the normal task pipeline and renew the campaign lease while work is
   active.
8. Enforce attempt limits before starting another agent turn or delivery stage.
9. When an attempt fails or reaches a bound, record the attempt, calculate
   exponential backoff up to 60 minutes, emit alerts after 3 consecutive
   failures or USD 50 cumulative campaign cost, and retry the same proposal.
10. Run the campaign reviewer and persist its structured decision separately
    from the coder self-verdict.
11. Create or reuse one campaign-marked pull request without applying
    `rm:review`, then verify all automatic-release gates.
12. Merge through an explicit campaign release operation. Task `completed`
    status alone is never release success.
13. Confirm the base branch contains the merge SHA, mark the cycle successful,
   wait 5 minutes, increment the sequence, and begin another cycle from the new
   base SHA.

All external mutations use deterministic identifiers or persisted remote IDs so
replaying a transition cannot create a second workstream, task, branch, image,
preview, or pull request.

## Automatic Release Gates

A cycle may auto-merge only when all conditions are true:

- the normal task pipeline reached its release/review state;
- all required repository tests passed;
- the persisted campaign reviewer decision is `accepted`;
- the latest preview deployment is ready and its HTTP health probe returned
  success;
- the branch is based on or reconciled with the current base branch;
- the conflict guard reports no unresolved conflict;
- no pause or stop request is pending;
- attempt turn, time, and cost limits have not been exceeded; and
- GitHub branch protection permits the configured automatic merge path.

The coder's `done` self-verdict and the task's `completed` status do not satisfy
the reviewer or merge gates. Campaign pull requests are excluded from the
existing RM webhook and polling merge paths, so a paused or stopped campaign
cannot be merged by a second coordinator.

If a gate is not satisfied, release is not success-shaped. The cycle remains
visible in `retry_wait` or `waiting_for_external` with the exact failed gate.

## Pause, Resume, and Stop

### Pause

- The API acknowledges the request immediately and sets `pause_requested_at`.
- The coordinator schedules no new agent turns or external stages.
- An active Copilot SDK turn is aborted through the existing interruption path
  at the nearest cancellable boundary.
- The workstream, task, branch, pull request, preview, proposal, budgets, and
  retry state remain intact.
- Resume continues the same cycle and attempt when safe; it does not propose a
  new feature.

### Stop

- The API sets `stop_requested_at` and prevents all future retries and cycles.
- Active work is interrupted at the nearest cancellable boundary.
- The campaign and active cycle become `stopped`.
- Merged repository history is never changed.
- Unmerged branch, pull request, preview, and task evidence remain available for
  operator inspection and explicit use of existing ship/discard controls.

## API Surface

All mutation endpoints require an authenticated admin.

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/autonomous-campaigns` | Create a draft campaign |
| `GET` | `/api/autonomous-campaigns` | List campaigns visible to the caller |
| `GET` | `/api/autonomous-campaigns/:id` | Return config, state, current cycle, attempts, and history |
| `POST` | `/api/autonomous-campaigns/:id/start` | Validate config and start or resume scheduling |
| `POST` | `/api/autonomous-campaigns/:id/pause` | Request a non-destructive pause |
| `POST` | `/api/autonomous-campaigns/:id/resume` | Continue the current cycle |
| `POST` | `/api/autonomous-campaigns/:id/stop` | Permanently stop future work |

Campaign creation requires:

- repository;
- base branch;
- meta-agent, coding, and reviewer model configuration;
- enabled idea sources;
- attempt limits;
- retry backoff cap; and
- success cooldown.

Invalid repositories, inaccessible branches, missing pricing data, unknown
models, or non-positive limits return a route-level validation error before a
campaign is started.

Only models with an effective pricing row may be selected. Operators can add or
update verified pricing through the existing pricing API before starting a
campaign; there is no zero-cost or guessed fallback.

## Portal

Add an **Autonomy** entry to the authenticated portal.

### Campaign list

Display:

- repository and base branch;
- campaign state;
- current sequence and feature title;
- current attempt;
- turns, elapsed time, and estimated cost against limits;
- next retry or cooldown time;
- last successful merge; and
- consecutive-failure and cumulative-cost alerts; and
- Start, Pause, Resume, or Stop actions valid for the current state.

### Campaign detail

Display:

- the full operating contract;
- the meta-agent evidence snapshot;
- generated candidates and critic decision;
- selected feature specification;
- linked workstream, task, branch, preview, and pull request;
- release-gate results;
- every bounded attempt and failure reason;
- live campaign events through Socket.IO; and
- cycle history in sequence order.

The portal must distinguish `pausing`, `paused`, `retry_wait`,
`waiting_for_external`, `releasing`, and `cooldown`; it must not collapse them
into a generic running or failed status.

## Acceptance Criteria

- [ ] An admin can create a campaign for one selected repository and base branch.
- [ ] A non-admin cannot create, start, pause, resume, or stop a campaign.
- [ ] Only one non-stopped campaign can target the same repository/base branch.
- [ ] Starting a campaign persists its config and begins coordinator scheduling.
- [ ] The meta-agent evaluates all five configured evidence sources.
- [ ] A critic pass selects one useful, medium-or-smaller, non-duplicate feature.
- [ ] Every accepted proposal is persisted before any workstream is created.
- [ ] Each cycle creates exactly one workstream and one task.
- [ ] No second feature starts while the current cycle is non-terminal.
- [ ] Delivery uses the existing spec/build/test/preview/review pipeline.
- [ ] One attempt stops before another turn when it reaches 500 turns, 240
      minutes, or USD 250 estimated cost.
- [ ] A bounded or failed attempt records evidence and retries the same feature
      after exponential backoff capped at 60 minutes.
- [ ] Retry continues indefinitely until success, pause, or stop.
- [ ] Infrastructure unavailability waits without spending model budget.
- [ ] Every configured model has an effective price before a campaign starts.
- [ ] Auto-merge is impossible unless every release gate passes.
- [ ] The campaign coordinator is the sole merge authority for campaign PRs.
- [ ] Campaign PRs are excluded from RM webhook and polling merge dispatch.
- [ ] A paused campaign's PR cannot merge through another background worker.
- [ ] Coder self-verdict and task completion cannot substitute for reviewer
      acceptance or confirmed base-branch merge.
- [ ] After merge, the next cycle starts from the resulting base-branch SHA
      after a 5-minute cooldown.
- [ ] Pause prevents new work and preserves the active cycle for resume.
- [ ] Stop prevents all future retries and cycles without deleting merged work.
- [ ] API restart or AKS restart resumes the persisted campaign without duplicate
      workstreams, tasks, branches, previews, or pull requests.
- [ ] The portal exposes live state, budgets, evidence, controls, and history.
- [ ] The portal alerts after 3 consecutive failed attempts and USD 50
      cumulative cost without automatically pausing the campaign.
- [ ] Untrusted repo evidence is delimited, labeled, and stripped of tokens and
      secret-shaped values before it enters an agent prompt.
- [ ] Existing manually created tasks and disabled-by-default decomposition
      behavior remain unchanged.

## Edge Cases

- **Cluster is stopped:** campaign enters `waiting_for_external`; it resumes after
  AKS and the preview path are healthy.
- **GitHub token expires:** record the authentication failure and retry with
  backoff without generating a new proposal.
- **Base branch changes during delivery:** run the conflict guard and reconcile
  before release; never merge stale code silently.
- **Branch protection requires human approval:** expose the blocking policy and
  keep retrying release without consuming model turns.
- **Independent RM worker observes the PR:** campaign marker causes the webhook
  dispatcher and polling reconciler to skip it.
- **API pod restarts after remote mutation but before local commit:** recover by
  querying the deterministic branch, pull request, build, or preview identifier
  before creating anything.
- **Unknown model price at creation:** reject the configuration with a clear
  validation error.
- **Pricing row is removed mid-campaign:** enter `waiting_for_external` and block
  the next model turn until pricing is restored.
- **Proposal becomes obsolete while delivery runs:** finish or retry the accepted
  proposal unless it becomes impossible or unsafe; do not replace it silently.
- **Pause arrives during image build or deployment:** stop scheduling new stages,
  show `pausing`, and transition to `paused` when the external operation reaches a
  cancellable boundary.
- **Stop arrives after merge but before cycle commit:** reconcile the base SHA,
  record the successful merge, then stop before creating the next cycle.
- **Two API processes start:** only the process holding the unexpired SQLite
  campaign lease may transition that campaign.

## Error Handling

- Every campaign error is stored with stage, attempt, timestamp, and a
  human-readable message.
- External-call failures are explicit and use bounded exponential backoff.
- No broad catch may convert an error into a successful cycle.
- State transitions use transactions and compare the expected prior state.
- Invalid transitions return `409 Conflict`.
- Missing campaigns return `404`.
- Unauthorized mutations return `401` or `403` through existing auth patterns.
- Socket.IO publication failure does not roll back durable state; the portal
  recovers from the REST snapshot.
- Failure to renew a lease stops local execution immediately.

## Non-Functional Requirements

- **Durability:** A committed campaign transition survives process and cluster
  restart on the existing SQLite/PVC deployment.
- **Idempotency:** Replaying any coordinator tick does not duplicate external or
  local resources.
- **Concurrency:** One active cycle per campaign and one active campaign per
  repository/base branch.
- **Cost control:** Turn, wall-clock, and estimated-cost checks occur before
  scheduling another model action.
- **Alerting:** Consecutive failure and cumulative-cost thresholds emit durable
  portal events but do not pause or stop the campaign.
- **Observability:** Structured pino logs include campaign ID, cycle ID, attempt,
  stage, lease owner, and result.
- **Responsiveness:** Control endpoints acknowledge valid pause/stop requests in
  under two seconds under normal API load.
- **Security:** Mutation endpoints are admin-only; secrets and raw tokens never
  enter prompts, proposal evidence, or campaign logs. Repo-sourced evidence is
  explicitly treated as untrusted data.
- **Accessibility:** Portal controls and statuses meet WCAG 2.1 AA, support
  keyboard navigation, and do not rely on color alone.
- **Compatibility:** Existing task, workstream, CLI, and manual release behavior
  remain unchanged when no campaign is running.
- **Infrastructure:** No new Azure service or third-party workflow engine is
  introduced for the first version.

## Test Strategy

- Unit tests for campaign, cycle, attempt, lease, budget, transition, proposal
  fingerprint, and retry-backoff logic.
- Supertest coverage for campaign validation, RBAC, controls, conflict responses,
  and snapshots.
- Agent-runner tests for structured proposal output, critic rejection, evidence
  source assembly, prompt-injection isolation, and duplicate detection.
- Integration tests with fake clocks and mocked GitHub, Copilot SDK, ACR, and
  Kubernetes clients.
- Restart tests that interrupt each external mutation boundary and prove
  idempotent recovery.
- Release-authority tests proving RM webhook/reconciler workers skip campaign
  PRs and cannot merge while a campaign is paused.
- Gate tests proving coder self-verdict and task completion cannot produce a
  successful cycle without persisted reviewer acceptance and confirmed merge
  SHA.
- Web tests for campaign forms, controls, status rendering, budgets, evidence,
  and history.
- Cucumber scenarios for the complete campaign lifecycle and failure behavior.
- Playwright flow for create -> start -> proposal -> workstream -> successful
  release -> next cycle, using deterministic mocked external systems.
- Full regression of existing manual task, preview, reviewer, ship, discard,
  workstream, and authentication behavior.

## Research Notes

- Durable workflow patterns require persisted state, idempotent external
  activities, explicit retries, cancellation, and a single owner for each
  runnable workflow.
- The current single-writer SQLite/PVC architecture can support the first
  version without adding an external workflow service.
- Copilot SDK sessions remain execution workers, not the source of truth. The
  campaign, cycle, attempt, and remote-resource checkpoints live in SQLite.
- Campaign PRs require one merge authority. Existing RM webhook/reconciler
  dispatch is bypassed for marked campaign PRs.
- Per-attempt limits bound individual retries. The selected contract does not
  impose an aggregate stop; alerts preserve operator visibility while retries
  continue.
- The selected unrestricted auto-merge policy accepts that tests and LLM review
  may not catch every sensitive or security-relevant change.
- A future multi-replica or high-throughput version should revisit this decision
  and evaluate a dedicated workflow engine or Kubernetes-native controller.

## Out of Scope

- Running one campaign across multiple repositories.
- Running multiple feature cycles concurrently inside one campaign.
- Enabling campaigns automatically for every repository visible to the token.
- Autonomous repository deletion, secret disclosure, or irreversible data
  migration.
- A mandatory sensitive-path denylist or human approval gate for campaign PRs.
- Removing the operator's ability to pause or stop.
- Replacing the existing task pipeline with a second implementation engine.
- Adding Temporal, a new database, or Kubernetes custom resources in the first
  version.
