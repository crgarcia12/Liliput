# FRD-AUTH: Authentication

## 1. Overview

This FRD specifies the authentication system covering user registration (US-1), login (US-2), and logout (US-5). The system uses an Express.js TypeScript API with in-memory storage, bcrypt password hashing, and JWT tokens delivered via HTTP-only cookies. The Next.js App Router frontend provides login and registration forms with client-side validation and server-driven redirects.

---

## 2. API Contracts

### 2.1 POST /api/auth/register

Registers a new user account.

**Request Body:**

```json
{
  "username": "john_doe",
  "password": "secureP@ss1"
}
```

| Field    | Type   | Required | Constraints                                          |
|----------|--------|----------|------------------------------------------------------|
| username | string | yes      | 3–30 characters, alphanumeric and underscores only (`/^[a-zA-Z0-9_]{3,30}$/`) |
| password | string | yes      | 8 or more characters                                 |

**Responses:**

| Status | Condition                        | Body                                              |
|--------|----------------------------------|----------------------------------------------------|
| 201    | Registration successful          | `{ "message": "Registration successful" }`         |
| 400    | Validation failure (see §3)      | `{ "error": "<validation message>" }`              |
| 409    | Username already taken            | `{ "error": "Username already exists" }`           |

**201 Example:**

```json
{ "message": "Registration successful" }
```

**400 Example (short username):**

```json
{ "error": "Username must be between 3 and 30 characters and contain only letters, numbers, and underscores" }
```

**409 Example:**

```json
{ "error": "Username already exists" }
```

---

### 2.2 POST /api/auth/login

Authenticates a user and issues a JWT session cookie.

**Request Body:**

```json
{
  "username": "john_doe",
  "password": "secureP@ss1"
}
```

| Field    | Type   | Required | Constraints        |
|----------|--------|----------|--------------------|
| username | string | yes      | Non-empty string   |
| password | string | yes      | Non-empty string   |

**Responses:**

| Status | Condition                        | Body                                              |
|--------|----------------------------------|----------------------------------------------------|
| 200    | Login successful                 | `{ "message": "Login successful" }`               |
| 400    | Missing username or password     | `{ "error": "Username and password are required" }`|
| 401    | Invalid credentials              | `{ "error": "Invalid username or password" }`      |

**200 Response Headers (Set-Cookie):**

```
Set-Cookie: token=<jwt>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400
```

**200 Example:**

```json
{ "message": "Login successful" }
```

**401 Example:**

```json
{ "error": "Invalid username or password" }
```

---

### 2.3 POST /api/auth/logout

Clears the session cookie and ends the user's session.

**Request Body:** None.

**Responses:**

| Status | Condition        | Body                                      |
|--------|------------------|-------------------------------------------|
| 200    | Logout successful | `{ "message": "Logged out successfully" }`|

**200 Response Headers (Set-Cookie):**

```
Set-Cookie: token=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0
```

**200 Example:**

```json
{ "message": "Logged out successfully" }
```

---

## 3. Validation Rules

### 3.1 Username

| Rule                     | Regex / Check                      | Error Message                                                                                          |
|--------------------------|------------------------------------|--------------------------------------------------------------------------------------------------------|
| Required                 | field present and non-empty        | `"Username is required"`                                                                               |
| Format & length          | `/^[a-zA-Z0-9_]{3,30}$/`          | `"Username must be between 3 and 30 characters and contain only letters, numbers, and underscores"`    |

### 3.2 Password

| Rule                     | Check                              | Error Message                                                     |
|--------------------------|------------------------------------|--------------------------------------------------------------------|
| Required                 | field present and non-empty        | `"Password is required"`                                           |
| Minimum length           | `password.length >= 8`             | `"Password must be at least 8 characters"`                         |

### 3.3 Validation Order

Validate fields in this order: username presence → username format → password presence → password length. Return the **first** failing validation error (do not aggregate).

---

## 4. Authentication Flow

### 4.1 JWT Creation

On successful login, create a JWT with the following payload:

```json
{
  "sub": "<userId>",
  "username": "<username>",
  "role": "user"
}
```

| Parameter   | Value                                    |
|-------------|------------------------------------------|
| Algorithm   | HS256 (default for `jsonwebtoken`)       |
| Secret      | `process.env.JWT_SECRET`                 |
| Expiry      | 24 hours (`expiresIn: "24h"`)            |

### 4.2 Cookie Configuration

| Attribute  | Value       | Rationale                            |
|------------|-------------|--------------------------------------|
| Name       | `token`     | Consistent reference across stack    |
| HttpOnly   | `true`      | Prevents JavaScript access (XSS)    |
| Secure     | `true`      | HTTPS only in production             |
| SameSite   | `Strict`    | CSRF protection                      |
| Path       | `/`         | Available to all routes              |
| Max-Age    | `86400`     | 24 hours in seconds                  |

### 4.3 Cookie Clearing (Logout)

Set the `token` cookie with an empty value and `Max-Age=0` to instruct the browser to delete it immediately.

---

## 5. Security Requirements

| Requirement                | Detail                                                                                          |
|----------------------------|-------------------------------------------------------------------------------------------------|
| Password hashing           | bcrypt with cost factor ≥ 10 (`bcrypt.hash(password, 10)`)                                     |
| No plain-text storage      | Passwords are **never** stored or logged in plain text                                          |
| Timing-safe comparison     | Use `bcrypt.compare()` for password verification — it is inherently timing-safe                 |
| Generic login errors       | Always return `"Invalid username or password"` on 401 — do not reveal whether the username exists |
| JWT secret                 | Read from `JWT_SECRET` environment variable; never hard-code                                    |
| HTTP-only cookies          | JWT is never exposed to client-side JavaScript                                                  |
| Input trimming             | Do **not** trim username or password — store and compare exactly as submitted                   |

---

## 6. Frontend Behavior

### 6.1 Register Page (`/register`)

| Element           | Detail                                                        |
|-------------------|---------------------------------------------------------------|
| Route             | `/register`                                                   |
| Form fields       | Username (text input), Password (password input)              |
| Submit button     | Label: "Register"                                             |
| Client validation | Username: required, 3–30 chars, alphanumeric + underscores. Password: required, 8+ chars |
| On 201            | Redirect to `/login` with query param `?registered=true`; login page shows "Registration successful. Please log in." |
| On 400 / 409      | Display the `error` value from the response body inline above the form |
| Link              | "Already have an account? Log in" → navigates to `/login`    |

### 6.2 Login Page (`/login`)

| Element           | Detail                                                        |
|-------------------|---------------------------------------------------------------|
| Route             | `/login`                                                      |
| Form fields       | Username (text input), Password (password input)              |
| Submit button     | Label: "Log in"                                               |
| Client validation | Username: required. Password: required                        |
| Success message   | If `?registered=true` query param is present, show "Registration successful. Please log in." |
| On 200            | Redirect to `/profile`                                        |
| On 400 / 401      | Display the `error` value from the response body inline above the form |
| Link              | "Don't have an account? Register" → navigates to `/register` |

### 6.3 Profile Page (`/profile`)

| Element           | Detail                                                        |
|-------------------|---------------------------------------------------------------|
| Logout button     | Label: "Logout"                                               |
| Logout action     | `POST /api/auth/logout`, then redirect to `/login`            |
| Auth guard        | If the user is not authenticated (no valid token cookie), redirect to `/login` |

---

## 7. Error Responses

All error responses use a consistent shape:

```json
{ "error": "<human-readable message>" }
```

### Complete Error Catalog

| Endpoint               | Status | Error Message                                                                                       |
|------------------------|--------|------------------------------------------------------------------------------------------------------|
| POST /api/auth/register | 400   | `"Username is required"`                                                                             |
| POST /api/auth/register | 400   | `"Username must be between 3 and 30 characters and contain only letters, numbers, and underscores"` |
| POST /api/auth/register | 400   | `"Password is required"`                                                                             |
| POST /api/auth/register | 400   | `"Password must be at least 8 characters"`                                                           |
| POST /api/auth/register | 409   | `"Username already exists"`                                                                          |
| POST /api/auth/login    | 400   | `"Username and password are required"`                                                               |
| POST /api/auth/login    | 401   | `"Invalid username or password"`                                                                     |

---

## 8. Edge Cases

| Scenario                              | Expected Behavior                                                                                 |
|---------------------------------------|---------------------------------------------------------------------------------------------------|
| Empty fields (empty string `""`)      | Treated as missing — return the appropriate "required" validation error                           |
| Whitespace-only input (`"   "`)       | Treated as invalid — fails regex for username, fails length check for password (whitespace counts toward length but `"   "` with <8 chars fails) |
| Username with special characters      | Rejected by regex (`/^[a-zA-Z0-9_]{3,30}$/`) — return format validation error                    |
| SQL injection in username             | Rejected by regex (special characters blocked); additionally, in-memory Map storage is not susceptible to SQL injection |
| HTML/script injection in fields       | Input is stored as-is in memory; output is rendered by React which auto-escapes JSX — no XSS risk |
| Concurrent registration of same name  | In-memory Map operations are synchronous in Node.js (single-threaded event loop), so the first request to write wins. The second receives 409. No race condition in single-process deployments |
| Very long username (>30 chars)        | Rejected by regex — return format validation error                                                |
| Very long password (>10 000 chars)    | bcrypt truncates at 72 bytes; accepted but only first 72 bytes are hashed. Consider adding a max-length check in a future iteration, but not required for this FRD |
| Missing Content-Type header           | Express `express.json()` middleware returns 400 if body is not parseable as JSON                  |
| Duplicate login (already logged in)   | Allowed — new JWT overwrites the existing cookie                                                  |
| Logout when not logged in             | Returns 200 — clearing a non-existent cookie is a no-op and idempotent                           |

---

## Traceability

| User Story | PRD Reference | Covered In         |
|------------|---------------|--------------------|
| US-1       | User Registration | §2.1, §3, §5, §6.1, §8 |
| US-2       | User Login        | §2.2, §4, §5, §6.2, §8 |
| US-5       | User Logout       | §2.3, §4.3, §6.3, §8   |
