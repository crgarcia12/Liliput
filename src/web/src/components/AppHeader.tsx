'use client';

import { usePathname } from 'next/navigation';
import { AuthStatusBanner } from './AuthStatusBanner';
import { UserMenu } from './UserMenu';

export function AppHeader(): React.JSX.Element | null {
  const pathname = usePathname();
  // Skip the top chrome on public pages so they can own the full first impression.
  if (pathname === '/' || pathname === '/login') return null;

  return (
    <div className="flex items-center justify-between border-b border-[#2a2a4e] px-4 py-2 bg-[#0d0d14]">
      <AuthStatusBanner />
      <UserMenu />
    </div>
  );
}
