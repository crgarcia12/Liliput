'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
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

interface LayoutFractions {
  left: number;
  center: number;
}

function parseStoredLayout(raw: string | null): Partial<LayoutFractions> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Partial<LayoutFractions>;
    return {
      ...(typeof parsed.left === 'number' ? { left: parsed.left } : {}),
      ...(typeof parsed.center === 'number' ? { center: parsed.center } : {}),
    };
  } catch {
    return {};
  }
}

function getServerStorageSnapshot(): null {
  return null;
}

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
  const subscribeToStorage = useCallback(
    (onStoreChange: () => void) => {
      const handleStorage = (event: StorageEvent): void => {
        if (event.key === storageKey) onStoreChange();
      };
      window.addEventListener('storage', handleStorage);
      return () => window.removeEventListener('storage', handleStorage);
    },
    [storageKey],
  );
  const getStorageSnapshot = useCallback((): string | null => {
    try {
      return window.localStorage.getItem(storageKey);
    } catch {
      return null;
    }
  }, [storageKey]);
  const storedRaw = useSyncExternalStore(
    subscribeToStorage,
    getStorageSnapshot,
    getServerStorageSnapshot,
  );
  const storedLayout = parseStoredLayout(storedRaw);
  const [localLayout, setLocalLayout] = useState<
    (LayoutFractions & { storageKey: string }) | null
  >(null);
  const activeLocalLayout =
    localLayout?.storageKey === storageKey ? localLayout : null;
  const leftFr = activeLocalLayout?.left ?? storedLayout.left ?? defaults.left;
  const centerFr =
    activeLocalLayout?.center ?? storedLayout.center ?? defaults.center;
  const fractionsRef = useRef({ left: leftFr, center: centerFr });
  const dragging = useRef<null | 'left' | 'right'>(null);

  useEffect(() => {
    fractionsRef.current = { left: leftFr, center: centerFr };
  }, [leftFr, centerFr]);

  const updateLayout = useCallback(
    (layout: LayoutFractions): void => {
      setLocalLayout({ storageKey, ...layout });
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(layout));
      } catch {
        /* quota / private mode - keep the in-memory layout */
      }
    },
    [storageKey],
  );

  const onMove = useCallback(
    (e: PointerEvent) => {
      const which = dragging.current;
      if (!which) return;
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const fr = Math.min(1, Math.max(0, x / rect.width));
      const { left: currentLeft, center: currentCenter } = fractionsRef.current;
      if (which === 'left') {
        // The left handle controls the boundary between left and center.
        // Right pane keeps its current fraction, so center = 1 - leftFr - rightFr.
        const rightFr = 1 - currentLeft - currentCenter;
        const nextLeft = Math.min(
          1 - min.center - rightFr,
          Math.max(min.left, fr),
        );
        const nextCenter = 1 - nextLeft - rightFr;
        fractionsRef.current = { left: nextLeft, center: nextCenter };
        updateLayout({ left: nextLeft, center: nextCenter });
      } else {
        // Right handle controls boundary between center and right.
        // Left pane keeps its fraction; center = fr - leftFr.
        const nextCenter = Math.min(
          1 - currentLeft - min.right,
          Math.max(min.center, fr - currentLeft),
        );
        fractionsRef.current = { left: currentLeft, center: nextCenter };
        updateLayout({ left: currentLeft, center: nextCenter });
      }
    },
    [min.left, min.center, min.right, updateLayout],
  );

  const stop = useCallback(() => {
    dragging.current = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    window.removeEventListener('pointermove', onMove);
  }, [onMove]);

  const start = (which: 'left' | 'right') => (e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = which;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', stop, { once: true });
  };

  // Cleanup if the component unmounts mid-drag.
  useEffect(
    () => () => {
      stop();
      window.removeEventListener('pointerup', stop);
    },
    [stop],
  );

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
