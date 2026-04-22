# Sample PRD: Task Board

> **For microhack participants:** This is a reference PRD to help you write your own.
> Read through it, then close it and write `specs/prd.md` in your own words.
> Your version doesn't need to match this exactly — the agents will work with whatever you give them.

---

## Product Name

Task Board

## Overview

A minimal, single-user task board for tracking personal work items. Users can create tasks, organise them by status, and mark them as complete — all without signing in.

## Goals

- Let a user quickly capture tasks without friction (no login, no setup)
- Give a clear visual picture of what's in progress vs. done
- Be deployable as a public web app in minutes

## Non-Goals

- Multi-user collaboration or sharing
- Authentication or user accounts
- Due dates, priorities, or labels (out of scope for v1)
- Persistence beyond the server process (an in-memory store is fine for this hack)

## User Stories

### US-01 — Create a Task

As a user, I want to create a task with a title and an optional description so that I can capture what I need to do.

**Acceptance criteria:**
- There is a form (or modal) with a required title field and an optional description field
- Submitting an empty title shows a validation error
- On success, the new task appears immediately in the "To Do" column without a page reload
- Task titles are limited to 120 characters

### US-02 — View the Board

As a user, I want to see all my tasks organised into three columns — **To Do**, **In Progress**, and **Done** — so that I can see the state of my work at a glance.

**Acceptance criteria:**
- The board always shows all three columns, even when empty
- Each task card shows its title and a truncated description (if any)
- Columns show a count of tasks they contain
- The board loads in under 2 seconds

### US-03 — Move a Task

As a user, I want to move a task to a different status column so that I can reflect its real progress.

**Acceptance criteria:**
- Each task card has controls to move it forward or backward one step (To Do ↔ In Progress ↔ Done)
- Moving a task updates the board immediately without a page reload
- A task in "To Do" can only move to "In Progress" (not jump to "Done")
- A task in "Done" can move back to "In Progress"

### US-04 — Edit a Task

As a user, I want to edit a task's title and description so that I can correct mistakes or add detail.

**Acceptance criteria:**
- Clicking a task title opens it for editing (inline or modal — agent's choice)
- Saving an empty title is not allowed
- Changes persist immediately on the board

### US-05 — Delete a Task

As a user, I want to delete a task so that I can remove things I no longer need to track.

**Acceptance criteria:**
- Each task card has a delete button/icon
- A confirmation prompt is shown before deletion (to prevent accidents)
- The task disappears from the board immediately on confirmation

## Technical Notes

- **Backend:** Express.js REST API (Node.js + TypeScript). In-memory store — no database needed.
- **Frontend:** Next.js App Router with Tailwind CSS.
- **State:** Tasks have `id`, `title`, `description`, `status` (`todo` | `in_progress` | `done`), and `createdAt`.
- **API:** RESTful — `GET /api/tasks`, `POST /api/tasks`, `PATCH /api/tasks/:id`, `DELETE /api/tasks/:id`.
- **No auth required.**

## Success Metric

A developer with no prior knowledge of the codebase can go from this PRD to a live, tested app deployed on Azure Container Apps in under 2 hours.
