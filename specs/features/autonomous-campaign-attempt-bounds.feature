Feature: Autonomous campaign attempt bounds and interruption
  As described in frd-autonomous-workstream-campaigns.md,
  each campaign delivery attempt is bounded while pause, stop, retry, and
  restart preserve the accepted feature and its durable delivery evidence.

  Background:
    Given a coordinator-owned bounded-attempt campaign targets repository "crgarcia12/Liliput" and branch "main"
    And its feature cycle 5 is delivering the accepted proposal "Explain failed preview health checks"
    And delivery attempt 2 is active for that bounded feature cycle

  @campaign-attempt-bounds @happy @smoke
  Scenario Outline: Attempt limit blocks another model action
    Given delivery attempt 2 has reached its configured "<limit>" limit
    When the coordinator evaluates the attempt before another model action
    Then no additional model action should be scheduled
    And delivery attempt 2 should end as bounded by "<limit>"
    And feature cycle 5 should wait to retry the same accepted proposal

    Examples:
      | limit         |
      | turn count    |
      | elapsed time  |
      | estimated cost|

  @campaign-attempt-bounds @error @retry
  Scenario: Failed attempt retries the same feature after backoff
    Given delivery attempt 2 failed during the build stage
    And the attempt records its turns, elapsed time, estimated cost, and failure message
    When the coordinator schedules the next delivery attempt
    Then feature cycle 5 should enter "retry_wait"
    And its retry time should use exponential backoff
    And the accepted proposal, workstream, task, and delivery checkpoints should remain linked
    And the next attempt should resume the same accepted proposal

  @campaign-attempt-bounds @edge @retry
  Scenario: Repeated failures keep retrying with a capped delay
    Given feature cycle 5 has failed enough attempts to reach the 60 minute retry cap
    When another delivery attempt fails for the same accepted proposal
    Then the next retry delay should remain 60 minutes
    And another attempt should remain eligible after that delay
    And no replacement proposal or subsequent feature cycle should be created

  @campaign-attempt-bounds @edge @external-wait
  Scenario: Infrastructure wait does not spend model budget
    Given delivery attempt 2 is waiting for unavailable preview infrastructure
    When 30 minutes pass without a model action
    Then the attempt turn count should remain unchanged
    And the attempt estimated cost should remain unchanged
    And feature cycle 5 should remain "waiting_for_external"
    And the same attempt should remain resumable when infrastructure recovers

  @campaign-attempt-bounds @happy @pause
  Scenario Outline: Pause interrupts work at the next safe boundary
    Given delivery attempt 2 is active in the "<stage>" stage
    When an administrator pauses the campaign
    Then the pause request should be acknowledged without scheduling another stage
    And active work should be interrupted at the next cancellable boundary
    And the campaign and feature cycle 5 should become "paused"
    And the accepted proposal and all delivery evidence should remain intact

    Examples:
      | stage       |
      | agent turn  |
      | image build |
      | deployment  |
      | review      |

  @campaign-attempt-bounds @happy @pause @recovery
  Scenario: Paused delivery resumes the same attempt after restart
    Given the campaign was paused during delivery attempt 2
    And the Liliput control plane restarts while the paused attempt is persisted
    When an administrator resumes the campaign
    Then feature cycle 5 should remain the current cycle
    And delivery attempt 2 should resume from its persisted safe boundary
    And its prior turns, elapsed time, estimated cost, and checkpoints should be retained
    And no new proposal, workstream, task, or branch should be created

  @campaign-attempt-bounds @happy @stop
  Scenario: Stopped campaign schedules no future work
    Given feature cycle 5 is waiting to retry delivery attempt 2
    When an administrator stops the campaign
    Then the campaign and feature cycle 5 should become "stopped"
    And no retry should remain scheduled
    And no future attempt or feature cycle should be created
    And the proposal, branch, pull request, preview, task, and attempt evidence should remain inspectable

  @campaign-attempt-bounds @edge @recovery
  Scenario: Restart during retry wait creates only the due attempt
    Given feature cycle 5 is waiting until a persisted retry time
    And the Liliput control plane restarts before that retry time
    When the persisted retry time arrives
    Then exactly one next attempt should start for feature cycle 5
    And it should use the same accepted proposal and delivery resources
    And replaying startup reconciliation should not create another attempt

  @campaign-attempt-bounds @error @observability
  Scenario: Attempt failure retains its exact stage and usage
    Given delivery attempt 2 has recorded model usage
    When an external call fails during the deployment stage
    Then delivery attempt 2 should record status "failed"
    And it should record failure stage "deployment"
    And it should retain the failure message, timestamp, turns, elapsed time, and estimated cost
    And the failure should not be converted into a successful cycle

  @campaign-attempt-bounds @edge @configuration
  Scenario: Changed limits apply to the next attempt
    Given delivery attempt 2 started with limits of 500 turns, 240 minutes, and 250 US dollars
    When an administrator lowers the campaign limits during that attempt
    And the current attempt fails and its retry becomes due
    Then delivery attempt 2 should retain the limits it started with
    And the lowered limits should apply when the next attempt starts
