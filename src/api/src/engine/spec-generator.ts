import { approveAll } from '@github/copilot-sdk';
import { getCopilotClient } from './copilot-client.js';
import {
  classifyError,
  recordAuthFailure,
  recordAuthSuccess,
  type AuthStatus,
  getAuthStatus,
} from './auth-status.js';
import { extractRepoContext, type ProgressStage as RepoStage } from './repo-context.js';
import { deriveReasoningEffort } from '../../../shared/types/index.js';
import { logger } from '../logger.js';

const DEFAULT_MODEL = process.env['COPILOT_MODEL'] ?? 'claude-sonnet-4';
const DEFAULT_TIMEOUT_MS = parseInt(process.env['COPILOT_TIMEOUT_MS'] ?? '120000', 10);
const PROBE_TIMEOUT_MS = parseInt(process.env['COPILOT_PROBE_TIMEOUT_MS'] ?? '30000', 10);

/** Coarse progress stages the spec generator broadcasts via onProgress. */
export type SpecProgressStage =
  | RepoStage
  | 'connecting-llm'
  | 'drafting'
  | 'spec-ready'
  | 'spec-failed';

export type SpecProgressHandler = (stage: SpecProgressStage, detail?: string) => void;

export interface SpecGeneratorContext {
  /** Target GitHub repo (e.g. "owner/repo"). When provided, Liliput clones it
   *  shallowly and injects README + manifests + file tree into the prompt so
   *  the LLM grounds its spec in what the repo actually is. */
  repository?: string;
  baseBranch?: string;
  /** Stable id used to derive the temp clone dir. */
  taskId?: string;
  /** Optional Copilot SDK model id to use for this spec generation. Falls
   *  back to the server default (`COPILOT_MODEL` env or `gpt-5`) when missing. */
  model?: string;
  /** Optional reasoning-effort hint forwarded to the SDK. When omitted, the
   *  generator auto-derives it from the model id suffix (e.g. `*-xhigh` ->
   *  'xhigh'). Some models (like `claude-opus-4.7-xhigh`) accept ONLY one
   *  effort value — passing the wrong one causes the SDK to throw 400. */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  /** Optional progress hook — called as the generator advances through stages.
   *  Use this to surface what's happening to users (e.g. via socket events). */
  onProgress?: SpecProgressHandler;
}

function buildPrompt(title: string, description: string, repoBlob: string | null): string {
  const sections: string[] = [
    'You are a senior software engineer drafting a concise, implementation-ready specification.',
    'Output ONLY the specification as GitHub-Flavored Markdown — no preamble, no explanation, no code fences around the whole document.',
    '',
    'The spec MUST contain these sections in this order:',
    '1. `# Specification: <title>`',
    '2. `## Overview` — 2–4 sentences summarising the goal',
    '3. `## Requirements` — numbered functional + non-functional requirements',
    '4. `## Acceptance Criteria` — checkbox list (`- [ ]`) covering observable outcomes',
    '5. `## Technical Approach` — ordered steps an engineer would follow',
    '6. `## Out of Scope` — bullets listing what is explicitly NOT included',
    '7. `## Acceptance Scenarios (Gherkin)` — a fenced ```gherkin code block',
    '   containing a `Feature:` declaration and one or more `Scenario:` blocks',
    '   that map 1:1 to the Acceptance Criteria items above. These scenarios',
    '   are the executable contract — Liliput will scaffold Playwright/Cucumber',
    '   tests directly from this block, so write them concrete and verifiable',
    '   (use real values, not "<some thing>" placeholders).',
  ];

  if (repoBlob) {
    sections.push(
      '',
      '⚠️  CRITICAL — repo grounding: a section titled "Target repository" follows',
      'with the README, manifests and file tree of the repo this task targets.',
      'Read it before drafting. The spec MUST describe changes to THIS repo, not',
      'a project invented from the title. If the user description is vague',
      '("modernize this thing"), the README and manifests tell you what "this"',
      'really is.',
      '',
      repoBlob,
    );
  }

  sections.push(
    '',
    `Task title: ${title}`,
    '',
    'Task description and conversation context:',
    description,
  );

  return sections.join('\n');
}

function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  const fenceMatch = trimmed.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/i);
  return fenceMatch?.[1]?.trim() ?? trimmed;
}

/**
 * Extract the Gherkin block from a spec markdown string. Returns the raw
 * `Feature: …` content (no surrounding fences), suitable for writing as
 * `tests/features/acceptance.feature`. Returns null if no `gherkin` fenced
 * block is found — callers should treat that as "no executable acceptance
 * scenarios available" rather than failing.
 *
 * Used by the test-scaffolding phase (PR-A2) to seed Cucumber/Playwright
 * tests directly from the spec.
 */
export function extractGherkin(spec: string): string | null {
  // Match a fenced ```gherkin block anywhere in the doc. Tolerant of leading
  // whitespace and `gherkin`/`feature` language hints. Stops at the first
  // closing fence — specs only emit a single Acceptance Scenarios section.
  const m = spec.match(/```(?:gherkin|feature)\s*\n([\s\S]*?)\n```/i);
  if (!m || !m[1]) return null;
  const body = m[1].trim();
  // Be defensive: require at least one Scenario to count as usable.
  if (!/\bScenario\s*:/i.test(body)) return null;
  return body;
}

function fallbackSpec(title: string, description: string, reason: string): string {
  logger.warn({ reason }, 'Falling back to template spec');
  return `# Specification: ${title}

## Overview
${description}

## Requirements
1. The system shall implement the functionality described above.
2. All changes must include appropriate unit and integration tests.
3. Code must follow existing project conventions and pass linting.
4. Error handling must cover all edge cases.

## Acceptance Criteria
- [ ] Feature works as described in the overview
- [ ] Unit tests pass with adequate coverage
- [ ] Integration tests verify end-to-end flow
- [ ] No regressions in existing functionality
- [ ] Code review approved

## Technical Approach
1. **Analysis** — Review existing codebase for impact areas
2. **Design** — Define interfaces and data flow
3. **Implementation** — Write code following TDD approach
4. **Testing** — Verify with unit, integration, and e2e tests
5. **Deployment** — Deploy via CI/CD pipeline

## Acceptance Scenarios (Gherkin)
\`\`\`gherkin
Feature: ${title}

  Scenario: Feature works as described
    Given the application is deployed and reachable
    When the user exercises the new feature end-to-end
    Then the observable behaviour matches the description above
    And no regressions are introduced in existing functionality
\`\`\`

---
*Generated by Liliput template fallback (${reason})*
`;
}

export type SpecGenerator = (
  title: string,
  description: string,
  context?: SpecGeneratorContext,
) => Promise<string>;

/**
 * Generate a markdown spec for a task using the GitHub Copilot SDK.
 * Falls back to a static template if the LLM call fails or times out.
 * Records auth health on every call.
 *
 * When `context.repository` is provided, the target repo is shallow-cloned
 * and its README + manifests + file tree are injected into the prompt so
 * the spec is grounded in what the repo actually is rather than what the
 * LLM guesses from a vague title.
 */
export async function generateSpec(
  title: string,
  description: string,
  context?: SpecGeneratorContext,
): Promise<string> {
  const progress: SpecProgressHandler = context?.onProgress ?? (() => undefined);
  let repoBlob: string | null = null;
  if (context?.repository && context.taskId) {
    const ctx = await extractRepoContext({
      repository: context.repository,
      ...(context.baseBranch ? { baseBranch: context.baseBranch } : {}),
      taskId: context.taskId,
      onProgress: (stage, detail) => progress(stage, detail),
    });
    if (ctx) {
      repoBlob = ctx.prompt;
      logger.info(
        { repo: context.repository, bytes: ctx.bytes, taskId: context.taskId },
        'Repo context attached to spec prompt',
      );
    } else {
      logger.warn(
        { repo: context.repository, taskId: context.taskId },
        'Repo context unavailable — generating spec without grounding',
      );
    }
  }
  const prompt = buildPrompt(title, description, repoBlob);
  const model = context?.model && context.model.trim() ? context.model.trim() : DEFAULT_MODEL;
  const reasoningEffort = context?.reasoningEffort ?? deriveReasoningEffort(model);

  try {
    progress('connecting-llm', `model: ${model}`);
    const client = await getCopilotClient();
    const session = await client.createSession({
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      onPermissionRequest: approveAll,
    });

    try {
      progress('drafting', `prompt: ${prompt.length} chars`);
      const result = await session.sendAndWait({ prompt }, DEFAULT_TIMEOUT_MS);
      const content = result?.data?.content?.trim();
      if (!content) {
        recordAuthFailure('unknown', 'Empty response from the LLM');
        progress('spec-failed', 'empty LLM response');
        return fallbackSpec(title, description, 'empty LLM response');
      }
      recordAuthSuccess();
      logger.info({ model, chars: content.length }, 'Spec generated via Copilot SDK');
      progress('spec-ready', `${content.length} chars`);
      return stripCodeFence(content);
    } finally {
      await session.disconnect().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ err: message }, 'Error disconnecting Copilot session');
      });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const { kind, message: humanMsg } = classifyError(err);
    recordAuthFailure(kind, humanMsg);
    logger.error({ err: message, kind }, 'Copilot SDK spec generation failed');
    progress('spec-failed', message);
    return fallbackSpec(title, description, message);
  }
}

/**
 * Lightweight active probe — sends a tiny prompt to verify auth + connectivity.
 * Returns the resulting auth status. Used by `POST /api/auth/check`.
 */
export async function probeAuth(): Promise<AuthStatus> {
  try {
    const client = await getCopilotClient();
    const session = await client.createSession({
      model: DEFAULT_MODEL,
      ...(deriveReasoningEffort(DEFAULT_MODEL) ? { reasoningEffort: deriveReasoningEffort(DEFAULT_MODEL)! } : {}),
      onPermissionRequest: approveAll,
    });
    try {
      const result = await session.sendAndWait(
        { prompt: 'Reply with the single word: ok' },
        PROBE_TIMEOUT_MS,
      );
      if (!result?.data?.content) {
        recordAuthFailure('unknown', 'Probe returned an empty response');
      } else {
        recordAuthSuccess();
      }
    } finally {
      await session.disconnect().catch(() => undefined);
    }
  } catch (err: unknown) {
    const { kind, message } = classifyError(err);
    recordAuthFailure(kind, message);
  }
  return getAuthStatus();
}
