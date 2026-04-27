/**
 * Tracks Copilot SDK auth/health state and broadcasts changes.
 * The UI consumes this to show "Token expired", "No Copilot subscription", etc.
 */

export type AuthErrorKind =
  | 'missing_token'
  | 'unauthorized'
  | 'forbidden'
  | 'quota'
  | 'network'
  | 'timeout'
  | 'unknown';

export interface AuthStatus {
  /** true = last interaction succeeded; false = failed; null = not yet probed. */
  ok: boolean | null;
  /** ISO timestamp of the last update. */
  lastCheckedAt: string | null;
  /** Classified error category — undefined when ok. */
  errorKind?: AuthErrorKind;
  /** Human-readable message safe to surface in the UI. */
  message?: string;
  /** Whether COPILOT_GITHUB_TOKEN (or equivalent) is present in the environment. */
  hasToken: boolean;
}

type Listener = (status: AuthStatus) => void;

const listeners = new Set<Listener>();

let status: AuthStatus = {
  ok: null,
  lastCheckedAt: null,
  hasToken: hasTokenInEnv(),
};

function hasTokenInEnv(): boolean {
  return Boolean(
    process.env['COPILOT_GITHUB_TOKEN'] ??
      process.env['GH_TOKEN'] ??
      process.env['GITHUB_TOKEN'],
  );
}

export function getAuthStatus(): AuthStatus {
  return { ...status, hasToken: hasTokenInEnv() };
}

export function subscribeAuthStatus(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  const snapshot = getAuthStatus();
  for (const l of listeners) {
    try {
      l(snapshot);
    } catch {
      // ignore listener errors
    }
  }
}

export function recordAuthSuccess(): void {
  status = {
    ok: true,
    lastCheckedAt: new Date().toISOString(),
    hasToken: hasTokenInEnv(),
  };
  notify();
}

export function recordAuthFailure(kind: AuthErrorKind, message: string): void {
  status = {
    ok: false,
    lastCheckedAt: new Date().toISOString(),
    errorKind: kind,
    message,
    hasToken: hasTokenInEnv(),
  };
  notify();
}

const HUMAN_MESSAGES: Record<AuthErrorKind, string> = {
  missing_token:
    'No Copilot token found. Set the COPILOT_GITHUB_TOKEN secret in GitHub and redeploy.',
  unauthorized:
    'The Copilot token is invalid or expired. Regenerate the COPILOT_GITHUB_TOKEN secret in GitHub and redeploy.',
  forbidden:
    'The Copilot token does not have access (no Copilot subscription, or insufficient scopes). Verify the user holds an active Copilot subscription.',
  quota:
    'Copilot quota exhausted for this token. Wait for the quota to reset or use a different account.',
  network:
    'Could not reach the Copilot service. Check the container egress and DNS.',
  timeout:
    'The Copilot request timed out. The service may be slow or unreachable.',
  unknown: 'Spec generation failed. See the API logs for details.',
};

/**
 * Classify an error from the Copilot SDK into a known auth error category.
 * Best-effort regex matching — falls back to `unknown`.
 */
export function classifyError(err: unknown): { kind: AuthErrorKind; message: string } {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  // Order matters — more specific first.
  if (!hasTokenInEnv() && /token|auth|credential/i.test(lower)) {
    return { kind: 'missing_token', message: HUMAN_MESSAGES.missing_token };
  }
  if (/401|unauthorized|invalid token|bad credentials|expired/.test(lower)) {
    return { kind: 'unauthorized', message: HUMAN_MESSAGES.unauthorized };
  }
  if (/403|forbidden|no access|not entitled|copilot.*subscription|access denied/.test(lower)) {
    return { kind: 'forbidden', message: HUMAN_MESSAGES.forbidden };
  }
  if (/quota|rate limit|429|too many requests|monthly.*limit/.test(lower)) {
    return { kind: 'quota', message: HUMAN_MESSAGES.quota };
  }
  if (/timeout|timed out|deadline/.test(lower)) {
    return { kind: 'timeout', message: HUMAN_MESSAGES.timeout };
  }
  if (/enotfound|econnrefused|econnreset|network|fetch failed|getaddrinfo/.test(lower)) {
    return { kind: 'network', message: HUMAN_MESSAGES.network };
  }
  return { kind: 'unknown', message: `${HUMAN_MESSAGES.unknown} (${raw})` };
}
