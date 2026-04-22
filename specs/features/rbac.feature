@rbac @admin @roles @authorization
Feature: Role-Based Access Control (RBAC)
  As a system administrator
  I want role-based access control with admin and user roles
  So that only authorized users can access administrative features

  Background:
    Given the user store is empty

  # ── Role Assignment ──────────────────────────────────────────────

  @roles
  Scenario: First registered user receives admin role
    When I register with username "alice" and password "SecurePass1!"
    Then the response status should be 201
    And the response JSON should include role "admin"
    And the JWT payload should include role "admin"

  @roles
  Scenario: Subsequent registered users receive user role
    Given a registered user "alice" with password "SecurePass1!"
    When I register with username "bob" and password "SecurePass2!"
    Then the response status should be 201
    And the response JSON should include role "user"
    And the JWT payload should include role "user"

  # ── Admin API: GET /api/admin/users ──────────────────────────────

  @admin @api
  Scenario: Admin retrieves user list successfully
    Given a registered admin "alice" with password "SecurePass1!"
    And a registered user "bob" with password "SecurePass2!"
    And I am logged in as "alice" with password "SecurePass1!"
    When I send a GET request to "/api/admin/users"
    Then the response status should be 200
    And the response should be a JSON array with 2 entries
    And each entry should have "username", "role", and "createdAt" fields

  @admin @api
  Scenario: Unauthenticated request to admin endpoint returns 401
    When I send a GET request to "/api/admin/users" without a JWT
    Then the response status should be 401
    And the response JSON should include error "Not authenticated"

  @admin @api
  Scenario: Non-admin user is forbidden from admin endpoint
    Given a registered admin "alice" with password "SecurePass1!"
    And a registered user "bob" with password "SecurePass2!"
    And I am logged in as "bob" with password "SecurePass2!"
    When I send a GET request to "/api/admin/users"
    Then the response status should be 403
    And the response JSON should include error "Forbidden"

  @admin @api
  Scenario: Admin user list response does not expose sensitive fields
    Given a registered admin "alice" with password "SecurePass1!"
    And I am logged in as "alice" with password "SecurePass1!"
    When I send a GET request to "/api/admin/users"
    Then the response status should be 200
    And no entry should have a "passwordHash" field
    And no entry should have an "id" field

  # ── Admin Dashboard UI (/admin) ─────────────────────────────────

  @admin @ui
  Scenario: Admin sees user management table on dashboard
    Given a registered admin "alice" with password "SecurePass1!"
    And a registered user "bob" with password "SecurePass2!"
    And I am logged in as "alice" with password "SecurePass1!"
    When I navigate to "/admin"
    Then I should see a table with columns "Username", "Role", and "Member Since"
    And the table should contain a row with username "alice" and role "admin"
    And the table should contain a row with username "bob" and role "user"

  @admin @ui
  Scenario: Non-admin user sees access denied on admin dashboard
    Given a registered admin "alice" with password "SecurePass1!"
    And a registered user "bob" with password "SecurePass2!"
    And I am logged in as "bob" with password "SecurePass2!"
    When I navigate to "/admin"
    Then I should see the text "Access Denied"
    And I should see the text "You do not have permission to view this page."

  @admin @ui
  Scenario: Unauthenticated user is redirected to login from admin dashboard
    When I navigate to "/admin"
    Then I should be redirected to "/login"

  @admin @ui
  Scenario: Admin dashboard shows loading state while fetching users
    Given a registered admin "alice" with password "SecurePass1!"
    And I am logged in as "alice" with password "SecurePass1!"
    When I navigate to "/admin"
    Then I should see the text "Loading users..." before the table appears

  # ── JWT Role Integrity ──────────────────────────────────────────

  @authorization @api
  Scenario: Tampered JWT with forged admin role is rejected
    Given a registered admin "alice" with password "SecurePass1!"
    And a registered user "bob" with password "SecurePass2!"
    And I have a tampered JWT for "bob" with role "admin"
    When I send a GET request to "/api/admin/users" with the tampered JWT
    Then the response status should be 401
    And the response JSON should include error "Not authenticated"

  # ── Profile Shows Role ──────────────────────────────────────────

  @roles @ui
  Scenario Outline: Profile page displays the user's assigned role
    Given a registered admin "alice" with password "SecurePass1!"
    And a registered user "bob" with password "SecurePass2!"
    And I am logged in as "<username>" with password "<password>"
    When I navigate to "/profile"
    Then I should see the role displayed as "<role>"

    Examples:
      | username | password     | role  |
      | alice    | SecurePass1! | admin |
      | bob      | SecurePass2! | user  |
