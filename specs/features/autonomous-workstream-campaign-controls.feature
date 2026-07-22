Feature: Autonomous workstream campaign controls
  As described in frd-autonomous-workstream-campaigns.md, administrators can
  configure and control one durable autonomous campaign per repository branch.

  Background:
    Given verified pricing exists for model "gpt-5.4"
    And repository "crgarcia12/Liliput" has accessible branch "main"

  @campaign-controls @happy @smoke
  Scenario: Administrator creates a draft campaign with explicit limits
    Given I am an authenticated administrator
    And campaign configuration targets repository "crgarcia12/Liliput" and branch "main"
    And I select model "gpt-5.4" for meta-agent, coding, and review work
    And I set limits of 7 turns, 30 minutes, and 5 US dollars
    When I submit the campaign configuration
    Then the campaign should be created in "draft" status
    And the campaign should preserve the selected models and limits

  @campaign-controls @happy @smoke
  Scenario: Administrator starts a draft campaign without invoking an agent
    Given I am an authenticated administrator
    And a draft campaign exists for repository "crgarcia12/Liliput" and branch "main"
    When I start the campaign
    Then the campaign should be "running"
    And its first cycle should be "proposing"
    And no campaign attempt should exist

  @campaign-controls @happy
  Scenario: Administrator pauses and resumes the same campaign cycle
    Given I am an authenticated administrator
    And a running campaign has a cycle in "proposing" status
    When I pause the campaign
    Then the campaign should be "paused"
    And its current cycle should be "paused"
    When I resume the campaign
    Then the campaign should be "running"
    And the same cycle should return to "proposing"

  @campaign-controls @happy
  Scenario: Administrator permanently stops a running campaign
    Given I am an authenticated administrator
    And a running campaign has a cycle in "proposing" status
    When I stop the campaign
    Then the campaign should be "stopped"
    And its current cycle should be "stopped"
    And the campaign should not offer a start or resume action

  @campaign-controls @happy
  Scenario: Administrator lists campaigns and opens campaign details
    Given I am an authenticated administrator
    And a draft campaign exists for repository "crgarcia12/Liliput" and branch "main"
    When I list autonomous campaigns
    Then the campaign list should include repository "crgarcia12/Liliput" and branch "main"
    When I open that campaign
    Then I should see its status, models, limits, cycle, attempts, cost, and timestamps

  @campaign-controls @error
  Scenario: Non-administrator cannot access campaign controls
    Given I am an authenticated non-administrator
    When I request the autonomous campaign list
    Then access should be denied with an administrator-only error
    When I try to create a campaign
    Then access should be denied with an administrator-only error

  @campaign-controls @error
  Scenario: Campaign creation rejects an inaccessible branch
    Given I am an authenticated administrator
    And repository "crgarcia12/Liliput" does not have accessible branch "missing-branch"
    And campaign configuration targets repository "crgarcia12/Liliput" and branch "missing-branch"
    And I select model "gpt-5.4" for meta-agent, coding, and review work
    When I submit the campaign configuration
    Then campaign creation should fail with a branch validation error
    And no campaign should be persisted

  @campaign-controls @error
  Scenario: Campaign creation rejects a model without effective pricing
    Given I am an authenticated administrator
    And model "unpriced-campaign-model" has no verified effective price
    And campaign configuration targets repository "crgarcia12/Liliput" and branch "main"
    And I select model "unpriced-campaign-model" for meta-agent, coding, and review work
    When I submit the campaign configuration
    Then campaign creation should fail with a pricing validation error
    And no campaign should be persisted

  @campaign-controls @edge
  Scenario: Only one active campaign can target a repository branch
    Given I am an authenticated administrator
    And a running campaign exists for repository "crgarcia12/Liliput" and branch "main"
    When I create another campaign for repository "crgarcia12/Liliput" and branch "main"
    Then campaign creation should fail with an active campaign conflict
    And the active campaign status and cycle should remain unchanged

  @campaign-controls @a11y @ui
  Scenario: Campaign controls expose accessible labels and valid actions
    Given I am an authenticated administrator
    And a paused campaign exists for repository "crgarcia12/Liliput" and branch "main"
    When I open the Autonomy portal
    Then repository, branch, model, and budget inputs should have accessible labels
    And the campaign should offer only resume and stop actions
