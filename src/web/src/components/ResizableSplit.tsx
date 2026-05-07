'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/**
 * Three-column horizontal split with two drag handles.
 *
 * Persists the two split fractions (left + center) in localStorage under
 * `storageKey`, so the user's preferred layout survives reloads.
 *
 * Why hand-rolled instead of a dep:
 *   - The whole UI ships in a small Next.js bundle; we don't want a 30 KB
 *     resizable lib for one page.
 *   - The layout is exactly three columns + two handles; nothing fancy.
 */

interface Props {
  storageKey: string;
  /** Initial fractions for left + center (right = 1 - left - center). */
  defaults: { left: number; center: number };
  /** Min fractions per pane to stop a user from collapsing one to nothing. */
  min?: { left: number; center: number; right: number };
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
  className?: string;
}

const DEFAULT_MIN = { left: 0.15, center: 0.2, right: 0.15 };

export default function ResizableSplit({
  storageKey,
  defaults,
  min = DEFAULT_MIN,
  left,
  center,
  right,
  className,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Fractions of total width (so the layout adapts to viewport changes).
  const [leftFr, setLeftFr] = useState<number>(defaults.left);
  const [centerFr, setCenterFr] = useState<number>(defaults.center);
  const dragging = useRef<null | 'left' | 'right'>(null);

  // Hydrate from localStorage on mount.
  useLayoutEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { left?: number; center?: number };
      if (typeof parsed.left === 'number') setLeftFr(parsed.left);
      if (typeof parsed.center === 'number') setCenterFr(parsed.center);
    } catch {
      /* ignore corrupted prefs */
    }
  }, [storageKey]);

  // Persist on change.
  useEffect(() => {
    try {
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({ left: leftFr, center: centerFr }),
      );
    } catch {
      /* quota / private mode — ignore */
    }
  }, [storageKey, leftFr, centerFr]);

  const onMove = useCallback(
    (e: PointerEvent) => {
      const which = dragging.current;
      if (!which) return;
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const fr = Math.min(1, Math.max(0, x / rect.width));
      if (which === 'left') {
        // The left handle controls the boundary between left and center.
        // Right pane keeps its current fraction, so center = 1 - leftFr - rightFr.
        const rightFr = 1 - leftFr - centerFr;
        const nextLeft = Math.min(
          1 - min.center - rightFr,
          Math.max(min.left, fr),
        );
        const nextCenter = 1 - nextLeft - rightFr;
        setLeftFr(nextLeft);
        setCenterFr(nextCenter);
      } else {
        // Right handle controls boundary between center and right.
        // Left pane keeps its fraction; center = fr - leftFr.
        const nextCenter = Math.min(
          1 - leftFr - min.right,
          Math.max(min.center, fr - leftFr),
        );
        setCenterFr(nextCenter);
      }
    },
    [leftFr, centerFr, min.left, min.center, min.right],
  );

  const stop = useCallback(() => {
    dragging.current = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', stop);
  }, [onMove]);

  const start = (which: 'left' | 'right') => (e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = which;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', stop);
  };

  // Cleanup if the component unmounts mid-drag.
  useEffect(() => () => stop(), [stop]);

  const rightFr = Math.max(min.right, 1 - leftFr - centerFr);

  return (
    <div
      ref={containerRef}
      className={`flex w-full h-full overflow-hidden ${className ?? ''}`}
    >
      <div
        style={{ width: `${leftFr * 100}%` }}
        className="min-w-0 h-full overflow-hidden"
      >
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={start('left')}
        className="w-1.5 shrink-0 cursor-col-resize bg-[#1a1a2e] hover:bg-cyan-700/60 active:bg-cyan-600 transition-colors"
        title="Drag to resize"
      />
      <div
        style={{ width: `${centerFr * 100}%` }}
        className="min-w-0 h-full overflow-hidden"
      >
        {center}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={start('right')}
        className="w-1.5 shrink-0 cursor-col-resize bg-[#1a1a2e] hover:bg-cyan-700/60 active:bg-cyan-600 transition-colors"
        title="Drag to resize"
      />
      <div
        style={{ width: `${rightFr * 100}%` }}
        className="min-w-0 h-full overflow-hidden"
      >
        {right}
      </div>
    </div>
  );
}
