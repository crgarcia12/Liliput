# ADR-002: Allow unrestricted campaign auto-merge after evidence gates

- **Status:** Accepted
- **Date:** 2026-07-21

## Context

Autonomous Workstream Campaigns consume repository code, documentation, issues,
pull-request feedback, review comments, and runtime logs. Some of that text is
untrusted and can contain incorrect instructions or prompt-injection attempts.

Campaigns are designed to run without a human approval step for every feature.
The operator selected automatic merge after normal tests, campaign reviewer
acceptance, healthy preview, conflict checks, and branch-policy checks.

A deterministic policy could additionally block sensitive files or actions, or
force human approval for them. That would reduce risk but would also interrupt
the requested continuous loop.

## Options Considered

### Option 1: Restrict autonomous changes to a deterministic safe scope

Reject or replace proposals that affect configured sensitive paths or actions.

**Advantages**

- Prevents autonomous changes to high-risk surfaces even when an LLM is misled.
- Keeps ordinary features fully autonomous.

**Disadvantages**

- Path rules are repository-specific and can reject legitimate features.
- Sensitive improvements can never complete without changing campaign policy.
- A late policy rejection may invalidate substantial completed work.

### Option 2: Require human approval for sensitive changes

Allow sensitive proposals and delivery, but pause before merge when a
deterministic policy marks the diff as high risk.

**Advantages**

- Preserves support for sensitive work while adding a non-LLM release gate.
- Reduces the impact of prompt injection or reviewer mistakes.

**Disadvantages**

- The campaign no longer runs continuously without human intervention.
- Operators must define and maintain sensitive-change policy.

### Option 3: Apply the same automatic gates to every change

Do not add category-based path restrictions or mandatory human approval. Treat
all campaign changes consistently under the normal test, reviewer, preview,
conflict, and branch-policy gates.

**Advantages**

- Matches the requested continuous autonomous loop.
- Avoids repository-specific policy configuration.
- Allows authentication, infrastructure, workflow, and permission features to
  complete autonomously.

**Disadvantages**

- Tests and LLM review may not detect every security or infrastructure risk.
- Untrusted issue or PR text can influence proposal and review agents.
- A valid but harmful change can auto-merge if the existing gates pass.
- Operators must actively monitor alerts, cycle evidence, and repository
  protections.

## Decision

Use **the same automatic release gates for every campaign change**. Do not add a
mandatory sensitive-path denylist or human approval gate in the first version.

The system still:

- labels and delimits untrusted evidence in prompts;
- removes tokens and secret-shaped values from evidence;
- prohibits repository deletion and secret disclosure;
- requires tests, persisted campaign reviewer acceptance, healthy preview,
  conflict checks, and confirmed base-branch merge;
- honors existing GitHub branch protection; and
- emits alerts after 3 consecutive failed attempts and USD 50 cumulative
  campaign cost.

Alerts do not pause or stop the campaign.

## Consequences

### Positive

- Campaigns can continue indefinitely without category-based human gates.
- All repository areas remain available for autonomous feature work.
- Policy configuration does not become a prerequisite for campaign creation.

### Negative

- The system deliberately accepts higher security and operational risk.
- LLM reviewers remain part of the release boundary for sensitive changes.
- Branch protection and test quality become more important.
- Operators may need to stop a campaign after an alert rather than relying on an
  automatic circuit breaker.

### Neutral

- Evidence sanitation and prompt-injection isolation are still required.
- Existing repository branch policies continue to apply.
- This decision can be superseded later with per-repository safe-scope rules.

## References

- [FRD: Autonomous Workstream Campaigns](../liliput/frd-autonomous-workstream-campaigns.md)
- [ADR-001: Use a SQLite-backed serial campaign coordinator](adr-001-use-sqlite-backed-serial-campaign-coordinator.md)
