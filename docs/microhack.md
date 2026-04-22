# Microhack: From PRD to Azure in 2 Hours with spec2cloud

**Duration:** ~2–3 hours
**Audience:** Developers
**Goal:** Practice spec-driven development with AI — write a product spec, let agents implement it, and verify at every step that what was built actually matches what you asked for.

---

## What You'll Build

A **Task Board** app — a minimal kanban board where users can capture tasks, move them through *To Do / In Progress / Done*, and delete them when they're finished. No login required. No database — just an in-memory store to keep scope tight.

The whole pipeline — spec refinement, wireframes, test generation, implementation, and Azure deployment — is driven by AI agents. You approve, not type.

---

## The Idea: Spec-Driven Development with AI

Here's a perspective shift that underpins everything in this hack:

> **The most valuable asset in a codebase is not the code — it's the specification.**

Code is an implementation detail. With AI agents, it's also increasingly throwable. Given a good enough spec, you can regenerate the implementation at any time: on a different stack, with a newer framework, optimised for a different cloud. What you can't regenerate — what takes real human judgment to produce — is a precise, verified description of what the software is supposed to do.

This changes how you should think about your work as a developer. Investing time in a rigorous spec isn't overhead. It's the actual deliverable. The code that comes out of it is an artifact.

spec2cloud is built around this idea. Your spec is the single source of truth, and everything in the pipeline is traceable back to it:

```
Your PRD                              ← the real deliverable
  └─ FRDs (formal user stories)       ← spec, formalised
       └─ Gherkin scenarios           ← spec, made executable
            └─ Playwright / Vitest tests  ← spec, running as code
                 └─ Implementation    ← code that satisfies the spec
                      └─ Deployed app ← verified against the spec
```

At no point does the AI invent requirements. Tests are derived from your Gherkin scenarios — not written after the code. Code is written to make those tests pass — nothing more. If the spec changes, you regenerate. If the implementation breaks, you regenerate. The spec stays.

And after deployment, the same tests run against the live URL to confirm the spec survived the entire pipeline — build, container, network, and all.

**The human gates are spec verification checkpoints.** Each one asks: *does this still match what you asked for?* You're not just approving work — you're protecting the integrity of the spec as it flows downstream into tests, code, and infrastructure.

---

## How It Works

spec2cloud uses the **Ralph Loop**: a single AI orchestrator that reads state, determines the next task, picks the right skill, executes, verifies, and repeats — pausing at human gates for your approval.

```
PRD → Spec Refinement → UI Prototypes → Increment Plan → Tech Stack
     → [per increment] Tests (from spec) → Contracts → Implementation → Verify → Deploy → ✅
```

Skills live in `.github/skills/` and cover every phase from spec refinement through Azure deployment.

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | 20+ | `node --version` |
| npm | 10+ | `npm --version` |
| .NET SDK | 9+ | Required for Aspire |
| Azure Developer CLI (`azd`) | Latest | `winget install Microsoft.Azd` or `brew install azd` |
| GitHub Copilot | Latest | VS Code extension + Chat |
| Playwright VS Code Extension | Latest | `ms-playwright.playwright` |
| An Azure subscription | — | Contributor access required |

---

## Step 0 — Fork and Set Up (~15 min)

### 0.1 Create your repo from the template

```bash
gh repo create my-task-board --template EmeaAppGbb/shell-typescript
cd my-task-board
```

### 0.2 Install dependencies

```bash
npm install
cd src/web && npm install && cd ../..
cd src/api && npm install && cd ../..
```

### 0.3 Open in VS Code

```bash
code .
```

Confirm these files exist:

```
specs/prd.md          ← you'll replace this with your PRD
AGENTS.md             ← the orchestrator prompt (don't edit)
.github/skills/       ← all agent skills
azure.yaml            ← AZD service definitions
infra/                ← Azure Bicep templates
```

### 0.4 Log in to Azure

```bash
azd auth login
azd env new microhack
azd env set AZURE_LOCATION eastus
```

> **Checkpoint:** `azd env list` should show your `microhack` environment.

---

## Step 1 — Write Your PRD (~20 min)

This is the only step where you write anything substantial. Everything after this is approval gates.

Open `specs/prd.md` and replace its contents with your own product spec for the Task Board. Write it in plain language — bullet points, paragraphs, whatever feels natural.

Your spec should cover:

- **What the app does** in one or two sentences
- **Who uses it** (in this case: a single user, no auth)
- **The key user stories** — what can the user do, and what does success look like for each?
- **Any technical constraints** (in-memory store, no database, no auth)

**Not sure where to start?** Read the sample PRD in `docs/microhack-sample-prd.md` for reference. Then close it and write your own version from memory — the agents work better with specs written in your own voice.

> **Tip:** Don't try to be exhaustive. 5 user stories is plenty. The agents will ask clarifying questions during spec refinement if anything is ambiguous.

> **Why this step matters:** Your PRD is the ground truth everything else traces back to. The more deliberately you write it, the more meaningful the verification is at every downstream gate. Vague requirements lead to passing tests that don't actually prove anything.

---

## Step 2 — Phase 1: Product Discovery (~30 min)

Open GitHub Copilot Chat in VS Code. Start a new session and paste this prompt to kick off the orchestrator:

```
@workspace I want to run the spec2cloud pipeline.
Read AGENTS.md and start from Phase 1a (Spec Refinement).
The PRD is in specs/prd.md.
```

Work through four sub-phases. At each human gate, review the output and type **"approved"** (or give feedback) to continue.

### Phase 1a — Spec Refinement

The agent reviews your PRD through product and technical lenses, splits it into Functional Requirements Documents (FRDs), and flags any gaps or ambiguities.

Expect to see files like:
- `specs/frd-tasks.md` — Create, view, edit, delete task flows
- `specs/frd-board.md` — Column layout, status transitions, empty states

**Human gate — spec verification:** Check that every user story from your PRD is represented in an FRD, with clear acceptance criteria. This is your first verification checkpoint: if something is wrong here, fix it now. Anything that slips through will be tested, implemented, and deployed as-is.

### Phase 1b — UI/UX Design

The agent generates interactive HTML wireframe prototypes for every screen and starts a local HTTP server so you can browse them.

Open the URL shown in the terminal (typically `http://localhost:8080`) and walk through the board, the task creation form, and the edit/delete flows.

**Human gate — prototype verification:** Does the UI match what you had in mind when you wrote the PRD? This is your chance to spot gaps before any code exists. An adjustment here costs seconds. The same change post-implementation costs much more.

### Phase 1c — Increment Planning

The agent breaks the FRDs into ordered delivery increments, starting with a walking skeleton. Output: `specs/increment-plan.md`.

A typical plan for the Task Board looks like:

| Increment | What ships |
|-----------|-----------|
| 1 | Walking skeleton — empty board, API health check, wired up and deployed |
| 2 | Task CRUD — create, read, delete tasks; board renders tasks in correct column |
| 3 | Status transitions — move tasks forward/back; edit title and description |

**Human gate:** Approve the plan or ask to reorder increments.

### Phase 1d — Tech Stack Resolution

The agent inventories every library in the stack, queries live documentation, and pins the correct versions and configuration. Output: `specs/tech-stack.md`.

**Human gate:** Approve the tech stack.

---

## Step 3 — Phase 2: Increment Delivery (~60–75 min)

The orchestrator now works through each increment. For each one, it runs four steps automatically.

### Step A — Test Scaffolding

The agent derives the full test suite directly from the Gherkin scenarios in your FRDs — **before any implementation code is written**:

- **Gherkin feature files** — plain-English scenarios translated from your acceptance criteria (`specs/features/`)
- **Playwright e2e tests** — browser-level flows driven by those scenarios (create task → move to In Progress → move to Done → delete)
- **Cucumber step definitions** — wiring Gherkin steps to executable code
- **Vitest unit tests** — API endpoint tests covering each contract

> **Human gate — test verification:** Open `specs/features/` and read the Gherkin scenarios out loud. Do they describe the behaviour you wrote in your PRD? This is the most important gate in the entire pipeline. The tests are the spec in executable form — if they're wrong, the implementation will be wrong too, and it will pass every test while doing so.

After you approve, the agent establishes the **red baseline**: all new tests fail (proving they're real and not trivially passing), while all existing tests continue to pass.

### Step B — Contract Generation

The agent generates API contracts and shared TypeScript types before touching any implementation code:

- `specs/contracts/api/` — REST endpoint specs (routes, request/response shapes)
- `src/shared/` — TypeScript interfaces shared between the API and Web apps
- `specs/contracts/infra/resources.yaml` — infrastructure requirements

No human gate here — the contracts flow directly from the tests.

### Step C — Implementation

The agent implements in three slices:

| Slice | What gets built |
|-------|----------------|
| **API slice** | Express routes (`GET/POST/PATCH/DELETE /api/tasks`), in-memory task store, input validation |
| **Web slice** | Next.js board page, task cards, create/edit form, status transition controls — all wired to the API |
| **Integration** | API + Web running together, full regression suite green |

After each slice the test suite runs. The orchestrator loops until all tests pass.

> **Human gate — implementation verification:** The agent summarises what was built. Review the diff and ask: *does this match what I approved in the Gherkin scenarios?* Tests passing is necessary — but it's not sufficient. You're verifying that the implementation is the right implementation, not just a green one.

### Step D — Deploy to Azure

After all increments are green, the agent runs:

```bash
azd provision   # Creates Azure Container Apps, ACR, and monitoring
azd deploy      # Builds containers and pushes
```

Then it runs smoke tests against the live URL to close the verification loop:
- `GET /health` → 200
- `GET /api/health` → 200
- Full Playwright e2e suite against the deployed endpoint (the same tests derived from your spec)

> **Human gate — deployment verification:** The agent shows you the live URL and smoke test results. Open the app in your browser and manually walk through the user stories from your PRD. Not the tests — *your original words*. This is the final check that the spec you wrote and the app that was built are actually the same thing.

---

## Step 4 — Verify Your Live App (~10 min)

Grab your URL:

```bash
azd env get-values | grep SERVICE_WEB_ENDPOINT_URL
```

Open it and manually verify:

1. Create three tasks — one for each column
2. Move a task from To Do → In Progress → Done
3. Try to move it directly from To Do to Done — it should be blocked
4. Edit a task title
5. Delete a task and confirm the prompt appears

> **Bonus:** Open the Azure portal and explore the Container Apps, Container Registry, and Application Insights resources that were provisioned automatically.

---

## Tear Down

```bash
azd down
```

---

## What Just Happened?

| Phase | What the agents did | What you verified |
|-------|-------------------|------------------|
| Spec Refinement | Turned your PRD into traceable FRDs with acceptance criteria | Every user story is present and correctly interpreted |
| UI/UX Design | Generated interactive wireframes from the FRDs | The UI matches your intent before any code existed |
| Increment Planning | Ordered delivery so a walking skeleton ships first | The scope and ordering make sense for your spec |
| Tech Stack | Queried live docs to pin correct library versions | The stack is appropriate and up to date |
| Test Scaffolding | Derived Gherkin scenarios and a full test suite from the FRDs | The tests faithfully express your acceptance criteria |
| Contracts | Generated API specs and shared TypeScript types | — |
| Implementation | Wrote all backend + frontend code to make tests green | The implementation matches the Gherkin — not just the tests |
| Deployment | Provisioned Azure infra and ran smoke tests against the live URL | Your original PRD user stories work end-to-end in production |

You wrote zero production code. You wrote a spec — and that spec drove every test, every line of implementation, and every deployment check. The code is an artifact. The spec is the asset.

---

## Going Further

- **Change your PRD mid-hack:** Add a new user story to an FRD and run Phase 2 for a new increment.
- **Explore the skills:** Each `.github/skills/*/SKILL.md` is a standalone agent procedure. Read `spec-refinement/SKILL.md` to see how the agent reasons through a spec.
- **Bring a different idea:** Replace `specs/prd.md` with a completely different product spec — the pipeline doesn't care what you're building.
- **Add persistence:** Write a `specs/frd-persistence.md` user story and let agents wire up Azure Cosmos DB or PostgreSQL Flexible Server.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `azd provision` fails with quota error | Run `azd env set AZURE_LOCATION westeurope` and retry |
| Agent seems stuck in a loop | Ask: *"read the resume skill and continue from current state"* |
| Tests failing after implementation | Ask: *"run the test runner skill and fix any failures"* |
| Smoke tests fail after deploy | The agent will auto-rollback — review the failure and re-approve implementation |
| Wireframes not loading | Check the terminal — the agent will have printed the HTTP server URL |

---

## Resources

- [spec2cloud template on GitHub](https://github.com/EmeaAppGbb/shell-typescript)
- [Sample Task Board PRD](microhack-sample-prd.md) — reference only; write your own
- [Azure Developer CLI docs](https://learn.microsoft.com/en-us/azure/developer/azure-developer-cli/)
- [Azure Container Apps docs](https://learn.microsoft.com/en-us/azure/container-apps/)
- [agentskills.io specification](https://agentskills.io/specification)
