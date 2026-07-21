@autonomous-workstream-campaigns @ext-pre-002
Feature: Priced models for bounded autonomous campaign cost
  As described in frd-autonomous-workstream-campaigns.md,
  autonomous campaigns may use only models whose cost can be calculated from
  verified pricing, without changing the behavior of manually created tasks.

  @error @pricing
  Scenario: Unpriced model cannot start an autonomous campaign
    Given model "unpriced-campaign-model" has no effective USD pricing
    When an administrator validates an autonomous campaign using model "unpriced-campaign-model"
    Then campaign validation should reject model "unpriced-campaign-model" as unpriced
    And no autonomous campaign should be created

  @smoke @happy @recovery
  Scenario: Restored model pricing resumes a waiting campaign
    Given an autonomous campaign cycle uses model "recoverable-campaign-model"
    And model "recoverable-campaign-model" has no effective USD pricing
    When the coordinator checks pricing before the next model turn
    Then the cycle should wait for external model pricing
    And the pricing wait should consume no model turns or estimated cost
    When an operator records effective USD pricing for model "recoverable-campaign-model"
    And the coordinator checks pricing before the next model turn
    Then the same cycle should resume running

  @happy @regression
  Scenario: Manual tasks may continue using an unpriced model
    Given model "manual-unpriced-model" has no effective USD pricing
    When a manually created task selects model "manual-unpriced-model"
    Then the manual task should retain model "manual-unpriced-model"
    And its usage should be reported as unpriced rather than zero-cost
