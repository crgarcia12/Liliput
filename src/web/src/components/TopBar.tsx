'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * Liliput top bar. Two rows on narrow viewports, one row on wide.
 * - Row 1 (left): brand + page title slot
 * - Row 1 (right): primary call-to-action ("+ New workstream") + connection chip
 * - Row 2: navigation pills with uniform sizing — replaces the previous mix
 *   of bare links and a single coloured button at varying widths.
 */

export interface TopBarProps {
  /** Optional sub-title shown after "Liliput — ". e.g. "Workstreams". */
  subtitle?: string;
  /** Connection state — used by pages that own a socket. */
  connected?: boolean;
  /** Right-aligned extra controls (filters, status badges, etc). */
  extras?: ReactNode;
  /** Hide the "+ New workstream" CTA — already on the new page itself. */
  hideNewCta?: boolean;
}

const NAV: Array<{ href: string; label: string; icon: string }> = [
  { href: '/', label: 'Workstreams', icon: '📋' },
  { href: '/now', label: 'Now', icon: '⏱' },
  { href: '/dev-environments', label: 'Dev envs', icon: '☁️' },
  { href: '/verdicts', label: 'Verdicts', icon: '⚖️' },
  { href: '/tool-wishes', label: 'Tool wishes', icon: '🛠' },
];

export default function TopBar({ subtitle, connected, extras, hideNewCta }: TopBarProps) {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname?.startsWith(href);

  return (
    <header className="border-b border-[#1a1a2e] bg-[#0d0d14]">
      {/* Row 1 — brand + CTA */}
      <div className="flex items-center justify-between px-6 py-2.5">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-2xl shrink-0">🏰</span>
          <h1 className="text-lg font-bold tracking-tight truncate">
            <Link href="/" className="text-cyan-400 hover:text-cyan-300">
              Liliput
            </Link>
            {subtitle && (
              <span className="text-gray-500 font-normal"> — {subtitle}</span>
            )}
          </h1>
        </div>
        <div className="flex items-center gap-3 text-xs shrink-0">
          {extras}
          {typeof connected === 'boolean' && (
            <span
              className={`px-2 py-1 rounded-full border text-[11px] ${
                connected
                  ? 'border-green-500/40 text-green-400 bg-green-500/5'
                  : 'border-red-500/40 text-red-400 bg-red-500/5'
              }`}
              title={connected ? 'Live socket connected' : 'Socket disconnected'}
            >
              {connected ? '● live' : '○ offline'}
            </span>
          )}
          {!hideNewCta && (
            <Link
              href="/new"
              className="inline-flex items-center h-7 px-3 rounded-md bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold shadow-sm transition-colors"
            >
              + New workstream
            </Link>
          )}
        </div>
      </div>
      {/* Row 2 — uniform nav pills */}
      <nav className="flex items-center gap-1 px-4 pb-1.5">
        {NAV.map((item) => {
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`inline-flex items-center h-7 px-3 rounded-md text-xs transition-colors ${
                active
                  ? 'bg-[#1a1a2e] text-cyan-300'
                  : 'text-gray-400 hover:text-gray-100 hover:bg-[#15152a]'
              }`}
            >
              <span className="mr-1.5">{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
