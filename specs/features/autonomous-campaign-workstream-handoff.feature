Feature: Autonomous campaign workstream handoff
  As described in frd-autonomous-workstream-campaigns.md,
  an accepted campaign proposal becomes exactly one normal Liliput workstream
  and task that runs through the existing delivery pipeline.

  Background:
    Given a coordinator-owned running campaign targets repository "crgarcia12/Liliput" and branch "main"
    And feature cycle 3 has an accepted proposal for "Explain failed preview health checks"

  @campaign-workstream-handoff @happy @smoke
  Scenario: Accepted proposal creates one serial workstream
    When the coordinator hands the accepted proposal to delivery
    Then exactly one campaign workstream should exist for feature cycle 3
    And exactly one campaign task should exist in that workstream
    And the task intent and specification should contain the accepted proposal
    And feature cycle 3 should retain the workstream and task identifiers

  @campaign-workstream-handoff @happy
  Scenario: Existing delivery pipeline executes the campaign task
    Given the accepted proposal has been handed to one campaign task
    When the task reaches the normal review stage
    Then the task should have used the existing specification, build, test, preview, and review stages
    And feature cycle 3 should be ready for campaign release review
    And the cycle should retain its branch, image, preview, and pull request identifiers

  @campaign-workstream-handoff @edge @serial
  Scenario: A non-terminal campaign task blocks the next feature cycle
    Given the campaign task is still building the accepted feature
    When the coordinator looks for another runnable feature cycle
    Then feature cycle 3 should remain the campaign's only active cycle
    And no workstream or task should be created for feature cycle 4

  @campaign-workstream-handoff @edge @concurrency
  Scenario: Active delivery renews the coordinator lease
    Given coordinator "api-pod-a" owns the campaign lease
    And the campaign task is still running
    When coordinator "api-pod-a" renews the lease during delivery
    Then coordinator "api-pod-a" should remain the active campaign owner
    And the renewed lease should expire later than the previous lease

  @campaign-workstream-handoff @error @concurrency
  Scenario: Another coordinator cannot advance a renewed campaign
    Given coordinator "api-pod-a" renewed the campaign lease during delivery
    When coordinator "api-pod-b" tries to advance feature cycle 3 before the renewed lease expires
    Then coordinator "api-pod-b" should be rejected as a conflicting coordinator
    And the existing workstream and task should remain unchanged

  @campaign-workstream-handoff @edge @idempotency
  Scenario: Replaying delivery handoff does not duplicate local resources
    Given feature cycle 3 already retains its campaign workstream and task identifiers
    When the coordinator hands the accepted proposal to delivery again
    Then the existing campaign workstream should be returned
    And the existing campaign task should be returned
    And the cycle should still have exactly one workstream and one task

  @campaign-workstream-handoff @edge @recovery
  Scenario: Restart after workstream creation reuses that workstream
    Given delivery stopped after the campaign workstream was created
    And no campaign task was linked before the control plane stopped
    When the Liliput control plane restarts and resumes the handoff
    Then the existing campaign workstream should be reused
    And exactly one campaign task should be created and linked
    And no replacement workstream should be created

  @campaign-workstream-handoff @edge @recovery
  Scenario: Restart recovers persisted delivery resources
    Given the campaign task already has a branch, image, preview, and pull request
    And the control plane stops before feature cycle 3 records those identifiers
    When the Liliput control plane restarts and reconciles the active cycle
    Then the cycle should recover the existing task identifier
    And the cycle should recover the existing branch, image, preview, and pull request identifiers
    And no second workstream, task, branch, image, preview, or pull request should be created

  @campaign-workstream-handoff @happy @completion
  Scenario: Normal review state is detected as delivery completion
    Given the campaign task has a healthy preview and is awaiting release review
    When the coordinator checks the existing task pipeline
    Then feature cycle 3 should be ready for campaign release review
    And the accepted proposal should remain the current campaign feature
    And no next feature cycle should begin

  @campaign-workstream-handoff @error @release
  Scenario: Task completion is not confirmed merge success
    Given the campaign task reports completed
    And the base branch does not contain a confirmed merge for feature cycle 3
    When the coordinator checks the existing task pipeline
    Then feature cycle 3 should not be marked successful
    And no next feature cycle should begin
    And the cycle should remain pending campaign release confirmation

  @campaign-workstream-handoff @error @completion
  Scenario: Failed delivery remains attached to the same feature
    Given the campaign task reports a build failure
    When the coordinator checks the existing task pipeline
    Then the delivery failure should be recorded on feature cycle 3
    And the accepted proposal, workstream, and task should remain linked
    And no replacement proposal or next feature cycle should be created

  @campaign-workstream-handoff @happy @regression
  Scenario: Manual task creation remains independent
    Given an operator creates a normal task outside an autonomous campaign
    When the campaign coordinator scans for active delivery work
    Then the manual task should not be claimed by the campaign
    And the manual task should retain its normal workstream and lifecycle
