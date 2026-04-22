# spec2cloud · Next.js + TypeScript Shell

**Transform product specifications into production-ready applications on Azure — AI-powered, human-approved, spec-driven.**

spec2cloud is a spec-driven development framework where **specifications are the single source of truth**. Tests are generated from specs, implementation makes those tests pass, and the result is deployed to Azure — all orchestrated by an AI agent with **43 specialized skills**. Every step is resumable, auditable, and requires human approval before anything ships.

This is the **Next.js + TypeScript shell** — a pre-configured template with the full tech stack wired up and ready to go.

## Why spec2cloud?

- **Specifications are the source of truth** — not code, not comments, not wikis
- **Tests before code** — every feature has tests before implementation begins
- **Human approval at every gate** — nothing ships without your sign-off
- **Resumable from any point** — state persisted in git, pick up where you left off
- **Works for new and existing apps** — greenfield builds new, brownfield modernizes existing
- **Live research** — agents query Microsoft Learn, Context7, and DeepWiki before writing a single line

## Two Paths, One Pipeline

**Greenfield** — Start with a product idea → PRD → FRD → UI prototypes → Tests → Contracts → Implementation → Deployed on Azure.

**Brownfield** — Start with existing code → Extract specs → Testability gate → Green baseline or behavioral docs → Assess → Plan → Same delivery pipeline.

Both converge on the same **Phase 2 delivery**: Tests → Contracts → Implementation → Deploy.

## How It Works

<p align="center">
  <img src="docs/spec2cloud-flow.gif" alt="spec2cloud animated flow — Ralph Loop, phase pipeline, and increment delivery" width="100%">
</p>

> **[▶ Interactive version](docs/spec2cloud-flow.html)** — open in your browser for playback controls and speed adjustment.

Human approval gates pause the pipeline at every critical transition — nothing ships without your sign-off.

1. **Write a PRD** — plain-language product requirements in `specs/prd.md`
2. **Agents refine** — PRD → FRDs, reviewed through product + technical lenses
3. **Prototype** — interactive HTML wireframes you browse and approve in your browser
4. **Test-first** — Gherkin scenarios + Playwright e2e + Vitest unit tests, all failing (red baseline)
5. **Contracts** — API specs, shared TypeScript types, and infra requirements generated from specs
6. **Implement** — agents write code to make tests green (API slice → Web slice → Integration)
7. **Ship** — `azd up` deploys to Azure Container Apps; smoke tests verify production

## Quick Start

```bash
# Create your repo from this template
gh repo create my-app --template EmeaAppGbb/shell-typescript
cd my-app && npm install
cd src/web && npm install && cd ../..
cd src/api && npm install && cd ../..

# Run locally (Aspire recommended)
npm run dev:aspire        # API + Web + Docs with service discovery

# Write your PRD and let agents take over
code specs/prd.md

# Deploy to Azure
azd auth login && azd up
```

## This Shell's Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js · TypeScript · App Router · Tailwind CSS |
| Backend | Express.js · TypeScript · Node.js |
| Testing | Playwright (e2e) · Cucumber.js (BDD) · Vitest + Supertest (unit) |
| Docs | MkDocs Material — auto-generated from wireframes + Gherkin + screenshots |
| Local orchestration | .NET Aspire (service discovery & dashboard) |
| Deployment | Azure Container Apps via Azure Developer CLI (`azd`) |
| AI research | Microsoft Learn · Context7 · DeepWiki · Azure Best Practices MCP |

## Key Commands

| Command | What it does |
|---------|-------------|
| `npm run dev:aspire` | Run all services with Aspire |
| `npm run dev:all` | API + Web + Docs concurrently |
| `npm run test:all` | Unit + BDD + e2e tests |
| `npm run build:all` | Production build (API + Web) |
| `npm run docs:full` | Capture screenshots + generate docs |
| `azd up` | Provision + deploy to Azure |

## Learn More

| Start Here | Then Explore | Go Deeper |
|-----------|-------------|-----------|
| [Quick Start](docs/quickstart.md) | [Greenfield Guide](docs/greenfield.md) | [Skills Catalog](docs/skills.md) |
| [Core Concepts](docs/concepts.md) | [Brownfield Guide](docs/brownfield.md) | [State & Gates](docs/state-and-gates.md) |
| [Microhack](docs/microhack.md) | [Examples](docs/examples/) | [Architecture](docs/architecture.md) |

## Extending

- **Skills** (`.github/skills/`) — 43 specialized agent procedures following the [agentskills.io](https://agentskills.io) standard
- **Orchestrator** (`AGENTS.md`) — the central loop; modify phases, gates, or add new ones
- **Other shells** — swap Next.js/Express for any framework; see [available shells](docs/shells.md)
- **Community skills** — discover and publish skills at [skills.sh](https://skills.sh/)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines. Please read our [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

To report vulnerabilities, see [SECURITY.md](SECURITY.md).

## License

[ISC](LICENSE)

---

**From idea to production — spec-driven, AI-powered, human-approved.**
