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
  { href: '/dashboard', label: 'Workstreams', icon: '📋' },
  { href: '/now', label: 'Now', icon: '⏱' },
  { href: '/dev-environments', label: 'Dev envs', icon: '☁️' },
  { href: '/verdicts', label: 'Verdicts', icon: '⚖️' },
  { href: '/tool-wishes', label: 'Tool wishes', icon: '🛠' },
];

export default function TopBar({ subtitle, connected, extras, hideNewCta }: TopBarProps) {
  const pathname = usePathname();
  const isActive = (href: string) =>
    pathname === href || pathname?.startsWith(`${href}/`);

  return (
    <header className="border-b border-[#1a1a2e] bg-[#0d0d14]">
      {/* Single compact row: brand · nav pills · extras · connection · CTA */}
      <div className="flex items-center gap-2 px-4 py-2">
        <Link
          href="/dashboard"
          className="flex items-center gap-2 mr-3 shrink-0"
          title="Liliput home"
        >
          <span className="text-xl">🏰</span>
          <span className="text-sm font-bold text-cyan-400 hover:text-cyan-300">
            Liliput
          </span>
          {subtitle && (
            <span className="hidden md:inline text-xs text-gray-500 font-normal ml-1 truncate max-w-[28ch]">
              · {subtitle}
            </span>
          )}
        </Link>
        <nav className="flex items-center gap-1 flex-1 min-w-0 overflow-x-auto">
          {NAV.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`inline-flex items-center h-7 px-3 rounded-md text-xs whitespace-nowrap transition-colors ${
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
        <div className="flex items-center gap-2 text-xs shrink-0">
          {extras}
          <Link
            href="/m"
            className="text-xs text-gray-400 hover:text-cyan-300 whitespace-nowrap"
            title="Mobile view"
          >
            📱 Mobile
          </Link>
          {typeof connected === 'boolean' && (
            <span
              className={`inline-flex items-center h-7 px-2.5 rounded-md border text-[11px] ${
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
    </header>
  );
}
