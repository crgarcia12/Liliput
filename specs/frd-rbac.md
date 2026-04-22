# FRD-RBAC: Role-Based Access Control & Admin Dashboard

**PRD Reference:** US-4 (Role-Based Access)
**Status:** Draft
**Last Updated:** 2025-07-14

---

## 1. Overview

This FRD specifies the role-based access control (RBAC) system and admin dashboard for the application. Two roles exist: `user` (default) and `admin`. The first registered user is automatically promoted to `admin`. Admins can access a protected `/admin` page that displays all registered users. Non-admin users receive a 403 Forbidden response when attempting to access admin-only resources.

---

## 2. Role Model

### 2.1 Roles

| Role    | Description                                      | Assigned When                        |
|---------|--------------------------------------------------|--------------------------------------|
| `user`  | Default role with standard application access    | Every registration (except the first)|
| `admin` | Elevated role with access to admin endpoints/pages| First user to register               |

### 2.2 User Data Model

The User entity stored in the in-memory Map uses the following shape:

```typescript
interface User {
  id: string;          // UUID v4
  username: string;    // Unique, case-sensitive
  passwordHash: string;// bcrypt hash
  role: 'user' | 'admin';
  createdAt: Date;
}
```

- `id` — Generated via `crypto.randomUUID()` at registration time.
- `role` — Persisted as a string literal union: `'user' | 'admin'`. No other values are valid.
- The role is set once at registration and never changes (no role mutation endpoint exists).

---

## 3. Role Assignment Logic

### 3.1 First-User Detection

At registration time, the system determines whether the in-memory user store is empty:

```
if (userStore.size === 0) → assign role 'admin'
else                      → assign role 'user'
```

### 3.2 Rules

1. **First registered user** — Automatically receives the `admin` role. No manual intervention required.
2. **All subsequent users** — Receive the `user` role.
3. **No role change mechanism** — There is no API endpoint or UI to change a user's role after registration. Role mutation is out of scope for this FRD.
4. **No role deletion** — Roles cannot be removed from a user.

### 3.3 Race Condition Consideration

The application uses an in-memory `Map` for storage and runs on a single-threaded Node.js event loop. Concurrent first-user registration is not a practical concern because JavaScript executes synchronously within a single tick — the `userStore.size === 0` check and the subsequent insert occur atomically within the same synchronous block.

---

## 4. API Contract

### 4.1 `GET /api/admin/users`

Returns a list of all registered users. Restricted to authenticated users with the `admin` role.

#### Request

```
GET /api/admin/users
Cookie: token=<JWT>
```

No request body or query parameters.

#### Response: 200 OK (Admin)

Returned when the caller has a valid JWT with `role: 'admin'`.

```json
[
  {
    "username": "adminuser",
    "role": "admin",
    "createdAt": "2025-07-14T10:00:00.000Z"
  },
  {
    "username": "regularuser",
    "role": "user",
    "createdAt": "2025-07-14T10:05:00.000Z"
  }
]
```

- Array of user objects. Never empty (at minimum the admin user exists).
- `createdAt` is serialized as an ISO 8601 string.
- `passwordHash` and `id` are **never** included in the response.

#### Response: 401 Unauthorized

Returned when no JWT cookie is present, or the JWT is invalid/expired.

```json
{
  "error": "Not authenticated"
}
```

#### Response: 403 Forbidden

Returned when the JWT is valid but the user's role is not `admin`.

```json
{
  "error": "Forbidden"
}
```

---

## 5. Authorization Middleware

### 5.1 Purpose

A reusable Express middleware function that enforces role-based access on any route. It is designed to be composable with the existing authentication middleware.

### 5.2 Middleware Signature

```typescript
function requireRole(role: 'user' | 'admin'): RequestHandler
```

### 5.3 Behavior

1. **Prerequisite** — The authentication middleware (`authMiddleware`) must run first. It validates the JWT and attaches the decoded payload to `req.user`.
2. **Extract role** — Read `req.user.role` from the decoded JWT payload (set by the auth middleware).
3. **Check permission** — Compare `req.user.role` against the required `role` parameter.
4. **Allow** — If the user's role matches the required role, call `next()`.
5. **Deny** — If the user's role does not match, return `403` with `{ "error": "Forbidden" }`. Do not call `next()`.

### 5.4 Route Wiring

```typescript
router.get('/api/admin/users', authMiddleware, requireRole('admin'), adminUsersHandler);
```

The middleware chain is:
1. `authMiddleware` — validates JWT, attaches `req.user`, returns 401 if invalid.
2. `requireRole('admin')` — checks `req.user.role`, returns 403 if not admin.
3. `adminUsersHandler` — returns the user list.

### 5.5 Reusability

`requireRole` accepts any valid role string and can be applied to any future endpoint that requires role-based restrictions without modification.

---

## 6. Admin Dashboard Page (`/admin`)

### 6.1 Page Metadata

- **Route:** `/admin`
- **Title:** `Admin Dashboard`
- **Access:** Authenticated users with `admin` role only

### 6.2 Layout

```
┌─────────────────────────────────────────┐
│  Admin Dashboard              (h1 title)│
├─────────────────────────────────────────┤
│                                         │
│  ┌─────────────┬────────┬─────────────┐ │
│  │ Username    │ Role   │ Member Since│ │
│  ├─────────────┼────────┼─────────────┤ │
│  │ adminuser   │ admin  │ Jul 14, 2025│ │
│  │ regularuser │ user   │ Jul 14, 2025│ │
│  └─────────────┴────────┴─────────────┘ │
│                                         │
└─────────────────────────────────────────┘
```

### 6.3 Table Columns

| Column       | Source Field | Display Format                  |
|--------------|-------------|---------------------------------|
| Username     | `username`  | Plain text                      |
| Role         | `role`      | Plain text (`admin` or `user`)  |
| Member Since | `createdAt` | Human-readable date (e.g., `Jul 14, 2025`) |

### 6.4 States

#### Loading State
While fetching `/api/admin/users`, display a loading indicator (text or spinner) with the message: `Loading users...`

#### Success State
Render the users table as described in §6.2.

#### Error State (Network/Server Error)
If the API call fails with a 5xx or network error, display: `Failed to load users.`

#### 403 Forbidden State
If the API returns 403, the page displays an **Access Denied** message (see §7 for details). The users table is not rendered.

#### 401 Unauthorized State
If the API returns 401, redirect the user to the login page (`/login`).

---

## 7. Frontend Auth Guard with Role Check

### 7.1 Purpose

The `/admin` page must verify both authentication and admin role before rendering content. This is a client-side guard that complements the server-side middleware.

### 7.2 Guard Logic

```
1. Check if user is authenticated (JWT cookie exists, /api/auth/me succeeds)
   - If not authenticated → redirect to /login
2. Check if user's role is 'admin' (from /api/auth/me response or local state)
   - If not admin → display "Access Denied" message
   - If admin → render the admin dashboard
```

### 7.3 Access Denied Display

When an authenticated non-admin user navigates to `/admin`:

- **Heading:** `Access Denied`
- **Message:** `You do not have permission to view this page.`
- The users table is **not** rendered.
- No redirect occurs — the user sees the denial message on the `/admin` route.

### 7.4 Defense in Depth

The frontend guard is a UX convenience. The true security boundary is the server-side `requireRole('admin')` middleware on `GET /api/admin/users`. Even if the frontend guard is bypassed, the API will reject unauthorized requests with 403.

---

## 8. JWT Payload

### 8.1 Token Structure

The JWT issued at login and registration must include the user's role:

```json
{
  "sub": "550e8400-e29b-41d4-a716-446655440000",
  "username": "adminuser",
  "role": "admin",
  "iat": 1752487200,
  "exp": 1752573600
}
```

| Field      | Type   | Description                          |
|------------|--------|--------------------------------------|
| `sub`      | string | User's UUID                          |
| `username` | string | User's username                      |
| `role`     | string | User's role: `'user'` or `'admin'`   |
| `iat`      | number | Issued-at timestamp (seconds)        |
| `exp`      | number | Expiration timestamp (seconds)       |

### 8.2 Integration with Existing Auth

- The `/api/auth/register` and `/api/auth/login` endpoints already issue JWTs. The `role` field must be added to the existing payload.
- The `authMiddleware` already decodes the JWT and sets `req.user`. The decoded object will now include `role`.

---

## 9. Edge Cases

| Edge Case | Behavior | Rationale |
|-----------|----------|-----------|
| Admin accesses `/admin` when they are the only user | Table shows one row (the admin themselves) | Valid state — admin always exists in the list |
| Empty user list on `/admin` | **Impossible** — at least one admin user must exist for the requester to be authenticated as admin | The admin user is always present in the store |
| Concurrent first-user registration | Not an issue — Node.js is single-threaded; the `userStore.size === 0` check and insert are synchronous within the same event loop tick | In-memory Map with synchronous access eliminates race conditions |
| Admin JWT used after server restart | JWT is still valid (signed with same secret), but user store is empty (in-memory) — auth middleware should return 401 if user not found in store | Server restart clears in-memory data; JWT validation should verify user still exists |
| Non-existent role value in JWT | `requireRole` middleware rejects — role does not match `'admin'` | Strict equality check; no fallback or wildcard roles |
| Tampered JWT with `role: 'admin'` | JWT signature verification fails in `authMiddleware` → 401 | JWT integrity is enforced by signature validation |

---

## 10. Out of Scope

The following are explicitly **not** covered by this FRD:

- Role change / promotion / demotion endpoints
- More than two roles (e.g., `moderator`, `superadmin`)
- Permission-based access control (fine-grained permissions per resource)
- Admin actions (delete user, ban user, etc.) — the admin page is read-only
- Persistent storage — roles are stored in-memory and lost on server restart
