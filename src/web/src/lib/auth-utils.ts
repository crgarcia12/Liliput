'use client';

export interface SessionToken {
  userId: string;
  username: string;
  role: string;
}

/** Decode JWT token (basic decoding, no verification — client-side only) */
export function decodeToken(token: string): SessionToken | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const decoded = JSON.parse(atob(parts[1])) as SessionToken;
    return decoded;
  } catch {
    return null;
  }
}

/** Get session info from localStorage */
export function getSessionInfo(): SessionToken | null {
  if (typeof window === 'undefined') return null;

  const token = localStorage.getItem('auth_token');
  if (!token) return null;

  return decodeToken(token);
}

/** Check if user is authenticated */
export function isAuthenticated(): boolean {
  const session = getSessionInfo();
  return session !== null;
}
