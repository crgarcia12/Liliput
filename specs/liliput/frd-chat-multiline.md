# FRD-MC — Multiline Chat Input

## 1. Summary

The chat input on the task page (`src/web/src/app/task/[id]/page.tsx`) and on the new-task panel (`src/web/src/app/page.tsx`) becomes a multiline, auto-growing `<textarea>` with chat-app submit semantics.

## 2. Behaviour

| Event | Result |
|---|---|
| Type chars | Textarea grows in height to fit content, up to ~10 line max. After max, content scrolls inside the textarea. |
| `Enter` (no modifier) | Submit the message. Same behaviour as today's submit button. |
| `Shift+Enter` | Insert a literal newline in the textarea. Do NOT submit. |
| `Enter` with empty / whitespace-only text | Do nothing (no submit, no newline). Matches current button behaviour. |
| Click "Send" button | Submit. |
| Submit while a request is in flight | Ignored (button disabled, Enter no-op). |

## 3. Rendering

- In chat bubbles, newlines in user/assistant messages are preserved (`whitespace-pre-wrap` on the bubble's text container — most bubbles already do this, audit and add where missing).
- The textarea has a min height of ~1 line (matches the current input bar visually) and a max height of ~10 lines (≈ `40vh` cap).

## 4. Affected Files

- `src/web/src/app/task/[id]/page.tsx` — chat composer at the bottom of the task page.
- `src/web/src/app/page.tsx` — "describe your task" composer on the home / new-task panel (only the `description` field; `title` and `repo` stay single-line).
- A small shared component is fine if it cleans things up (e.g. `src/web/src/components/AutoGrowTextarea.tsx`), but not required.

## 5. Tests

- Vitest+RTL component tests for the new textarea behaviour:
  - Pressing `Enter` calls the submit handler.
  - Pressing `Shift+Enter` inserts `\n` and does not submit.
  - Empty/whitespace `Enter` does nothing.
  - Height grows with content, capped at the max.
- Playwright e2e: paste a 3-line description into the new-task form, hit Enter, see all 3 lines preserved in the first chat bubble.

## 6. Out of Scope

- Markdown/rich-text rendering of user messages.
- Slash-commands.
- Drag-and-drop attachments.
