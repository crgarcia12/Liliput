# Launch posts

## X / Twitter

Most coding agents optimize for a diff. I built Liliput to optimize for auditable delivery: isolated repo workspaces, visible tool calls, tests, AKS previews, reviewer verdicts and a PR.

Next.js + Express + Go + Copilot SDK.

https://github.com/crgarcia12/Liliput

## LinkedIn

Most coding agents optimize for producing a diff.

I built Liliput to optimize for producing an auditable delivery.

A task in Liliput is not a chat transcript. It is a durable repository state
transition:

- clone the target repository into an isolated workspace;
- discover its instructions, skills, tests, and MCP servers;
- run GitHub Copilot SDK agent loops;
- edit, test, commit, and push;
- build a container in Azure Container Registry;
- deploy a live preview to AKS;
- expose tool calls, logs, model usage, failures, health, and reviewer verdicts;
- return the final ship, redirect, or discard decision to an engineer.

The control plane is Next.js, Express, Socket.IO, and SQLite. The terminal client
is Go with Bubble Tea. Kubernetes provides isolated preview environments.

The hard part was not prompting. It was state, identity, isolation, routing,
deployment, recovery, conflict handling, and review.

The design principle is observable autonomy: agents can work independently and
iterate through failures, but the evidence stays visible and the operator can
interrupt at any point.

There is no "AI replaces engineers" thesis here. The more interesting
engineering question is how to give coding agents enough agency to deliver
useful systems without removing state, evidence, or human judgment.

Source:
https://github.com/crgarcia12/Liliput

Live system:
https://liliput.crgarcia.com.ar
