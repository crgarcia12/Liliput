# PRD — Multiline Chat + Greenfield Repo Creation

> **Note:** `specs/prd.md` describes a sample auth app, not Liliput itself.
> This PRD scopes a Liliput-product change. Future Liliput PRDs should land
> under `specs/liliput/`.

## 1. Overview

Two product changes that together let a Gulliver (operator) start a project from **zero** instead of only attaching agents to an existing GitHub repo:

1. **Multiline chat input.** Today the chat box is single-line. Anything richer than a one-liner (paste a stack trace, draft a multi-paragraph spec) is awful. We make the textarea multiline, submit on `Enter`, newline on `Shift+Enter`, and auto-grow to a reasonable max height.
2. **Greenfield repo creation.** Today the "new task" form requires an existing `owner/repo`. We add a "Create new project" path that:
   - creates a brand-new GitHub repo under the authenticated user (`crgarcia12`),
   - bootstraps it with `npx spec2cloud init --ref vNext` (commits + pushes the initial `AGENTS.md`, `specs/`, etc),
   - hands the repo to the standard Liliput agent loop with the user's description as the first prompt and the existing `LILIPUT_DEPLOY_CONTRACT.md` so the agent knows it must produce a containerised app reachable via the Liliput ingress at `/dev/{owner}/{repo}/{branch}/`.

## 2. Goals

- Reduce the "I have an idea" → "agent is iterating on real code" friction from "go to GitHub, scaffold a repo, install spec2cloud manually, then come back" to **a single button**.
- Stop forcing single-line prompts. The first prompt is also the most important one — make it pleasant to write.
- Keep the existing flow (attach to existing repo) unchanged. The new path is **additive**.

## 3. Out of Scope (this PR)

- Org-owned repos. Always created under `crgarcia12` for now.
- Public repos by default. Visibility is asked per-create; default `private`.
- A new hierarchy level (repo → spec → task). Considered, but explicitly deferred to keep this PR small. Tasks continue to attach via the existing workstream.
- Letting the user pick the spec2cloud `--ref` from the UI. We hardcode `vNext`.
- Re-running `spec2cloud init` against an existing repo (idempotency / upgrades).

## 4. Personas

- **Gulliver (operator).** Has an idea, types it into a textarea, walks away. Comes back to a deployed dev URL.
- **Coder Liliputian (agent).** Inherits a fresh repo with the spec2cloud scaffolding and the Liliput deploy contract. Drives PRD → FRD → tests → impl per `AGENTS.md`.

## 5. User Stories

### US-1: Multiline first prompt
**As** Gulliver,  **I want** to write a multi-paragraph description in the chat,  **so that** I don't have to compress my idea into a single line.

**AC:**
- The chat textarea expands as I type, up to a max height (~10 visual lines), then becomes scrollable.
- `Enter` submits. `Shift+Enter` inserts a newline.
- After submit, the textarea clears and shrinks back to 1 line.
- Newlines I typed are preserved in the rendered chat bubble.

### US-2: Create a brand-new project
**As** Gulliver,  **I want** to create a new GitHub repo and immediately start the agent on it,  **so that** I don't have to scaffold anything by hand.

**AC:**
- The "new task" panel offers a clear toggle: **Use existing repo** | **Create new project**.
- "Create new project" requires: repo name (validated against GitHub naming rules), description (this becomes the first agent prompt), visibility (`private` default, `public` opt-in).
- Submitting:
  1. creates the GitHub repo under `crgarcia12`,
  2. clones it,
  3. runs `npx spec2cloud init --ref vNext` against the clone,
  4. writes `LILIPUT_DEPLOY_CONTRACT.md`,
  5. commits + pushes,
  6. starts a normal Liliput task with the description as the first user prompt,
  7. shows progress in the standard task UI.
- If repo creation fails (name taken, network error, token missing scope), the form surfaces the error inline and **does not** create a half-initialised task.
- If `spec2cloud init` fails after the repo was created, the task is created with a system message describing the failure so Gulliver can decide whether to retry or delete the repo manually.

## 6. Constraints / Non-Functional

- Auth uses the existing `COPILOT_GITHUB_TOKEN` (already has `repo` scope; verified).
- The whole new-project bootstrap (repo create → push initial commit → task start) must complete in under ~60s on a clean run, or the UI must show progress so it doesn't look frozen.
- No new persisted data shape. The created task is a normal `Task` with `repository = "crgarcia12/<name>"`.

## 7. Feature Breakdown

| FRD | Title |
|---|---|
| FRD-MC | Multiline chat input ([frd-chat-multiline.md](./frd-chat-multiline.md)) |
| FRD-RC | Greenfield repo creation ([frd-repo-creation.md](./frd-repo-creation.md)) |

## 8. Future work (deferred, not this PR)

- Hierarchy `repo → spec → tasks` (proposed name: **spec**, matching spec2cloud terminology). Today's `workstream` would become `spec`. Out of scope here, but worth doing once the create-repo path bakes.
- Allow the operator to pick the spec2cloud version (`--ref`) per repo.
- "Delete repo" support (matches the earlier session-delete request), with explicit confirmation; never deletes the GitHub repo, only the local namespace + branch.
