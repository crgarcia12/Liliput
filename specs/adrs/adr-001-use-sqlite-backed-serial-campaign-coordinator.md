# ADR-001: Use a SQLite-backed serial campaign coordinator

- **Status:** Accepted
- **Date:** 2026-07-21

## Context

Liliput already runs as a single API writer with SQLite and cloned workspaces on
a persistent volume. Its existing engine can deliver one task through planning,
implementation, tests, preview deployment, review, and release. Its optional
decomposition path persists feature records but does not execute them.

Autonomous Workstream Campaigns require a durable loop that:

- runs one feature at a time for one selected repository;
- survives API pod and AKS restarts;
- avoids duplicate workstreams, tasks, branches, builds, previews, and PRs;
- supports operator pause, resume, and stop;
- bounds each attempt while retrying the campaign indefinitely; and
- reuses the existing task pipeline.

The first version should not add infrastructure unless the current architecture
cannot meet these requirements.

## Options Considered

### Option 1: SQLite-backed coordinator inside the Liliput API

Persist campaigns, cycles, attempts, leases, checkpoints, and remote resource
IDs in the existing SQLite database. Run an idempotent scheduler in the API
process and treat Copilot SDK sessions as ephemeral execution workers.

**Advantages**

- Fits the current single-writer deployment and existing persistence model.
- Adds no service, package, credential, or operational dependency.
- Can reuse current stores, task pipeline, Socket.IO, auth, and portal.
- Supports restart recovery through explicit checkpoints and deterministic IDs.

**Disadvantages**

- Long-running coordination remains coupled to the API process.
- SQLite and one API writer limit horizontal scaling and throughput.
- Leases and idempotent recovery must be implemented correctly in application
  code.
- A future multi-replica design may require migration.

### Option 2: Temporal workflow engine

Model each campaign as a durable Temporal workflow with activities for proposal,
task delivery, release, cooldown, and operator signals.

**Advantages**

- Native durable workflow history, retries, timers, signals, and cancellation.
- Strong fit for long-running workflows and worker restarts.
- Better path to multiple workers and higher throughput.

**Disadvantages**

- Adds a new control-plane service and production database.
- Requires new deployment, backup, monitoring, credentials, and operational
  expertise.
- Duplicates some state and observability already present in Liliput.
- Significantly increases the first increment's scope.

### Option 3: Kubernetes controller and custom resources

Represent campaigns and cycles as Kubernetes custom resources and reconcile them
with a controller using Kubernetes Lease objects.

**Advantages**

- Native declarative reconciliation and leader-election primitives.
- Strong visibility through Kubernetes APIs.
- Natural fit for AKS-hosted execution resources.

**Disadvantages**

- Couples product state to cluster availability.
- Requires CRDs, controller RBAC, versioned schemas, and migration handling.
- Makes local development and non-AKS operation harder.
- Workstream, user, cost, and portal state would still need database linkage.

## Decision

Use a **SQLite-backed serial campaign coordinator inside the Liliput API** for
the first version.

SQLite is the source of truth for campaign, cycle, and attempt state. The
coordinator claims campaigns through renewable leases and advances them through
transactional, expected-state transitions. Every external mutation uses a
deterministic idempotency key or a persisted remote resource ID.

Copilot SDK sessions are not the durable workflow record. They execute bounded
agent turns; the coordinator persists checkpoints before and after those turns.

Only one active cycle is permitted per campaign, and only one non-stopped
campaign is permitted per repository/base branch.

## Consequences

### Positive

- The feature can be delivered incrementally without adding infrastructure.
- Existing task, preview, review, and release behavior remains the single
  delivery engine.
- Campaigns can recover after pod and cluster restarts using the existing PVC.
- Operator controls and evidence can use the current API, Web, and Socket.IO
  architecture.

### Negative

- The API remains a single-writer control plane.
- Correctness depends on application-level leases, transactions, and idempotent
  adapters.
- Long-running scheduling increases API-process responsibility.
- High campaign volume or horizontal API scaling will require revisiting this
  decision.

### Neutral

- New additive SQLite tables and shared types are required.
- Existing manual task and decomposition modes remain unchanged.
- No new Azure resource or npm dependency is introduced.

## Revisit Conditions

Re-evaluate Temporal or a Kubernetes controller when any of these become true:

- Liliput supports multiple active API replicas;
- campaign throughput exceeds the single-writer model;
- campaign history or timers become operationally difficult to maintain;
- non-AKS workers need independent scaling; or
- workflow migrations require versioned execution semantics beyond the internal
  state machine.

## References

- [FRD: Autonomous Workstream Campaigns](../liliput/frd-autonomous-workstream-campaigns.md)
- [Temporal worker deployment guidance](https://docs.temporal.io/production-deployment/worker-deployments)
- [Kubernetes Lease API](https://kubernetes.io/docs/concepts/architecture/leases/)
- [GitHub Copilot SDK streaming events](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events)
