# FRD-RC — Greenfield Repo Creation

## 1. Summary

A new path on the home page lets Gulliver create a brand-new GitHub repo, bootstrap it with `spec2cloud`, and immediately start a Liliput agent against it. The created repo lives under the authenticated user's GitHub account (`crgarcia12`). The repo is **never deleted** by Liliput; only the local namespace / branch may be cleaned up later.

## 2. UI

The new-task panel grows a top-level toggle:

```
( ● ) Use existing repo        ( ○ ) Create new project
```

### "Use existing repo" (today's flow — unchanged)
- Title, repository (`owner/repo`), description.
- Submit creates a task as today.

### "Create new project" (new)
Form fields:

| Field | Type | Validation |
|---|---|---|
| Project name | text | 1–60 chars, GitHub repo naming rules: `[a-zA-Z0-9._-]+`, doesn't start with `.` or `-`. Live-validated against `GET /api/repo-create/check-name?name=…` (HEAD on `https://github.com/crgarcia12/<name>` via the API server, NOT the browser, so we don't burn the user's anonymous rate limit). |
| Description | textarea (multiline per FRD-MC) | required, 1–4000 chars. Becomes the first chat message. |
| Visibility | radio | `private` (default) or `public`. |
| Initial branch | text (optional, default `main`) | letters/numbers/`-_/.`. |

Submitting shows an inline progress strip with these steps (each flips ✅ when done, ❌ on error):

1. Create GitHub repo
2. Clone into agent workspace
3. Run `npx spec2cloud init --ref vNext`
4. Write `LILIPUT_DEPLOY_CONTRACT.md`
5. Commit & push
6. Start agent

On step 6 success, the browser navigates to `/task/{taskId}`.

## 3. API

### `POST /api/projects` (new)
**Request:**
```json
{
  "name": "modern-winamp",
  "description": "rebuild winamp as a web app",
  "visibility": "private",
  "initialBranch": "main"
}
```
**Response (201):**
```json
{
  "task": { "id": "...", "repository": "crgarcia12/modern-winamp", "status": "clarifying", ... },
  "repository": { "owner": "crgarcia12", "name": "modern-winamp", "htmlUrl": "https://github.com/crgarcia12/modern-winamp", "visibility": "private" }
}
```

**Error responses:**
- `400` — invalid name / description / visibility (with `{ field, error }`).
- `409` — repo name already exists under `crgarcia12`.
- `502` — GitHub API call failed (rate-limited, network).
- `500` — anything else (with `details`).

**Implementation outline (`src/api/src/services/project-bootstrap.ts`):**

```ts
async function bootstrapProject(input): Promise<{ task, repository }> {
  // 1. Pre-flight: name is well-formed, repo doesn't exist yet.
  // 2. Create repo via GitHub REST: POST /user/repos
  //    body: { name, description, private: visibility==='private', auto_init: true }
  //    Wait for the default branch to exist (poll once or twice; auto_init creates it).
  // 3. Clone into <agent-workspace-root>/crgarcia12-<name>/ on disk.
  // 4. Spawn `npx --yes spec2cloud init --ref vNext` in that dir. Stream stdout to logger.
  //    Fail with a structured error if the process exits non-zero.
  // 5. Call writeContractIntoWorkspace(...) to drop LILIPUT_DEPLOY_CONTRACT.md.
  // 6. git add -A && git commit -m "chore: spec2cloud init + Liliput contract" && git push
  // 7. Build a CreateTaskRequest{ title=name, description, repository: 'crgarcia12/<name>', baseBranch: initialBranch }
  //    and reuse the existing task-creation path. The description becomes the first user chat message.
  //    The agent loop kicks off as today.
  // 8. Return { task, repository }.
}
```

### `GET /api/projects/check-name?name=<name>` (new)
- Validates the name format.
- Calls GitHub `GET /repos/crgarcia12/<name>` to detect collisions.
- Returns `{ available: boolean, reason?: string }`.

### Existing `POST /api/tasks` — unchanged.

## 4. Token & Scopes

- Uses `COPILOT_GITHUB_TOKEN` already required by Liliput.
- Required scope: `repo` (already present per `gh auth status`).
- The token is the **user's** PAT — repos are created under that user. We document this in the README.

## 5. Agent Context (what the new repo's agent sees)

Once the repo is bootstrapped:

- `AGENTS.md` (from spec2cloud init) at repo root → tells the agent how to drive PRD → FRD → tests → impl.
- `LILIPUT_DEPLOY_CONTRACT.md` (written by Liliput) at repo root → tells the agent **specifically**:
  - The app must run as a containerised service in AKS.
  - The Liliput ingress will route `/dev/{owner}/{repo}/{branch}/` → the service in the agent's namespace.
  - Container must listen on `$PORT` (default 8080) and respect the path prefix.
  - Health endpoint expected at `/healthz`.
  - The deploy contract is regenerated/refreshed automatically each loop — agent must not hand-edit the section between `<!-- LILIPUT_CONTRACT:BEGIN -->` and `<!-- LILIPUT_CONTRACT:END -->`.

The first user prompt (the description from the form) is sent as a normal chat message after the welcome system message, kicking the standard agent loop.

## 6. Failure Modes

| Failure | Behaviour |
|---|---|
| Name invalid | 400, form shows inline error, repo is **not** created. |
| Name taken | 409, form shows "name already exists under crgarcia12 — try another", no repo created. |
| GitHub create fails (5xx, network) | 502, form shows error, no task created. |
| Clone fails (network, disk) | 500, log + system message; the GitHub repo exists but is empty/auto-init only. We **do not** delete it (per project rule: never delete GitHub repos). The form invites Gulliver to retry or delete the repo manually on GitHub. |
| `spec2cloud init` fails | Same — repo exists, but partially initialised. We commit anything that did succeed, push, create the task with a system message describing what failed, and let the agent (or operator) fix it. |
| `git push` fails | Log, system message, task still created so the operator can investigate via the chat. |

## 7. Affected Files

**API (new):**
- `src/api/src/services/project-bootstrap.ts` — orchestrates the 7-step flow.
- `src/api/src/services/github-repo-service.ts` — thin wrapper over `octokit` (or REST via `fetch`) for `createForAuthenticatedUser` + `get`.
- `src/api/src/routes/projects.ts` — `POST /api/projects` and `GET /api/projects/check-name`.

**API (modified):**
- `src/api/src/server.ts` (or wherever routes are registered) — register the new router.

**Web (new):**
- `src/web/src/components/CreateProjectForm.tsx` — the new form + progress strip.
- `src/web/src/hooks/useCreateProject.ts` — calls `POST /api/projects`, exposes `{ submit, progress, error }`.

**Web (modified):**
- `src/web/src/app/page.tsx` — adds the toggle between "Use existing repo" and "Create new project", renders the appropriate form.

## 8. Tests

**Vitest (api):**
- `POST /api/projects` returns 400 on bad name.
- `POST /api/projects` returns 409 when GitHub `get repo` returns 200.
- `POST /api/projects` happy path: mock octokit + child_process; assert task is created with the right `repository`, `description` is the first user chat message, contract file is on disk.
- `GET /api/projects/check-name` returns `{available:false}` when GitHub returns 200.

**Vitest+RTL (web):**
- Toggle switches between forms.
- Submit disabled while validation pending.
- Progress strip flips items as the API streams progress (or, simplest first cut: 6 steps revealed sequentially as the server returns).

**Playwright e2e:**
- Smoke: create a project (against a fixture / mocked API), land on `/task/{id}`, see the description rendered as the first user message.

## 9. Out of Scope

- Letting the operator pick the spec2cloud `--ref`. Hardcoded to `vNext`.
- Repo templates / language selection. spec2cloud handles scaffolding.
- Repo or task **deletion** with branch-cleanup confirmation. Tracked separately — that was the original "(1) delete sessions or repos" ask in the earlier conversation. Not blocking this PR.
