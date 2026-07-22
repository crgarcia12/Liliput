Feature: Autonomous campaign feature proposals
  As described in frd-autonomous-workstream-campaigns.md,
  a proposing campaign cycle uses its persisted evidence to generate candidates,
  obtain a separate critic decision, and persist at most one accepted feature.

  Background:
    Given a running autonomous campaign targets repository "crgarcia12/Liliput" and branch "main"
    And the campaign has a proposing cycle at base commit "abc123def456"

  @campaign-proposal @happy @smoke
  Scenario: Meta-agent evidence produces one accepted medium feature
    Given the cycle has a persisted evidence snapshot covering every configured source
    And the meta-agent proposes a medium feature to explain failed preview health checks
    And the critic selects that feature as useful, testable, reversible, and non-duplicate
    When the campaign generates and critiques feature proposals
    Then one accepted proposal should be persisted on the current cycle
    And the accepted proposal should include problem, evidence, users, value, scope, non-goals, acceptance criteria, components, tests, risks, rollback, size, and fingerprint
    And the proposal should reference the persisted evidence snapshot and base commit
    And no workstream or task should be created

  @campaign-proposal @happy
  Scenario: Critic selects one candidate from a structured candidate set
    Given the cycle has a persisted evidence snapshot covering every configured source
    And the meta-agent returns three structured feature candidates
    And the critic selects the second candidate
    When the campaign generates and critiques feature proposals
    Then the second candidate should be the only accepted proposal
    And the meta-agent and critic decisions should be retained in proposal history

  @campaign-proposal @security
  Scenario Outline: Critic rejects prohibited or unverifiable work
    Given the cycle has a persisted evidence snapshot covering every configured source
    And the meta-agent proposes a feature that "<violation>"
    And the critic rejects the candidate for policy reason "<reason>"
    When the campaign generates and critiques feature proposals
    Then no accepted proposal should be persisted
    And the rejected candidate should be recorded with reason "<reason>"
    And no workstream or task should be created

    Examples:
      | violation                                      | reason                  |
      | deletes the target repository                  | repository-deletion     |
      | discloses repository or runtime secrets        | secret-disclosure       |
      | disables an existing security control          | security-weakening      |
      | removes or bypasses existing tests              | test-weakening          |
      | requires an irreversible production migration  | irreversible-change     |
      | cannot be verified by tests or a healthy preview| untestable              |
      | exceeds one medium serial delivery cycle        | oversized               |

  @campaign-proposal @edge
  Scenario: Sensitive files are not category-blocked
    Given the cycle has a persisted evidence snapshot covering every configured source
    And the meta-agent proposes a medium authentication workflow improvement
    And the critic finds it useful, testable, reversible, and non-duplicate
    When the campaign generates and critiques feature proposals
    Then the proposal should not be rejected only because authentication or workflow files are affected
    And one accepted proposal should be persisted for normal release gates

  @campaign-proposal @edge
  Scenario: Critic rejects a feature already delivered by the campaign
    Given the cycle has a persisted evidence snapshot covering every configured source
    And a previously merged campaign feature has the same normalized fingerprint
    And the meta-agent proposes the equivalent feature with different casing and whitespace
    When the campaign generates and critiques feature proposals
    Then the candidate should be rejected as a duplicate
    And no accepted proposal should be persisted
    And the duplicate decision should be recorded in proposal history

  @campaign-proposal @edge
  Scenario: Normalized proposal fingerprints are deterministic
    Given two candidates describe the same problem and scope with different casing, spacing, and list order
    When their proposal fingerprints are calculated
    Then both candidates should have the same proposal fingerprint
    And materially different scope should produce a different proposal fingerprint

  @campaign-proposal @error
  Scenario: All rejected candidates remain inspectable without starting delivery
    Given the cycle has a persisted evidence snapshot covering every configured source
    And every structured candidate is rejected by the critic
    When the campaign generates and critiques feature proposals
    Then no accepted proposal should be persisted
    And every rejected candidate and reason should remain in proposal history
    And the current cycle should remain in "proposing" status
    And no workstream or task should be created

  @campaign-proposal @edge
  Scenario: Replaying accepted proposal generation is idempotent
    Given the current cycle already has an accepted feature proposal
    When the campaign generates and critiques feature proposals again
    Then the existing accepted proposal should be returned
    And neither the meta-agent nor critic should run again
    And no second campaign cycle should be created

  @campaign-proposal @error
  Scenario: Proposal generation requires persisted evidence
    Given the current cycle has no persisted evidence snapshot
    When the campaign tries to generate feature proposals
    Then proposal generation should fail with an evidence-required error
    And neither the meta-agent nor critic should run
    And no accepted proposal, workstream, or task should be persisted

  @campaign-proposal @error
  Scenario: Invalid structured agent output cannot mutate the cycle
    Given the cycle has a persisted evidence snapshot covering every configured source
    And the meta-agent returns output that does not match the candidate schema
    When the campaign generates and critiques feature proposals
    Then proposal generation should fail with a structured-output error
    And the cycle should retain no accepted proposal or proposal fingerprint
    And no workstream or task should be created
