@health @smoke
Feature: Liliput health endpoint
  As an operator I want a smoke test that confirms the Liliput API is up
  and reporting a recognizable version, so CI catches outages or broken
  builds before they reach prod.

  Scenario: GET /api/health returns liliput-api with a version
    When I send a GET request to "/api/health"
    Then the health response status should be 200
    And the health response service should be "liliput-api"
    And the health response should include a version string
