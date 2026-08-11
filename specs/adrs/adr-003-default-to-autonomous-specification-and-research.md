# ADR-003: Default to autonomous specification expansion and bounded research

- **Status:** Accepted
- **Date:** 2026-08-05

## Context

Liliput is expected to turn a minimal natural-language prompt into ready-to-use,
high-quality software. The existing task flow generated a specification and
then waited indefinitely for human approval before planning or implementation.
That gate added user effort, prevented immediate execution, and extended the
time tasks spent in a `specifying` state that restart reconciliation treats as
in flight.

The current pipeline already rewrites, plans, critiques, implements, builds,
deploys, validates, and reviews. It does not have a bounded stage dedicated to
current product conventions, documentation, package choices, or common user
expectations.

Research on decomposition, retrieval grounding, prompt optimization, context
engineering, and software agents consistently favors structured internal
artifacts, bounded read-only research, and execution-based verification over
larger user prompts or ungrounded self-critique.

## Options Considered

### Option 1: Keep mandatory human specification approval

Generate an editable specification and wait for approval before every build.

- **Pros:** Users can correct assumptions before code is written.
- **Cons:** Every task requires another interaction and can stall indefinitely.
- **Risk:** Restarts can interrupt tasks waiting in an active-looking state.
- **Cost:** Lowest implementation cost but recurring user and operational cost.

### Option 2: Build directly from the raw prompt

Skip specification generation and begin coding immediately.

- **Pros:** Lowest latency and no approval gate.
- **Cons:** Sparse prompts reach the coder without structured requirements,
  acceptance criteria, assumptions, or grounded technical guidance.
- **Risk:** Higher scope errors, missing conventional product behavior, and
  unverifiable completion claims.
- **Cost:** Low implementation cost with higher downstream rework.

### Option 3: Generate an internal spec, research, and auto-start by default

Expand the prompt into a structured internal specification, run one bounded
read-only research stage, then plan and build automatically. Keep manual
specification review as an explicit opt-in.

- **Pros:** Minimal user effort while preserving requirements, assumptions,
  research grounding, and acceptance criteria for downstream agents.
- **Cons:** Adds one model turn and some latency before implementation.
- **Risk:** Research can be unavailable or return weak evidence, so the stage
  must remain bounded, non-fatal, and advisory.
- **Cost:** Moderate implementation and inference cost.

## Decision

Use **internal specification expansion plus a bounded Researcher stage, with
automatic build as the default**.

New tasks set `requireSpecApproval` to `false` unless explicitly requested.
After the internal specification is generated, Liliput transitions directly to
`building`. Users can opt into the previous editable approval gate with
**Pause for spec review**.

The Researcher runs between rewriting and planning. It may use a web-search
tool, must return a short citation-bearing grounding brief, cannot fetch
arbitrary URLs, execute shell commands, or write files, and is non-fatal. Code
changes remain single-threaded and are verified by builds, tests, deployment
probes, and the existing reviewer pipeline.

## Consequences

### Positive

- One minimal prompt starts the complete delivery pipeline.
- Specifications remain available as internal implementation contracts.
- Common product expectations and current technical guidance reach the planner
  and coder without requiring the user to prompt-engineer them.
- Manual review remains available for sensitive or unusually ambiguous work.

### Negative

- Default builds can begin with assumptions the user has not inspected.
- The research turn adds latency, tokens, and dependence on documentation-tool
  availability.
- A bounded research brief cannot guarantee exhaustive or correct coverage.

### Neutral

- Existing approval and specification-edit endpoints remain supported.
- The researcher inherits the coder model until a separate configuration role
  is justified by measured usage.
- Research failure skips the stage rather than blocking delivery.

## References

- [Least-to-Most Prompting, arXiv:2205.10625](https://arxiv.org/abs/2205.10625)
- [ReAct, arXiv:2210.03629](https://arxiv.org/abs/2210.03629)
- [Automatic Prompt Optimization with ProTeGi, arXiv:2305.03495](https://arxiv.org/abs/2305.03495)
- [Large Language Models Cannot Self-Correct Reasoning Yet, arXiv:2310.01798](https://arxiv.org/abs/2310.01798)
- [GATE active task elicitation, arXiv:2310.11589](https://arxiv.org/abs/2310.11589)
- [SWE-agent agent-computer interfaces, arXiv:2405.15793](https://arxiv.org/abs/2405.15793)
- [The Prompt Report, arXiv:2406.06608](https://arxiv.org/abs/2406.06608)
- [Package hallucination study, arXiv:2406.10279](https://arxiv.org/abs/2406.10279)
- [Context Engineering survey, arXiv:2507.13334](https://arxiv.org/abs/2507.13334)
- [GEPA, arXiv:2507.19457](https://arxiv.org/abs/2507.19457)
