'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AuthStatusBanner } from './AuthStatusBanner';
import { UserMenu } from './UserMenu';

export function AppHeader(): React.JSX.Element | null {
  const pathname = usePathname();
  // Skip the top chrome on:
  //  - public landing + login (own their first impression)
  //  - mobile views (/m/*) which ship their own compact, touch-optimised headers
  if (pathname === '/' || pathname === '/login') return null;
  if (pathname?.startsWith('/m/') || pathname === '/m') return null;

  return (
    <div className="flex items-center gap-3 border-b border-[#2a2a4e] px-4 py-2 bg-[#0d0d14]">
      <Link
        href="/dashboard"
        className="flex items-center gap-2 shrink-0 text-cyan-400 hover:text-cyan-300 transition-colors"
        title="Back to dashboard"
        aria-label="Back to dashboard"
      >
        <span className="text-xl">🏰</span>
        <span className="text-sm font-bold">Liliput</span>
      </Link>
      <div className="flex-1 min-w-0">
        <AuthStatusBanner />
      </div>
      <div className="shrink-0">
        <UserMenu />
      </div>
    </div>
  );
}
