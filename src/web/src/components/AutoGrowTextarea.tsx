'use client';

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from 'react';
import type { TextareaHTMLAttributes } from 'react';

export interface AutoGrowTextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onSubmit'> {
  value: string;
  onValueChange: (next: string) => void;
  /** Submit handler. Called when Enter is pressed without Shift, and the
   *  trimmed value is non-empty. The textarea is NOT auto-cleared — the
   *  caller decides whether to clear after submit. */
  onSubmit?: (value: string) => void;
  /** Max height in CSS pixels before the textarea starts scrolling. */
  maxHeightPx?: number;
  /** Min rows shown when empty. Defaults to 1. */
  minRows?: number;
}

/**
 * Multi-line textarea that:
 *  - Auto-grows in height to fit its content.
 *  - Caps its height at `maxHeightPx`, then scrolls inside.
 *  - Submits on `Enter` (when `onSubmit` is provided and the value is non-empty).
 *  - Inserts a literal newline on `Shift+Enter`.
 *
 * The component is uncontrolled-from-the-DOM-perspective but takes `value`
 * as a controlled prop — typical chat-input pattern.
 */
const AutoGrowTextarea = forwardRef<HTMLTextAreaElement, AutoGrowTextareaProps>(
  function AutoGrowTextarea(
    {
      value,
      onValueChange,
      onSubmit,
      onKeyDown,
      maxHeightPx = 240,
      minRows = 1,
      className,
      disabled,
      ...rest
    },
    forwardedRef,
  ) {
    const innerRef = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(forwardedRef, () => innerRef.current as HTMLTextAreaElement, []);

    // Resize on every value change.
    useLayoutEffect(() => {
      const el = innerRef.current;
      if (!el) return;
      el.style.height = 'auto';
      const next = Math.min(el.scrollHeight, maxHeightPx);
      el.style.height = `${next}px`;
      el.style.overflowY = el.scrollHeight > maxHeightPx ? 'auto' : 'hidden';
    }, [value, maxHeightPx]);

    // Initial size on mount.
    useEffect(() => {
      const el = innerRef.current;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, maxHeightPx)}px`;
    }, [maxHeightPx]);

    return (
      <textarea
        ref={innerRef}
        value={value}
        rows={minRows}
        disabled={disabled}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            if (onSubmit) {
              const trimmed = value.trim();
              if (trimmed && !disabled) {
                e.preventDefault();
                onSubmit(value);
                return;
              }
              if (!trimmed) {
                // Swallow Enter on empty/whitespace input — matches chat UX.
                e.preventDefault();
                return;
              }
            }
          }
          onKeyDown?.(e);
        }}
        className={className}
        {...rest}
      />
    );
  },
);

export default AutoGrowTextarea;
