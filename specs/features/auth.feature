@auth
Feature: Authentication
  As a user I can register, log in, and log out so that I have a secure
  session managed via JWT cookies.

  FRD: specs/frd-auth.md
  User Stories: US-1 (Registration), US-2 (Login), US-5 (Logout)

  Background:
    Given the application is running
    And no users exist in the system

  # ──────────────────────────────────────────────
  # Registration — Happy Path
  # ──────────────────────────────────────────────

  @registration
  Scenario: Successful registration with valid credentials
    When I send a POST request to "/api/auth/register" with body:
      | username | password     |
      | jane_doe | secureP@ss1  |
    Then the response status should be 201
    And the response body should contain "message" with value "Registration successful"

  @registration @ui
  Scenario: Registration form redirects to login on success
    Given I am on the "/register" page
    When I fill in "Username" with "jane_doe"
    And I fill in "Password" with "secureP@ss1"
    And I click the "Register" button
    Then I should be redirected to "/login?registered=true"
    And I should see the message "Registration successful. Please log in."

  # ──────────────────────────────────────────────
  # Registration — Username Taken
  # ──────────────────────────────────────────────

  @registration
  Scenario: Registration fails when username already exists
    Given a user exists with username "jane_doe" and password "secureP@ss1"
    When I send a POST request to "/api/auth/register" with body:
      | username | password     |
      | jane_doe | otherPass99  |
    Then the response status should be 409
    And the response body should contain "error" with value "Username already exists"

  # ──────────────────────────────────────────────
  # Registration — Validation Errors
  # ──────────────────────────────────────────────

  @registration @validation
  Scenario Outline: Registration fails with invalid input
    When I send a POST request to "/api/auth/register" with body:
      | username   | password   |
      | <username> | <password> |
    Then the response status should be 400
    And the response body should contain "error" with value "<error>"

    Examples: Username validation
      | username                        | password    | error                                                                                               |
      |                                 | secureP@ss1 | Username is required                                                                                |
      | ab                              | secureP@ss1 | Username must be between 3 and 30 characters and contain only letters, numbers, and underscores     |
      | abcdefghijklmnopqrstuvwxyz12345 | secureP@ss1 | Username must be between 3 and 30 characters and contain only letters, numbers, and underscores     |
      | no spaces!                      | secureP@ss1 | Username must be between 3 and 30 characters and contain only letters, numbers, and underscores     |
      | user@name                       | secureP@ss1 | Username must be between 3 and 30 characters and contain only letters, numbers, and underscores     |

    Examples: Password validation
      | username | password | error                                    |
      | jane_doe |          | Password is required                     |
      | jane_doe | short    | Password must be at least 8 characters   |

  @registration @validation
  Scenario: Registration validates username before password (first error only)
    When I send a POST request to "/api/auth/register" with body:
      | username | password |
      |          |          |
    Then the response status should be 400
    And the response body should contain "error" with value "Username is required"

  # ──────────────────────────────────────────────
  # Login — Happy Path
  # ──────────────────────────────────────────────

  @login
  Scenario: Successful login returns JWT cookie
    Given a user exists with username "jane_doe" and password "secureP@ss1"
    When I send a POST request to "/api/auth/login" with body:
      | username | password    |
      | jane_doe | secureP@ss1 |
    Then the response status should be 200
    And the response body should contain "message" with value "Login successful"
    And the response should set a cookie "token" with HttpOnly flag
    And the response should set a cookie "token" with Secure flag
    And the response should set a cookie "token" with SameSite "Strict"
    And the response should set a cookie "token" with Path "/"
    And the response should set a cookie "token" with Max-Age 86400

  @login @ui
  Scenario: Login form redirects to profile on success
    Given a user exists with username "jane_doe" and password "secureP@ss1"
    And I am on the "/login" page
    When I fill in "Username" with "jane_doe"
    And I fill in "Password" with "secureP@ss1"
    And I click the "Log in" button
    Then I should be redirected to "/profile"

  # ──────────────────────────────────────────────
  # Login — Invalid Credentials
  # ──────────────────────────────────────────────

  @login
  Scenario: Login fails with wrong password
    Given a user exists with username "jane_doe" and password "secureP@ss1"
    When I send a POST request to "/api/auth/login" with body:
      | username | password      |
      | jane_doe | wrongPassword |
    Then the response status should be 401
    And the response body should contain "error" with value "Invalid username or password"

  @login
  Scenario: Login fails with non-existent username
    When I send a POST request to "/api/auth/login" with body:
      | username     | password    |
      | unknown_user | secureP@ss1 |
    Then the response status should be 401
    And the response body should contain "error" with value "Invalid username or password"

  @login @security
  Scenario: Login returns the same error for wrong password and non-existent user
    Given a user exists with username "jane_doe" and password "secureP@ss1"
    When I send a POST request to "/api/auth/login" with body:
      | username     | password      |
      | jane_doe     | wrongPassword |
    Then the response status should be 401
    And the response body should contain "error" with value "Invalid username or password"
    When I send a POST request to "/api/auth/login" with body:
      | username     | password    |
      | unknown_user | secureP@ss1 |
    Then the response status should be 401
    And the response body should contain "error" with value "Invalid username or password"

  # ──────────────────────────────────────────────
  # Login — Validation Errors
  # ──────────────────────────────────────────────

  @login @validation
  Scenario: Login fails when username is missing
    When I send a POST request to "/api/auth/login" with body:
      | username | password    |
      |          | secureP@ss1 |
    Then the response status should be 400
    And the response body should contain "error" with value "Username and password are required"

  @login @validation
  Scenario: Login fails when password is missing
    When I send a POST request to "/api/auth/login" with body:
      | username | password |
      | jane_doe |          |
    Then the response status should be 400
    And the response body should contain "error" with value "Username and password are required"

  @login @validation
  Scenario: Login fails when both fields are missing
    When I send a POST request to "/api/auth/login" with body:
      | username | password |
      |          |          |
    Then the response status should be 400
    And the response body should contain "error" with value "Username and password are required"

  # ──────────────────────────────────────────────
  # Login — Success Message After Registration
  # ──────────────────────────────────────────────

  @login @ui
  Scenario: Login page shows success message after registration redirect
    Given I am on the "/login?registered=true" page
    Then I should see the message "Registration successful. Please log in."

  # ──────────────────────────────────────────────
  # Logout — Happy Path
  # ──────────────────────────────────────────────

  @logout
  Scenario: Successful logout clears the session cookie
    Given a user exists with username "jane_doe" and password "secureP@ss1"
    And the user "jane_doe" is logged in
    When I send a POST request to "/api/auth/logout"
    Then the response status should be 200
    And the response body should contain "message" with value "Logged out successfully"
    And the response should set a cookie "token" with value ""
    And the response should set a cookie "token" with Max-Age 0

  @logout @ui
  Scenario: Logout button redirects to login page
    Given a user exists with username "jane_doe" and password "secureP@ss1"
    And the user "jane_doe" is logged in
    And I am on the "/profile" page
    When I click the "Logout" button
    Then I should be redirected to "/login"

  # ──────────────────────────────────────────────
  # Logout — When Not Logged In
  # ──────────────────────────────────────────────

  @logout
  Scenario: Logout when not logged in still returns 200
    When I send a POST request to "/api/auth/logout"
    Then the response status should be 200
    And the response body should contain "message" with value "Logged out successfully"

  # ──────────────────────────────────────────────
  # Security
  # ──────────────────────────────────────────────

  @security
  Scenario: Passwords are stored hashed with bcrypt
    When I send a POST request to "/api/auth/register" with body:
      | username | password    |
      | jane_doe | secureP@ss1 |
    Then the response status should be 201
    And the stored password for "jane_doe" should be a bcrypt hash
    And the stored password for "jane_doe" should not equal "secureP@ss1"

  @security
  Scenario: JWT token is delivered in an HTTP-only cookie
    Given a user exists with username "jane_doe" and password "secureP@ss1"
    When I send a POST request to "/api/auth/login" with body:
      | username | password    |
      | jane_doe | secureP@ss1 |
    Then the response status should be 200
    And the response should set a cookie "token" with HttpOnly flag
    And the "token" cookie should contain a valid JWT

  @security @ui
  Scenario: Unauthenticated user is redirected from profile to login
    Given I am not logged in
    When I navigate to "/profile"
    Then I should be redirected to "/login"
