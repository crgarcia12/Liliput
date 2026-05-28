# FRD-CLI-TUI-NAV — CLI TUI Navigation and Scrolling

## 1. Summary

The Liliput CLI includes a terminal UI for viewing tasks, opening task detail,
monitoring agents/activity/chat, and sending chat messages. The TUI must be
usable from a keyboard-first terminal workflow and from terminals that send
mouse-wheel scroll events.

## 2. Behaviour

| ID | Event | Result |
|---|---|---|
| AC-1 | Mouse wheel down/up on the task list | Move the selected task down/up so users can browse beyond the visible rows. |
| AC-2 | `↓`/`↑` or `j`/`k` on the task list | Move the selected task down/up. |
| AC-3 | Mouse wheel down/up on task detail | Scroll the focused pane (`AGENTS`, `ACTIVITY`, or `CHAT`) down/up without changing screens. |
| AC-4 | `Tab` on task detail | Cycle focus through `AGENTS` → `ACTIVITY` → `CHAT` → input. |
| AC-5 | `PageDown`/`PageUp`, `↓`/`↑`, or `j`/`k` on task detail | Scroll the currently focused non-input pane. |
| AC-6 | `i` on task detail | Focus the chat input. While the input is focused, typing edits the input and `Esc` returns focus to the chat pane. |

## 3. Rendering

- The task list remains inside the main TUI alt-screen view; scrolling must not
  rely on the terminal's native scrollback buffer.
- Task-detail pane focus remains visible with the focused panel border.
- The footer lists the most important scroll/navigation keys for the current
  screen.

## 4. Affected Files

- `cli/internal/ui/tasks.go` — task-list table, filtering, and task selection.
- `cli/internal/ui/detail.go` — task-detail panes and chat input.
- `cli/internal/ui/keys.go` — shared key bindings.
- `cli/internal/ui/help.go` — visible keybinding documentation.

## 5. Current Implementation

- Keyboard navigation exists for the task list through the Bubble Tea table.
- Task detail uses Bubbles viewports for agents, activity, and chat panes.
- The TUI starts with Bubble Tea mouse support enabled.

## 6. Known Limitation

- Mouse-wheel events are not currently routed to the task-list table or focused
  task-detail pane, so scrolling with the mouse wheel does nothing.

## 7. Tests

- Go unit test: task-list mouse wheel down moves the selected row.
- Go unit test: task-detail mouse wheel up scrolls the focused chat pane.
- Existing CLI tests continue to pass with keyboard navigation unchanged.
