# Product Requirements Document — UserAuth Basic App

## 1. Overview

A minimal full-stack web application with user authentication. Users can register with a username and password, log in, and view their own profile page. The app consists of a Next.js frontend and an Express.js backend API.

## 2. Goals

- Provide a simple, secure user registration and login flow.
- Allow authenticated users to view their profile information.
- Establish a clean separation between frontend (Next.js) and backend (Express API).

## 3. User Stories

### US-1: User Registration
**As a** new user,  
**I want to** register with a username and password,  
**So that** I can create an account and access the application.

**Acceptance Criteria:**
- User provides a unique username (3–30 characters, alphanumeric and underscores only).
- User provides a password (minimum 8 characters).
- If the username is already taken, an error message is displayed.
- If registration succeeds, the user is redirected to the login page with a success message.
- Passwords are hashed before storage (never stored in plain text).

### US-2: User Login
**As a** registered user,  
**I want to** log in with my username and password,  
**So that** I can access my profile.

**Acceptance Criteria:**
- User provides their username and password on the login page.
- If credentials are valid, the user is authenticated and redirected to their profile page.
- If credentials are invalid, an error message is displayed ("Invalid username or password").
- Authentication uses a session token (JWT) stored in an HTTP-only cookie.
- The login page is accessible at `/login`.

### US-3: View Profile
**As an** authenticated user,  
**I want to** view my profile page,  
**So that** I can see my account information.

**Acceptance Criteria:**
- The profile page displays the user's username and the date their account was created.
- The profile page is accessible at `/profile`.
- If a non-authenticated user tries to access `/profile`, they are redirected to `/login`.

### US-4: Role-Based Access
**As an** administrator,  
**I want to** have elevated privileges compared to regular users,  
**So that** I can access an admin dashboard to view all registered users.

**Acceptance Criteria:**
- Two roles exist: `user` (default) and `admin`.
- New registrations are assigned the `user` role by default.
- The first registered user is automatically assigned the `admin` role.
- Admin users can access `/admin` to see a list of all registered users (username, role, createdAt).
- Regular users who try to access `/admin` see a 403 Forbidden page.
- The user's role is displayed on their profile page.

### US-5: User Logout
**As an** authenticated user,  
**I want to** log out,  
**So that** I can end my session securely.

**Acceptance Criteria:**
- A logout button is visible on the profile page.
- Clicking logout clears the session token and redirects the user to the login page.
- After logout, accessing `/profile` redirects to `/login`.

### US-6: Navigation Awareness
**As an** authenticated user,  
**I want to** see navigation links appropriate to my role,  
**So that** I can easily access the pages available to me.

**Acceptance Criteria:**
- All authenticated users see links to Profile and Logout in the navigation.
- Admin users additionally see a link to the Admin dashboard.
- Non-authenticated users see links to Login and Register.

## 4. Functional Requirements

### FR-1: Authentication API
| Endpoint | Method | Description |
|---|---|---|
| `/api/auth/register` | POST | Register a new user. Body: `{ username, password }`. Returns 201 on success, 409 if username taken, 400 on validation error. |
| `/api/auth/login` | POST | Authenticate a user. Body: `{ username, password }`. Returns 200 with JWT cookie on success, 401 on failure. |
| `/api/auth/logout` | POST | Clear the session cookie. Returns 200. |
| `/api/auth/me` | GET | Return the current authenticated user's profile. Returns 200 with `{ username, role, createdAt }`, or 401 if not authenticated. |
| `/api/admin/users` | GET | Return a list of all users (admin only). Returns 200 with `[{ username, role, createdAt }]`, or 401/403. |

### FR-2: Data Model
- **User**: `{ id: string (UUID), username: string (unique), passwordHash: string, role: 'user' | 'admin', createdAt: Date }`
- Storage: In-memory store (no external database required for this MVP).

### FR-3: Frontend Pages
| Route | Description | Auth Required |
|---|---|---|
| `/` | Landing page with links to Login and Register | No |
| `/login` | Login form (username + password) | No |
| `/register` | Registration form (username + password) | No |
| `/profile` | Displays user profile info (including role) and logout button | Yes |
| `/admin` | Lists all registered users (username, role, createdAt) | Yes (admin only) |

### FR-4: Security
- Passwords hashed with bcrypt (cost factor ≥ 10).
- JWT tokens signed with a server-side secret (from environment variable `JWT_SECRET`).
- JWT stored in HTTP-only, Secure, SameSite=Strict cookie.
- JWT expiry: 24 hours.
- All API errors return consistent JSON shape: `{ error: string }`.
- Admin-only endpoints must verify the user's role from the JWT; return 403 if role is not `admin`.

## 5. Non-Functional Requirements

- **NFR-1:** API response time < 500ms for all endpoints.
- **NFR-2:** Frontend pages should render within 2 seconds on initial load.
- **NFR-3:** The app must work on the latest versions of Chrome, Firefox, and Safari.
- **NFR-4:** All form inputs must have associated labels for accessibility (WCAG 2.1 AA).

## 6. Out of Scope

- Email verification or password reset.
- OAuth / social login.
- Persistent database (in-memory store is sufficient for MVP).
- Profile editing (profile is read-only).
- Role management UI (no way to change roles after creation).

## 8. Future Considerations

- **SSO via Microsoft Entra ID:** The auth architecture (JWT-based, role in token payload) is designed to be compatible with a future migration to Entra ID SSO. When added, the `/api/auth/login` flow would be replaced by an Entra redirect, and the JWT would be issued from Entra tokens. The role model (`user`/`admin`) can map to Entra groups/app roles.

## 9. Technical Stack

- **Frontend:** Next.js (App Router, TypeScript, Tailwind CSS)
- **Backend:** Express.js (TypeScript)
- **Auth:** JWT (jsonwebtoken), bcrypt
- **Storage:** In-memory JavaScript Map
- **Deployment:** Azure Container Apps via AZD
