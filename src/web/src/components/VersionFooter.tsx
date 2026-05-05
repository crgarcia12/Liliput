'use client';

import { useEffect, useState } from 'react';

/**
 * Bump this manually when you want to confirm a frontend deploy reached production.
 * It's hard-coded so the running bundle reflects the source at build time — the version
 * shown in the footer = the version that's actually running.
 */
export const FRONTEND_VERSION = '0.0.48';

/**
 * Footer pinned at the bottom-right of the viewport showing
 *   FE 0.0.1 | BE 0.0.1
 * so we can verify which deploy is live.
 */
export default function VersionFooter() {
  const [backend, setBackend] = useState<string>('…');
  const [env, setEnv] = useState<string>('');

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

  const envColor =
    env === 'DEV' ? 'text-yellow-300' :
    env === 'TEST' ? 'text-green-300' :
    env === 'PROD' ? 'text-red-300' :
    'text-gray-400';

  return (
    <div
      className="pointer-events-none fixed bottom-1 left-0 right-0 z-50 select-none text-center font-mono text-[10px] text-gray-500"
      title="Environment / Frontend / Backend versions"
    >
      {env && <span className={`${envColor} font-bold mr-2`}>[{env}]</span>}
      FE {FRONTEND_VERSION} | BE {backend}
    </div>
  );
}
