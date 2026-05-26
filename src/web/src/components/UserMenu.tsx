'use client';

import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { logout } from '@/lib/api-client';
import type { SessionToken } from '@/lib/auth-utils';
import { getSessionInfo } from '@/lib/auth-utils';
import { ChangePasswordModal } from './ChangePasswordModal';

export function UserMenu() {
  const pathname = usePathname();
  const [user, setUser] = useState<SessionToken | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [changePwOpen, setChangePwOpen] = useState(false);

  useEffect(() => {
    const sessionInfo = getSessionInfo();
    setUser(sessionInfo);
  }, []);

  if (pathname === '/login') return null;
  if (!user) return null;

  return (
    <>
      <div className="relative">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="px-4 py-2 text-sm text-[#d0d0d8] hover:text-[#e0e0e8] transition-colors"
        >
          👤 {user.username}
        </button>

        {isOpen && (
          <div className="absolute right-0 mt-2 w-48 bg-[#1a1a2e] border border-[#3a3a5e] rounded shadow-lg z-50">
            <div className="px-4 py-2 border-b border-[#3a3a5e] text-xs text-[#a0a0a8]">
              <div>Username: {user.username}</div>
              <div>Role: {user.role}</div>
            </div>
            <button
              onClick={() => {
                setIsOpen(false);
                setChangePwOpen(true);
              }}
              className="w-full text-left px-4 py-2 text-sm text-[#e0e0e8] hover:bg-[#2a2a4e] transition-colors border-b border-[#3a3a5e]"
            >
              Change password
            </button>
            <button
              onClick={() => {
                logout();
                setIsOpen(false);
              }}
              className="w-full text-left px-4 py-2 text-sm text-[#e0e0e8] hover:bg-[#2a2a4e] transition-colors"
            >
              Logout
            </button>
          </div>
        )}
      </div>

      <ChangePasswordModal
        open={changePwOpen}
        onClose={() => setChangePwOpen(false)}
      />
    </>
  );
}
