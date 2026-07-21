@autonomous-workstream-campaigns @ext-pre-001
Feature: Durable autonomous campaign coordination
  As described in frd-autonomous-workstream-campaigns.md,
  autonomous campaign state must survive restarts and permit exactly one
  coordinator to advance one feature cycle at a time.

  @smoke @happy
  Scenario: Campaign state survives a control-plane restart
    Given an autonomous campaign for repository "crgarcia12/podcast-generator" on branch "main"
    And the campaign is running feature cycle 4 for "Add searchable transcripts"
    And delivery attempt 2 is waiting to retry
    When the Liliput control plane restarts
    Then the campaign should still be running feature cycle 4
    And the accepted feature should still be "Add searchable transcripts"
    And delivery attempt 2 should still be waiting to retry

  @edge @concurrency
  Scenario: Only one coordinator owns an unexpired campaign lease
    Given a runnable autonomous campaign with no current coordinator
    When coordinator "api-pod-a" claims the campaign
    And coordinator "api-pod-b" tries to claim it before the lease expires
    Then coordinator "api-pod-a" should remain the campaign owner
    And coordinator "api-pod-b" should not be allowed to advance the campaign

  @edge @recovery
  Scenario: Another coordinator takes over an expired campaign lease
    Given coordinator "api-pod-a" owns a campaign lease that has expired
    When coordinator "api-pod-b" claims the campaign
    Then coordinator "api-pod-b" should become the campaign owner
    And coordinator "api-pod-a" should no longer be allowed to advance the campaign

  @error @uniqueness
  Scenario: A second active campaign for the same repository branch is rejected
    Given an active autonomous campaign for repository "crgarcia12/liliput" on branch "main"
    When an administrator creates another campaign for repository "crgarcia12/liliput" on branch "main"
    Then the new campaign should be rejected as a conflict
    And the original campaign should remain unchanged

  @edge @uniqueness
  Scenario: A stopped campaign does not block a replacement campaign
    Given a stopped autonomous campaign for repository "crgarcia12/liliput" on branch "main"
    When an administrator creates a new campaign for repository "crgarcia12/liliput" on branch "main"
    Then the new campaign should be created in draft state

  @error @serial
  Scenario: A campaign cannot own two active feature cycles
    Given an autonomous campaign has an active cycle for "Add repository health history"
    When the coordinator tries to start another cycle for "Add deployment cost trends"
    Then the second cycle should be rejected as a conflict
    And "Add repository health history" should remain the active cycle

  @edge @idempotency
  Scenario: Replaying a successful transition does not duplicate state
    Given a campaign transition with idempotency key "campaign-7-cycle-3-attempt-1"
    And the transition already created delivery attempt 1
    When the same transition is replayed with the same idempotency key
    Then the campaign should still contain exactly one delivery attempt 1
    And the campaign state should match the first transition result

  @error @state-machine
  Scenario: A transition from a stale expected state is rejected
    Given an autonomous campaign is paused
    When a coordinator tries to move it from running to stopped
    Then the transition should be rejected as a conflict
    And the campaign should remain paused

  @edge @retry
  Scenario: Retry scheduling never exceeds the configured backoff cap
    Given a failed delivery attempt already has a retry delay of 60 minutes
    And the campaign retry backoff cap is 60 minutes
    When another failed attempt is recorded for the same feature
    Then the next retry delay should be 60 minutes
    And the same accepted feature should remain current

  @edge @cost
  Scenario: Replayed usage evidence is counted once
    Given delivery attempt 3 has recorded usage event "usage-call-42"
    When usage event "usage-call-42" is received again
    Then the attempt turn count should not increase
    And the attempt estimated cost should not increase

  @happy @regression
  Scenario: Existing manual tasks remain readable after campaign storage is added
    Given a manually created workstream and task existed before autonomous campaigns were introduced
    When the Liliput control plane starts with campaign storage enabled
    Then the existing workstream should still be readable
    And the existing task should retain its status and history
