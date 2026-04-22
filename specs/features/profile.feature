@profile
Feature: Profile page, navigation bar, and landing page
  As a user of the UserAuth application
  I want to view my profile, see role-appropriate navigation, and access the landing page
  So that I can manage my account and navigate the app based on my authentication state

  # ──────────────────────────────────────────────
  # Profile Page — View Profile
  # ──────────────────────────────────────────────

  @auth-guard
  Scenario: Authenticated user sees their profile information
    Given I am logged in as a user with username "janedoe" and role "user" created at "2025-01-15T08:30:00.000Z"
    When I visit the "/profile" page
    Then I should see the username "janedoe"
    And I should see a role badge displaying "user"
    And I should see the member since date "January 15, 2025"
    And I should see a "Logout" button

  @auth-guard
  Scenario: Authenticated admin sees their profile information
    Given I am logged in as a user with username "adminuser" and role "admin" created at "2024-06-01T12:00:00.000Z"
    When I visit the "/profile" page
    Then I should see the username "adminuser"
    And I should see a role badge displaying "admin"
    And I should see the member since date "June 1, 2024"
    And I should see a "Logout" button

  # ──────────────────────────────────────────────
  # Profile Page — Auth Guard
  # ──────────────────────────────────────────────

  @auth-guard
  Scenario: Unauthenticated user is redirected to login from profile page
    Given I am not authenticated
    When I visit the "/profile" page
    Then I should be redirected to "/login"

  # ──────────────────────────────────────────────
  # Profile Page — Loading State
  # ──────────────────────────────────────────────

  @auth-guard
  Scenario: Profile page shows loading indicator while fetching data
    Given I am logged in as a user with username "janedoe" and role "user" created at "2025-01-15T08:30:00.000Z"
    And the API response for "/api/auth/me" is delayed
    When I visit the "/profile" page
    Then I should see the text "Loading profile…"
    And I should not see a "Logout" button

  # ──────────────────────────────────────────────
  # Profile Page — Logout
  # ──────────────────────────────────────────────

  @auth-guard
  Scenario: User logs out from the profile page
    Given I am logged in as a user with username "janedoe" and role "user" created at "2025-01-15T08:30:00.000Z"
    And I am on the "/profile" page
    When I click the "Logout" button
    Then the "token" cookie should be cleared
    And I should be redirected to "/login"

  # ──────────────────────────────────────────────
  # Navigation Bar States
  # ──────────────────────────────────────────────

  @navigation
  Scenario: NavBar shows Login and Register links for guest users
    Given I am not authenticated
    When I visit the "/" page
    Then the NavBar should display the app name "UserAuth" linking to "/"
    And the NavBar should display a "Login" link to "/login"
    And the NavBar should display a "Register" link to "/register"
    And the NavBar should not display a "Profile" link
    And the NavBar should not display a "Logout" button

  @navigation
  Scenario: NavBar shows Profile and Logout for authenticated user role
    Given I am logged in as a user with username "janedoe" and role "user" created at "2025-01-15T08:30:00.000Z"
    When I visit the "/" page
    Then the NavBar should display the app name "UserAuth" linking to "/"
    And the NavBar should display a "Profile" link to "/profile"
    And the NavBar should display a "Logout" button
    And the NavBar should not display a "Login" link
    And the NavBar should not display a "Register" link
    And the NavBar should not display an "Admin" link

  @navigation
  Scenario: NavBar shows Profile, Admin, and Logout for authenticated admin role
    Given I am logged in as a user with username "adminuser" and role "admin" created at "2024-06-01T12:00:00.000Z"
    When I visit the "/" page
    Then the NavBar should display the app name "UserAuth" linking to "/"
    And the NavBar should display a "Profile" link to "/profile"
    And the NavBar should display an "Admin" link to "/admin"
    And the NavBar should display a "Logout" button
    And the NavBar should not display a "Login" link
    And the NavBar should not display a "Register" link

  @navigation
  Scenario: NavBar shows only the app name while auth check is in flight
    Given the API response for "/api/auth/me" is delayed
    When I visit the "/" page
    Then the NavBar should display the app name "UserAuth" linking to "/"
    And the NavBar should not display a "Login" link
    And the NavBar should not display a "Profile" link

  # ──────────────────────────────────────────────
  # Landing Page
  # ──────────────────────────────────────────────

  @landing
  Scenario: Guest user sees Login and Register CTAs on the landing page
    Given I am not authenticated
    When I visit the "/" page
    Then I should see the heading "UserAuth"
    And I should see the text "A simple authentication demo application."
    And I should see a "Login" link to "/login"
    And I should see a "Register" link to "/register"
    And I should not see a "Go to Profile" link

  @landing
  Scenario: Authenticated user sees Go to Profile CTA on the landing page
    Given I am logged in as a user with username "janedoe" and role "user" created at "2025-01-15T08:30:00.000Z"
    When I visit the "/" page
    Then I should see the heading "UserAuth"
    And I should see the text "A simple authentication demo application."
    And I should see a "Go to Profile" link to "/profile"
    And I should not see a "Login" link
    And I should not see a "Register" link

  @landing
  Scenario: Landing page shows heading and description but no CTAs while loading
    Given the API response for "/api/auth/me" is delayed
    When I visit the "/" page
    Then I should see the heading "UserAuth"
    And I should see the text "A simple authentication demo application."
    And I should not see a "Login" link
    And I should not see a "Go to Profile" link

  # ──────────────────────────────────────────────
  # Edge Cases
  # ──────────────────────────────────────────────

  @auth-guard @profile
  Scenario: Expired JWT is treated as unauthenticated on the profile page
    Given I have an expired JWT token
    When I visit the "/profile" page
    Then I should be redirected to "/login"

  @auth-guard @profile
  Scenario: Malformed JWT is treated as unauthenticated on the profile page
    Given I have a malformed JWT token
    When I visit the "/profile" page
    Then I should be redirected to "/login"

  @auth-guard @profile
  Scenario: Deleted user with valid JWT is treated as unauthenticated
    Given I have a valid JWT token for a deleted user
    When I visit the "/profile" page
    Then I should be redirected to "/login"

  @auth-guard @profile
  Scenario: API unreachable shows error state with retry on the profile page
    Given I am logged in as a user with username "janedoe" and role "user" created at "2025-01-15T08:30:00.000Z"
    And the API at "/api/auth/me" is unreachable
    When I visit the "/profile" page
    Then I should see the text "Failed to load profile. Please try again."
    And I should see a "Retry" button

  @navigation @profile
  Scenario: NavBar falls back to guest state when API is unreachable
    Given the API at "/api/auth/me" is unreachable
    When I visit the "/" page
    Then the NavBar should display a "Login" link to "/login"
    And the NavBar should display a "Register" link to "/register"
    And the NavBar should not display a "Profile" link
