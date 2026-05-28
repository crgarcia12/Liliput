'use client';

// Local type definitions for web client
export interface User {
  id: string;
  username: string;
  role: string;
}

export interface LoginResponse {
  token: string;
  user: User;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';

interface FetchOptions extends RequestInit {
  includeAuth?: boolean;
}

/** Get JWT token from localStorage */
function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('auth_token');
}

/** Store JWT token in localStorage */
function setToken(token: string): void {
  if (typeof window !== 'undefined') {
    localStorage.setItem('auth_token', token);
  }
}

/** Clear JWT token from localStorage */
function clearToken(): void {
  if (typeof window !== 'undefined') {
    localStorage.removeItem('auth_token');
  }
}

/** Fetch wrapper that includes JWT in Authorization header */
async function apiFetch(
  endpoint: string,
  options: FetchOptions = {},
): Promise<Response> {
  const { includeAuth = true, ...fetchOptions } = options;

  const headers = new Headers(fetchOptions.headers || {});

  if (includeAuth) {
    const token = getToken();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...fetchOptions,
    headers,
  });

  // Redirect authenticated API calls to login on 401. Public calls such as
  // /api/login need to surface their own 401 response to the caller.
  if (includeAuth && response.status === 401) {
    clearToken();
    if (typeof window !== 'undefined') {
      window.location.href = '/login';
    }
    throw new Error('Unauthorized');
  }

  return response;
}

/** Login with username and password */
export async function login(
  username: string,
  password: string,
): Promise<LoginResponse> {
  const response = await apiFetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
    includeAuth: false,
  });

  if (!response.ok) {
    const error = await response.json() as { error?: string };
    throw new Error(error.error || 'Login failed');
  }

  const data = (await response.json()) as LoginResponse;
  setToken(data.token);
  return data;
}

/** Logout (clear token and redirect) */
export function logout(): void {
  clearToken();
  if (typeof window !== 'undefined') {
    window.location.href = '/login';
  }
}

/** Generic GET request */
export async function get<T>(endpoint: string): Promise<T> {
  const response = await apiFetch(endpoint);
  if (!response.ok) {
    throw new Error(`GET ${endpoint} failed: ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

/** Generic POST request */
export async function post<T>(
  endpoint: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await apiFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    throw new Error(`POST ${endpoint} failed: ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

/**
 * Change the password of the currently logged-in user.
 *
 * Calls `POST /api/auth/change-password` with the JWT in the Authorization
 * header (NOT via the cookie alone, so this works for CLI consumers too).
 *
 * Throws an Error whose `.message` is the server-provided reason on failure,
 * suitable for displaying inline in the UI. Does NOT trigger the global
 * 401-redirect behaviour of `apiFetch` — callers want to see the error inline.
 */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const response = await fetch(`${API_BASE}/api/auth/change-password`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  if (!response.ok) {
    let message = `Change password failed (${response.status})`;
    try {
      const data = (await response.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // ignore parse errors
    }
    throw new Error(message);
  }
}

/** Generic PUT request */
export async function put<T>(
  endpoint: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await apiFetch(endpoint, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    throw new Error(`PUT ${endpoint} failed: ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

/** Generic DELETE request */
export async function del<T>(endpoint: string): Promise<T> {
  const response = await apiFetch(endpoint, { method: 'DELETE' });
  if (!response.ok) {
    throw new Error(`DELETE ${endpoint} failed: ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export default {
  get,
  post,
  put,
  del,
  login,
  logout,
  getToken,
  setToken,
  clearToken,
  changePassword,
};
