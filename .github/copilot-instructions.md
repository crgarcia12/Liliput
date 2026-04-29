# Copilot Instructions

## Project Overview

Liliput is a meta-app that orchestrates Copilot SDK agents to build, deploy, and iterate on real GitHub repositories from natural-language tasks. It runs on AKS as a single pod with an Express.js API, Next.js web UI, and SQLite persistence.

## Repository Layout

```
src/api/        → Express.js backend (TypeScript)
src/web/        → Next.js frontend (TypeScript, App Router)
src/shared/     → Types shared between API and Web
k8s/            → Kubernetes manifests
infra/          → Bicep templates for AKS + ACR
.github/skills/ → Agent skills (agentskills.io spec) — loaded by the Copilot SDK
AGENTS.md       → Orchestrator instructions for skill-aware agents
```

## Coding Conventions

- Write minimal code — no gold-plating
- Follow existing patterns in the codebase
- All code must be covered by tests where reasonable
- No hardcoded secrets — use environment variables
- No hardcoded URLs — use configuration
- Error handling: every external call must have error handling
- Logging: structured `pino` logger only — no `console.log` in production code
- Comments: only when code intent is non-obvious

## TypeScript / Node.js (Backend — `src/api/`)

- **Express with TypeScript**: routes in `src/routes/` — no monolithic route file
- **Async/await**: all I/O is async; proper try/catch on every external call
- **Strict TypeScript**: `strict: true` — no `any`, no implicit returns, explicit null checks
- **Dependency Injection**: constructor injection or factory functions for testability
- **Response shape**: `res.json(...)` for success, `res.status(4xx).json({ error })` for errors
- **Configuration**: `process.env` via a config module with validation and defaults
- **Naming**: camelCase for variables/functions, PascalCase for types/interfaces, kebab-case for files
- **Input validation**: validate request bodies at the route level before passing to services

## Next.js / React (Frontend — `src/web/`)

- **Server Components by default** — only add `'use client'` when hooks, event handlers, or browser APIs are needed
- **App Router**: `page.tsx`, `layout.tsx`, `loading.tsx`, `error.tsx` conventions — no `pages/` directory
- **Route handlers**: API routes at `src/app/api/{route}/route.ts` — export named HTTP method functions
- **TypeScript strict mode**: enabled — no `any`
- **Tailwind CSS**: utility classes for all styling — no custom CSS files or CSS-in-JS
- **Component naming**: PascalCase for components, kebab-case for directories
- **Image optimization**: `next/image` for all images
- **Link navigation**: `next/link` for internal links

## Test Framework Conventions

- **Vitest**: `describe()` for grouping, `it()` for tests; `vi.mock()` for mocks
- **Supertest**: HTTP-level testing of Express routes — no need to start a real server
- **Cucumber.js**: step definitions in `tests/features/step-definitions/`
- **Playwright**: `test.describe()` for grouping; Page Object Model in `e2e/pages/`; no hardcoded waits
- **Test naming**: `it('should [behavior] when [condition]')` for Vitest
- **Test isolation**: each test must be independent — no shared mutable state

## Git Conventions

- Branch naming: `liliput/{feature}` (e.g. `liliput/mid-flight-preempt`)
- Commit messages: imperative mood, scope prefix (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`)
- Never commit secrets, `.env` files, or `node_modules`
- Co-author trailer for AI-assisted commits:
  `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`

## Skills

Agent skills live in `.github/skills/` and follow the [agentskills.io](https://agentskills.io/specification) standard. They are loaded automatically by the Copilot SDK (`enableConfigDiscovery: true`) when an agent session is created against a cloned target repo. See `AGENTS.md` for the orchestrator perspective.
