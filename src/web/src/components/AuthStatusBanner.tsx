'use client';

import { useAuthStatus } from '../hooks/useAuthStatus';
import type { AuthErrorKind } from '@shared/types';

const TITLES: Record<AuthErrorKind, string> = {
  missing_token: 'Copilot token is not configured',
  unauthorized: 'Copilot token is invalid or expired',
  forbidden: 'Copilot subscription / access denied',
  quota: 'Copilot quota exhausted',
  network: 'Cannot reach Copilot service',
  timeout: 'Copilot request timed out',
  unknown: 'Spec generation problem',
};

const ACTIONS: Partial<Record<AuthErrorKind, string>> = {
  missing_token:
    'Add the COPILOT_GITHUB_TOKEN secret in GitHub → Settings → Secrets, then run the Deploy workflow.',
  unauthorized:
    'Generate a new Personal Access Token for a user with Copilot access, update the COPILOT_GITHUB_TOKEN secret in GitHub, and run the Rotate workflow.',
  forbidden:
    'Verify the token belongs to a user with an active GitHub Copilot subscription. If correct, regenerate it and update the COPILOT_GITHUB_TOKEN secret.',
  quota: 'Wait until your Copilot quota resets, or use a different account.',
};

export function AuthStatusBanner(): React.JSX.Element | null {
  const { status, refresh, refreshing } = useAuthStatus();

  // Hide while initial state unknown or healthy.
  if (!status || status.ok !== false) return null;

  const kind: AuthErrorKind = status.errorKind ?? 'unknown';
  const title = TITLES[kind];
  const action = ACTIONS[kind];

  return (
    <div
      role="alert"
      className="sticky top-0 z-50 w-full border-b border-red-700 bg-red-950/90 px-4 py-3 text-sm text-red-100 backdrop-blur"
    >
      <div className="mx-auto flex max-w-6xl items-start gap-3">
        <span aria-hidden className="mt-0.5 text-base">⚠️</span>
        <div className="flex-1">
          <div className="font-semibold text-red-50">{title}</div>
          {status.message && <div className="mt-0.5 text-red-200">{status.message}</div>}
          {action && <div className="mt-1 text-red-300">{action}</div>}
          {status.lastCheckedAt && (
            <div className="mt-1 text-xs text-red-400">
              Last checked: {new Date(status.lastCheckedAt).toLocaleString()}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing}
          className="shrink-0 rounded border border-red-600 px-3 py-1 text-xs font-medium text-red-100 hover:bg-red-900 disabled:opacity-50"
        >
          {refreshing ? 'Checking…' : 'Re-check'}
        </button>
      </div>
    </div>
  );
}
