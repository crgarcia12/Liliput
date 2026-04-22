# FRD: Profile & Navigation

**Covers:** US-3 (View Profile), US-6 (Navigation Awareness)
**Depends on:** FRD-Auth (US-1, US-2, US-5 — registration, login, logout endpoints and JWT cookie mechanism)

---

## 1. Overview

This FRD specifies the Profile page, Navigation bar, Landing page, and authentication guard behavior. It defines how the frontend adapts to authentication state and user role, ensuring authenticated users see their profile information and role-appropriate navigation, while non-authenticated users are guided toward login or registration.

---

## 2. API Contract

### `GET /api/auth/me`

Returns the currently authenticated user's profile data.

**Request:**
- No request body.
- Requires a valid JWT in the `token` HTTP-only cookie (set during login).

**Success Response — 200 OK:**

```json
{
  "username": "janedoe",
  "role": "user",
  "createdAt": "2025-01-15T08:30:00.000Z"
}
```

| Field       | Type                        | Description                              |
|-------------|-----------------------------|------------------------------------------|
| `username`  | `string`                    | The user's unique username               |
| `role`      | `"user"` \| `"admin"`       | The user's assigned role                 |
| `createdAt` | `string` (ISO 8601)         | Timestamp when the account was created   |

**Error Response — 401 Unauthorized:**

Returned when the JWT cookie is missing, expired, malformed, or references a deleted user.

```json
{
  "error": "Not authenticated"
}
```

**Behavior Notes:**
- The endpoint MUST verify the JWT signature using the server-side `JWT_SECRET`.
- If the JWT is valid but the referenced user no longer exists in the store, return 401.
- No other status codes are expected from this endpoint.

---

## 3. Profile Page (`/profile`)

### 3.1 Layout

The profile page displays the authenticated user's account information in a centered card layout.

**Displayed Data:**

| Element          | Content                                                        | Example Rendering             |
|------------------|----------------------------------------------------------------|-------------------------------|
| Username         | `username` from `/api/auth/me`                                 | `janedoe`                     |
| Role badge       | `role` from `/api/auth/me`, rendered as a styled badge         | Badge: `user` or `admin`      |
| Member since     | `createdAt` formatted as a human-readable date                 | `January 15, 2025`            |
| Logout button    | Calls `POST /api/auth/logout`, then redirects to `/login`      | Button labeled **"Logout"**   |

**Date formatting:** Use `Intl.DateTimeFormat` with `{ year: 'numeric', month: 'long', day: 'numeric' }` for the `createdAt` display.

### 3.2 Component Behavior

- This is a **client component** (`'use client'`) because it uses `useEffect` for data fetching and `useState` for managing loading/error/data states.
- On mount, call `GET /api/auth/me` via `fetch` with `credentials: 'include'`.
- Render a loading spinner while the request is in flight (see §3.3).
- On 200, render the profile card with the returned data.
- On 401, redirect to `/login` (see §4).
- On network error, show the error state (see §3.4).

### 3.3 Loading State

While the `/api/auth/me` request is pending:
- Display a centered loading spinner with the text **"Loading profile…"**.
- No profile data or logout button is shown during loading.

### 3.4 Error State

If the fetch fails due to a network error (not a 401):
- Display a centered error message: **"Failed to load profile. Please try again."**
- Include a **"Retry"** button that re-triggers the `/api/auth/me` call.

### 3.5 Logout Button Behavior

- Placed below the profile card.
- On click: call `POST /api/auth/logout` with `credentials: 'include'`.
- On success (200): redirect to `/login`.
- On failure: show an inline error message below the button.

---

## 4. Auth Guard Behavior

The auth guard ensures that protected pages (e.g., `/profile`) are only accessible to authenticated users.

### 4.1 Client-Side Auth Check

Protected pages perform authentication checks client-side:

1. On component mount, call `GET /api/auth/me` with `credentials: 'include'`.
2. While the request is in flight, render a loading spinner (page-level loading state).
3. If the response is **200**, the user is authenticated — render the page content.
4. If the response is **401**, redirect to `/login` using `next/navigation` `useRouter().push('/login')`.
5. If the request fails (network error), show the error state with a retry option.

### 4.2 Why Client-Side (Not Middleware)

Next.js middleware runs on the edge and cannot reliably read HTTP-only cookies set by a separate Express API backend in all deployment scenarios. The auth check is therefore performed client-side in each protected page component.

### 4.3 Redirect Flow

```
User visits /profile
  → Component mounts
  → GET /api/auth/me
  → 401? → router.push('/login')
  → 200? → render profile data
```

---

## 5. Navigation Bar Component

### 5.1 Overview

A persistent navigation bar rendered in the root layout (`src/web/src/app/layout.tsx`). It adapts its links based on the user's authentication state and role.

### 5.2 States

#### State A: Not Authenticated

| Position | Element              | Behavior                |
|----------|----------------------|-------------------------|
| Left     | App name: **"UserAuth"** (links to `/`) | Navigate to landing page |
| Right    | **"Login"** link      | Navigate to `/login`    |
| Right    | **"Register"** link   | Navigate to `/register` |

#### State B: Authenticated — `user` role

| Position | Element               | Behavior                          |
|----------|-----------------------|-----------------------------------|
| Left     | App name: **"UserAuth"** (links to `/`) | Navigate to landing page |
| Right    | **"Profile"** link     | Navigate to `/profile`            |
| Right    | **"Logout"** button    | `POST /api/auth/logout` → redirect to `/login` |

#### State C: Authenticated — `admin` role

| Position | Element               | Behavior                          |
|----------|-----------------------|-----------------------------------|
| Left     | App name: **"UserAuth"** (links to `/`) | Navigate to landing page |
| Right    | **"Profile"** link     | Navigate to `/profile`            |
| Right    | **"Admin"** link       | Navigate to `/admin`              |
| Right    | **"Logout"** button    | `POST /api/auth/logout` → redirect to `/login` |

### 5.3 Implementation Details

- The NavBar is a **client component** (`'use client'`) because it uses `useEffect` to fetch auth state and `useState` to track it.
- On mount, call `GET /api/auth/me` with `credentials: 'include'`.
- If 200: store the user object (`{ username, role }`) in state → render State B or C based on `role`.
- If 401 or network error: render State A (not authenticated).
- While the auth check is in flight, render only the app name (left side). Do not flash incorrect nav links.
- Use `next/link` (`<Link>`) for all navigation links.
- The Logout button calls `POST /api/auth/logout`, then uses `router.push('/login')` and clears the local user state.

### 5.4 Styling

- Full-width bar at the top of every page.
- Tailwind CSS classes for layout: `flex items-center justify-between` with appropriate padding.
- Links styled as text links. Logout styled as a button for visual distinction.

---

## 6. Landing Page (`/`)

### 6.1 Layout

A simple centered page with the app name, a brief description, and call-to-action buttons.

### 6.2 Content

| Element              | Content                                                |
|----------------------|--------------------------------------------------------|
| Heading              | **"UserAuth"**                                         |
| Description          | "A simple authentication demo application."            |
| CTA (not authenticated) | Two buttons: **"Login"** (links to `/login`) and **"Register"** (links to `/register`) |
| CTA (authenticated)  | One link: **"Go to Profile"** (links to `/profile`)    |

### 6.3 Implementation Details

- This is a **client component** (`'use client'`) because it conditionally renders CTA buttons based on auth state.
- On mount, call `GET /api/auth/me` with `credentials: 'include'`.
- If 200: show "Go to Profile" link.
- If 401: show Login and Register buttons.
- While loading: show the heading and description, but no CTA buttons (avoid flashing incorrect state).

---

## 7. Frontend Routing

### 7.1 Route Table

| Route        | Auth Required | Component Type   | Auth Check Method            |
|--------------|---------------|------------------|------------------------------|
| `/`          | No            | Client component | Optional — adapts CTA only   |
| `/login`     | No            | Client component | None                         |
| `/register`  | No            | Client component | None                         |
| `/profile`   | Yes           | Client component | Mandatory — redirect on 401  |
| `/admin`     | Yes (admin)   | Client component | Mandatory — redirect on 401/403 |

### 7.2 Auth Redirect Rules

| Scenario                                    | Behavior                                |
|---------------------------------------------|-----------------------------------------|
| Unauthenticated user visits `/profile`      | Redirect to `/login`                    |
| Unauthenticated user visits `/admin`        | Redirect to `/login`                    |
| Authenticated `user` visits `/admin`        | Show 403 Forbidden page (handled by FRD-Admin) |
| Authenticated user visits `/login`          | No forced redirect — allow access       |
| Authenticated user visits `/register`       | No forced redirect — allow access       |

### 7.3 Navigation Method

All internal navigation uses `next/link` for link elements and `useRouter().push()` for programmatic redirects. No raw `<a>` tags for internal routes.

---

## 8. Edge Cases

### 8.1 Expired JWT

- The Express API returns 401 for expired JWTs.
- Frontend treats this identically to "no JWT" — redirect to `/login` from protected pages, show unauthenticated nav state.
- No special "session expired" message is required for MVP.

### 8.2 Malformed JWT

- The Express API returns 401 for malformed or tampered JWTs.
- Frontend treats this identically to an expired JWT — same 401 handling.

### 8.3 User Deleted While Session Active

- If a user's account is deleted from the in-memory store while they have a valid JWT, the `GET /api/auth/me` endpoint returns 401 (user not found after JWT decode).
- Frontend treats this as unauthenticated — redirect to `/login` from protected pages.
- The NavBar will show unauthenticated state on next render.

### 8.4 API Unreachable

- If the Express API is down or unreachable, `fetch` throws a network error.
- Protected pages show the error state with a "Retry" button (see §3.4).
- The NavBar renders in unauthenticated state (State A) to avoid showing broken authenticated links.
- The landing page shows Login/Register CTAs as a safe default.

### 8.5 Concurrent Tab Logout

- If a user logs out in one browser tab, other open tabs still hold stale client state.
- On the next `/api/auth/me` call (e.g., page navigation or refresh), those tabs receive a 401 and transition to unauthenticated state.
- No real-time cross-tab synchronization is required for MVP.

---

## 9. Traceability

| Requirement | PRD Source | Section(s) |
|-------------|-----------|------------|
| Profile page displays username, role, createdAt | US-3 AC, FR-3 | §3 |
| Non-authenticated redirect to /login | US-3 AC | §4 |
| Nav shows Profile + Logout for authenticated users | US-6 AC | §5.2 State B |
| Nav shows Admin link for admin users | US-6 AC | §5.2 State C |
| Nav shows Login + Register for non-authenticated | US-6 AC | §5.2 State A |
| GET /api/auth/me returns profile data | FR-1 | §2 |
| Landing page with Login/Register links | FR-3 | §6 |
| JWT in HTTP-only cookie | FR-4, US-2 AC | §2 |
