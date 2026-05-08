'use client';

import { useEffect, useState } from 'react';

/**
 * Bump this manually when you want to confirm a frontend deploy reached production.
 * It's hard-coded so the running bundle reflects the source at build time — the version
 * shown in the footer = the version that's actually running.
 */
export const FRONTEND_VERSION = '0.0.79';

/**
 * Footer pinned at the bottom of the viewport. Real opaque bar (NOT a
 * floating overlay) so it never obscures content. Shows:
 *   ● Connected · [ENV] · FE x.y.z | BE x.y.z
 *
 * The connection chip is driven by a `liliput:connection` CustomEvent that
 * pages with sockets dispatch on connect/disconnect. We don't own the
 * socket here (each page does), so a tiny global event channel keeps this
 * component zero-dependency and per-page-agnostic.
 */
export default function VersionFooter() {
  const [backend, setBackend] = useState<string>('…');
  const [env, setEnv] = useState<string>('');
  // `null` = no socket on this page; true/false = explicit state.
  const [connected, setConnected] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchVersion = async () => {
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { version?: string; env?: string };
        if (!cancelled) {
          setBackend(body.version ?? '?');
          setEnv(body.env ?? '');
        }
      } catch {
        if (!cancelled) setBackend('offline');
      }
    };
    void fetchVersion();
    const id = setInterval(fetchVersion, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ connected: boolean }>;
      if (ce.detail && typeof ce.detail.connected === 'boolean') {
        setConnected(ce.detail.connected);
      }
    };
    window.addEventListener('liliput:connection', handler as EventListener);
    return () =>
      window.removeEventListener('liliput:connection', handler as EventListener);
  }, []);

  const envColor =
    env === 'DEV' ? 'text-yellow-300' :
    env === 'TEST' ? 'text-green-300' :
    env === 'PROD' ? 'text-red-300' :
    'text-gray-400';

  return (
    <footer
      className="shrink-0 h-6 flex items-center justify-between px-3 border-t border-[#1a1a2e] bg-[#0d0d14] font-mono text-[10px] text-gray-500 select-none"
      title="Connection / Environment / Frontend / Backend versions"
    >
      <div className="flex items-center gap-3">
        {connected === null ? (
          <span className="text-gray-600">○ no socket</span>
        ) : connected ? (
          <span className="text-green-400">● Connected</span>
        ) : (
          <span className="text-red-400">○ Disconnected</span>
        )}
        {env && <span className={`${envColor} font-bold`}>[{env}]</span>}
      </div>
      <div>
        FE {FRONTEND_VERSION} | BE {backend}
      </div>
    </footer>
  );
}

