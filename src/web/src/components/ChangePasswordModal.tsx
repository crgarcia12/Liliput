'use client';

import { useEffect, useRef, useState } from 'react';
import { changePassword } from '@/lib/api-client';

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Modal that lets the currently-logged-in admin rotate their own password.
 *
 * On success the modal stays open for ~1s to show a "Password updated"
 * confirmation, then closes. We do NOT force a logout: the existing JWT
 * remains valid until it expires (24h).
 */
export function ChangePasswordModal({ open, onClose }: Props): React.JSX.Element | null {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  // Reset form whenever the modal opens.
  useEffect(() => {
    if (open) {
      setCurrent('');
      setNext('');
      setConfirm('');
      setError(null);
      setSuccess(false);
      setSubmitting(false);
      // Focus the first field on open so it's keyboard-driveable.
      setTimeout(() => firstFieldRef.current?.focus(), 0);
    }
  }, [open]);

  // ESC closes the modal.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, submitting, onClose]);

  if (!open) return null;

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    if (next.length < 8) {
      setError('New password must be at least 8 characters long');
      return;
    }
    if (next !== confirm) {
      setError('New password and confirmation do not match');
      return;
    }
    if (next === current) {
      setError('New password must differ from current password');
      return;
    }
    setSubmitting(true);
    try {
      await changePassword(current, next);
      setSuccess(true);
      // Close after a short moment so the success state is visible.
      setTimeout(() => onClose(), 1200);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Change password failed';
      setError(message);
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
      onClick={() => {
        if (!submitting) onClose();
      }}
    >
      <div
        className="bg-[#0d0d14] border border-[#3a3a5e] rounded shadow-xl w-full max-w-sm p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-mono text-[#e0e0e8] mb-4">Change password</h2>

        <form onSubmit={submit} className="space-y-3">
          <label className="block text-xs text-[#a0a0a8]">
            Current password
            <input
              ref={firstFieldRef}
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
              autoComplete="current-password"
              className="mt-1 w-full px-3 py-2 bg-[#1a1a2e] border border-[#3a3a5e] rounded text-sm text-[#e0e0e8] focus:outline-none focus:border-[#6a6aae]"
              disabled={submitting || success}
            />
          </label>

          <label className="block text-xs text-[#a0a0a8]">
            New password
            <input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              className="mt-1 w-full px-3 py-2 bg-[#1a1a2e] border border-[#3a3a5e] rounded text-sm text-[#e0e0e8] focus:outline-none focus:border-[#6a6aae]"
              disabled={submitting || success}
            />
          </label>

          <label className="block text-xs text-[#a0a0a8]">
            Confirm new password
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              className="mt-1 w-full px-3 py-2 bg-[#1a1a2e] border border-[#3a3a5e] rounded text-sm text-[#e0e0e8] focus:outline-none focus:border-[#6a6aae]"
              disabled={submitting || success}
            />
          </label>

          {error && (
            <div
              role="alert"
              className="text-xs text-[#ff8080] bg-[#2a1414] border border-[#5a2a2a] rounded px-3 py-2"
            >
              {error}
            </div>
          )}
          {success && (
            <div
              role="status"
              className="text-xs text-[#80ff80] bg-[#142a14] border border-[#2a5a2a] rounded px-3 py-2"
            >
              Password updated.
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-3 py-1.5 text-sm text-[#d0d0d8] hover:text-[#e0e0e8] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || success}
              className="px-3 py-1.5 text-sm bg-[#3a3a8e] hover:bg-[#4a4aae] disabled:opacity-50 rounded text-[#e0e0e8]"
            >
              {submitting ? 'Updating…' : 'Update password'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
