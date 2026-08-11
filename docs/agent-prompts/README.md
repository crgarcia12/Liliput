# Liliput agent prompt source index

Liliput keeps prompts in executable source instead of copying them into
documentation. This page links every runtime model role and every skill-backed
agent to its canonical prompt builder or `SKILL.md`, so the documented prompt
cannot drift from the code.

Repository links target `main`. When reviewing an unmerged branch, open the same
path on that branch.

## Runtime model agents

| Agent | Purpose | Canonical prompt source |
| --- | --- | --- |
| Specification writer | Expands a short request into the internal implementation specification, optionally grounded in an existing repository snapshot. | [`buildPrompt()`](https://github.com/crgarcia12/Liliput/blob/main/src/api/src/engine/spec-generator.ts#L64) and [`generateSpec()`](https://github.com/crgarcia12/Liliput/blob/main/src/api/src/engine/spec-generator.ts#L164) |
| Title suggester | Produces the short workstream title shown in the UI. | [`PROMPT`](https://github.com/crgarcia12/Liliput/blob/main/src/api/src/engine/title-suggest.ts#L18) and [`suggestTitle()`](https://github.com/crgarcia12/Liliput/blob/main/src/api/src/engine/title-suggest.ts#L61) |
| Rewriter | Rephrases the request for clarity without adding scope, assumptions, or constraints. | [`rewriteRequest()`](https://github.com/crgarcia12/Liliput/blob/main/src/api/src/engine/pipeline-stages.ts#L191) |
| Researcher | Uses only `web_search`, treats results as untrusted data, and returns a bounded implementation brief without editing the repository. | [`researchRequest()`](https://github.com/crgarcia12/Liliput/blob/main/src/api/src/engine/pipeline-stages.ts#L237) |
| Architect | Produces the specification- and research-grounded implementation plan and required validation steps. | [`generatePlan()`](https://github.com/crgarcia12/Liliput/blob/main/src/api/src/engine/pipeline-stages.ts#L322) |
| Plan critic | Reviews the request and architect plan for concrete implementation risks and omissions. | [`buildPlanPrompt()`](https://github.com/crgarcia12/Liliput/blob/main/src/api/src/engine/reviewer-loop.ts#L347), invoked by [`critiquePlan()`](https://github.com/crgarcia12/Liliput/blob/main/src/api/src/engine/pipeline-stages.ts#L378) |
| Coder | Edits the repository, runs validation, and emits evidence, verdicts, and tool wishes. Its prompt is composed dynamically for initial and follow-up turns. | [`buildInitialPrompt()`](https://github.com/crgarcia12/Liliput/blob/main/src/api/src/engine/agent-loop.ts#L310) and [`buildFollowUpPrompt()`](https://github.com/crgarcia12/Liliput/blob/main/src/api/src/engine/agent-loop.ts#L370) |
| Reviewer | Reviews specifications, code, deployments, or plans and can return bounded corrective feedback. | [`buildSystemPreamble()` and review-kind prompt builders](https://github.com/crgarcia12/Liliput/blob/main/src/api/src/engine/reviewer-loop.ts#L172) |
| Ops fixer | Diagnoses and repairs container build, Kubernetes deployment, and preview-validation failures. | [`buildPrompt()`](https://github.com/crgarcia12/Liliput/blob/main/src/api/src/engine/ops-fixer.ts#L69) |
| Git fixer | Diagnoses failed git operations without changing remotes, branches, or discarding agent work. | [`buildPrompt()`](https://github.com/crgarcia12/Liliput/blob/main/src/api/src/engine/git-fixer.ts#L52) |
| Conflict resolver | Resolves real merge conflicts after the deterministic conflict probe finds them. | [`buildResolverPrompt()`](https://github.com/crgarcia12/Liliput/blob/main/src/api/src/engine/conflict-guard.ts#L99) |
| Feature decomposer | Splits a generated specification into bounded feature slices plus an integration slice. | [`buildDecompositionPrompt()`](https://github.com/crgarcia12/Liliput/blob/main/src/api/src/engine/feature-decomposer.ts#L151) |
| Campaign candidate generator | Generates one to five evidence-backed, reversible delivery candidates with structured output. | [`generateCampaignFeatureCandidatesWithCopilot()`](https://github.com/crgarcia12/Liliput/blob/main/src/api/src/engine/autonomous-campaign-proposal.ts#L1044) |
| Campaign proposal critic | Independently selects one useful campaign candidate or rejects the set with a policy reason. | [`critiqueCampaignFeatureCandidatesWithCopilot()`](https://github.com/crgarcia12/Liliput/blob/main/src/api/src/engine/autonomous-campaign-proposal.ts#L1084) |
| Copilot auth probe (helper) | Verifies SDK authentication and connectivity with a single-word response. It is a health probe, not a delivery agent. | [`probeAuth()`](https://github.com/crgarcia12/Liliput/blob/main/src/api/src/engine/spec-generator.ts#L283) |

## Dynamic prompt composition

The full Coder prompt does not exist as one static string. Liliput assembles it
at runtime from:

1. the immutable task, specification, repository, branch, and pull-request
   contract in [`buildManagedDeliveryContract()`](https://github.com/crgarcia12/Liliput/blob/main/src/api/src/engine/managed-delivery-contract.ts#L22),
2. the reverse-proxy, base-path, container, and validation contract in
   [`buildDeployContract()`](https://github.com/crgarcia12/Liliput/blob/main/src/api/src/engine/liliput-deploy-contract.ts#L55),
3. the rewritten request, research brief, architect plan, and critic findings
   produced by [`composePlanningContext()`](https://github.com/crgarcia12/Liliput/blob/main/src/api/src/engine/pipeline-stages.ts#L415),
4. reviewer feedback, when present, and
5. either [`buildInitialPrompt()`](https://github.com/crgarcia12/Liliput/blob/main/src/api/src/engine/agent-loop.ts#L310)
   or [`buildFollowUpPrompt()`](https://github.com/crgarcia12/Liliput/blob/main/src/api/src/engine/agent-loop.ts#L370).

The full Reviewer prompt is similarly composed from the common reviewer
preamble, the selected review-kind builder, task context, current
diff/deployment evidence, and prior feedback.

Purpose-built Ops fixer, Git fixer, and Conflict resolver prompts are wrapped
by [`buildManagedPromptOverride()`](https://github.com/crgarcia12/Liliput/blob/main/src/api/src/engine/agent-loop.ts#L208),
which prepends the same managed delivery contract before the narrower recovery
instructions.

## Model selection

The five profile-configurable roles are `rewriter`, `architect`, `critic`,
`coder`, and `reviewer`. Their resolution order is implemented in
[`agent-config.ts`](https://github.com/crgarcia12/Liliput/blob/main/src/api/src/engine/agent-config.ts):

```text
task override -> user profile -> role environment
-> COPILOT_MODEL -> built-in fallback
```

Current special cases:

- the Researcher inherits the Coder model and reasoning selection,
- Ops fixer, Git fixer, and Conflict resolver turns reuse the task's existing
  SDK session,
- the Specification writer and Feature decomposer use the task model when
  supplied, then fall back to `COPILOT_MODEL`,
- the title generator uses `LILIPUT_TITLE_MODEL` or `gpt-5-mini`, and
- autonomous campaigns carry separate meta-agent, coding, and reviewer model
  configuration.

## Skill-backed agents and procedures

[`AGENTS.md`](https://github.com/crgarcia12/Liliput/blob/main/AGENTS.md) is the
full `spec2cloud` orchestrator prompt and catalog. Every reusable procedure
below is a complete prompt stored in its linked `SKILL.md`.

| Skill prompt | Skill prompt | Skill prompt |
| --- | --- | --- |
| [`adr`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/adr/SKILL.md) | [`api-extractor`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/api-extractor/SKILL.md) | [`architecture-mapper`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/architecture-mapper/SKILL.md) |
| [`aspire`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/aspire/SKILL.md) | [`audit-log`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/audit-log/SKILL.md) | [`azure-app-registration`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/azure-app-registration/SKILL.md) |
| [`azure-deployment`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/azure-deployment/SKILL.md) | [`bug-fix`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/bug-fix/SKILL.md) | [`build-check`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/build-check/SKILL.md) |
| [`cloud-native-assessment`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/cloud-native-assessment/SKILL.md) | [`cloud-native-planner`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/cloud-native-planner/SKILL.md) | [`codebase-scanner`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/codebase-scanner/SKILL.md) |
| [`commit-protocol`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/commit-protocol/SKILL.md) | [`contract-generation`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/contract-generation/SKILL.md) | [`data-model-extractor`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/data-model-extractor/SKILL.md) |
| [`ddd-modeling`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/ddd-modeling/SKILL.md) | [`dependency-inventory`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/dependency-inventory/SKILL.md) | [`deploy-diagnostics`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/deploy-diagnostics/SKILL.md) |
| [`dev-implementer`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/dev-implementer/SKILL.md) | [`e2e-generation`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/e2e-generation/SKILL.md) | [`error-handling`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/error-handling/SKILL.md) |
| [`extension-planner`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/extension-planner/SKILL.md) | [`find-skills`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/find-skills/SKILL.md) | [`frd-generator`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/frd-generator/SKILL.md) |
| [`gherkin-generation`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/gherkin-generation/SKILL.md) | [`human-gate`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/human-gate/SKILL.md) | [`implementation`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/implementation/SKILL.md) |
| [`modernization-assessment`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/modernization-assessment/SKILL.md) | [`modernization-planner`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/modernization-planner/SKILL.md) | [`performance-assessment`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/performance-assessment/SKILL.md) |
| [`playwright-cli`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/playwright-cli/SKILL.md) | [`pm-issue-author`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/pm-issue-author/SKILL.md) | [`prd-generator`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/prd-generator/SKILL.md) |
| [`release-manager`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/release-manager/SKILL.md) | [`research-best-practices`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/research-best-practices/SKILL.md) | [`resume`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/resume/SKILL.md) |
| [`rewrite-assessment`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/rewrite-assessment/SKILL.md) | [`rewrite-planner`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/rewrite-planner/SKILL.md) | [`security-assessment`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/security-assessment/SKILL.md) |
| [`security-planner`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/security-planner/SKILL.md) | [`skill-creator`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/skill-creator/SKILL.md) | [`skill-discovery`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/skill-discovery/SKILL.md) |
| [`spec-refinement`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/spec-refinement/SKILL.md) | [`spec-validator`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/spec-validator/SKILL.md) | [`state-management`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/state-management/SKILL.md) |
| [`tech-stack-resolution`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/tech-stack-resolution/SKILL.md) | [`test-discovery`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/test-discovery/SKILL.md) | [`test-generation`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/test-generation/SKILL.md) |
| [`test-runner`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/test-runner/SKILL.md) | [`ui-ux-design`](https://github.com/crgarcia12/Liliput/blob/main/.github/skills/ui-ux-design/SKILL.md) | |

## Deterministic stages without an LLM prompt

Not every visible stage is a model agent:

- **Build** runs ACR build operations and bounded recovery orchestration.
- **Deploy** renders Kubernetes resources, deploys the image, and publishes the
  gateway route.
- **Validate** performs in-cluster and public-route checks; a Reviewer may
  additionally inspect deployment evidence.
- **Ship** merges or finalizes the task according to its commit mode.
- **Preview lifecycle** operations start, stop, delete, inspect, and recreate
  Kubernetes resources directly.

These stages are implemented in
[`agent-engine.ts`](https://github.com/crgarcia12/Liliput/blob/main/src/api/src/engine/agent-engine.ts),
[`k8s-deployer.ts`](https://github.com/crgarcia12/Liliput/blob/main/src/api/src/engine/k8s-deployer.ts),
and the related stores and routes.
