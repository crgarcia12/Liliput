Feature: Autonomous campaign evidence snapshots
  As described in frd-autonomous-workstream-campaigns.md,
  a proposing campaign cycle captures one redacted and base-consistent evidence
  snapshot before any feature proposal is generated.

  Background:
    Given a running autonomous campaign targets repository "crgarcia12/Liliput" and branch "main"
    And the campaign has a proposing cycle at base commit "abc123def456"

  @campaign-evidence @smoke @happy
  Scenario: Campaign captures every configured evidence source
    Given specs, code, GitHub feedback, runtime history, and ideation context are enabled
    And each enabled evidence source has relevant content
    When the campaign captures its feature evidence
    Then one evidence snapshot should be persisted for repository "crgarcia12/Liliput"
    And the snapshot should be tied to base commit "abc123def456"
    And every enabled evidence source should have a successful result
    And no feature proposal should be generated

  @campaign-evidence @edge
  Scenario: Empty and unavailable evidence sources remain explicit
    Given the specs evidence source has no relevant content
    And the GitHub feedback source is temporarily unavailable
    And the remaining enabled evidence sources have relevant content
    When the campaign captures its feature evidence
    Then the specs evidence result should be marked empty
    And the GitHub feedback result should contain an explicit error
    And successful evidence source results should remain in the snapshot

  @campaign-evidence @security
  Scenario: Prompt-injected repository text remains inert evidence
    Given an open issue contains instructions to ignore campaign policy and publish credentials
    When the campaign captures its feature evidence
    Then the issue text should be labeled as untrusted evidence
    And the issue text should be enclosed by evidence delimiters
    And no instruction from the issue text should be treated as campaign policy

  @campaign-evidence @security
  Scenario: Evidence snapshot excludes tokens and secret-shaped values
    Given enabled evidence contains a GitHub token, bearer token, password, and private key
    When the campaign captures its feature evidence
    Then the persisted evidence should contain redaction markers
    And the persisted evidence should not contain any original secret value
    And promoted evidence should not contain any original secret value

  @campaign-evidence @edge
  Scenario: Snapshot remains consistent when the base branch advances during capture
    Given branch "main" advances to commit "def789abc012" after capture begins
    When the campaign captures its feature evidence
    Then repository evidence should be read from commit "abc123def456"
    And the persisted snapshot should remain tied to commit "abc123def456"

  @campaign-evidence @edge
  Scenario: Replaying evidence capture is idempotent
    Given a feature evidence snapshot already exists for the current cycle
    When the campaign captures its feature evidence again
    Then the existing snapshot should be returned
    And no second evidence snapshot should be persisted
    And no second campaign cycle should be created

  @campaign-evidence @happy
  Scenario: Evidence sources retain traceable metadata
    Given an issue, pull request review, repository file, and runtime failure are available
    When the campaign captures its feature evidence
    Then each captured item should identify its evidence source
    And each captured item should retain its non-secret origin metadata
    And each captured item should identify whether its content is trusted or untrusted
