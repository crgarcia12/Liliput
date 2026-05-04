/**
 * Feature decomposer — splits a Workstream-level spec into N parallel Features
 * plus one synthetic integration Feature.
 *
 * Output of the LLM is a structured Markdown doc following the format below.
 * The parser tolerates loose formatting (case, separators, optional fields)
 * because LLMs drift, but rejects malformed output rather than guessing.
 *
 *     ## Feature 01: User Login
 *     slug: 01-user-login
 *     depends-on: (none)
 *     spec-path: specs/features/01-user-login.feature.md
 *     description: ...
 *
 *     ## Feature 02: Search
 *     slug: 02-search
 *     depends-on: 01-user-login
 *     spec-path: specs/features/02-search.feature.md
 *     description: ...
 *
 *     ## Integration
 *     slug: 99-integration
 *     spec-path: specs/features/99-integration.feature.md
 *     description: ...
 *
 * Persistence wiring (creating Feature rows + writing per-feature spec files)
 * is the engine's job. This module is parser + prompt only so it can be
 * unit-tested in isolation.
 */

import type { CreateFeatureInput } from '../stores/feature-store.js';

export interface Decomposition {
  features: CreateFeatureInput[];
  integration: CreateFeatureInput | null;
}

export interface DecomposeInput {
  workstreamId: string;
  /** The workstream-level spec.md (output of spec-generator). */
  spec: string;
  /** Original task title, for use when generating the prompt. */
  title: string;
}

const HEADING_RE = /^##\s+(?:feature\s+(\d+)\s*:\s*(.+?)|integration)\s*$/i;
const FIELD_RE = /^\s*([a-z][a-z0-9-]*)\s*:\s*(.+?)\s*$/i;

/**
 * Parse a decomposition markdown doc into Feature inputs. Returns null if no
 * Feature/Integration headings are found at all (caller should fall back to a
 * single-feature spec). Throws on structural errors (missing slug, etc.) so
 * the caller can surface a clear error to the user.
 */
export function parseDecomposition(
  workstreamId: string,
  markdown: string,
): Decomposition | null {
  if (!markdown?.trim()) return null;

  type RawBlock = {
    isIntegration: boolean;
    name: string;
    position: number;
    fields: Record<string, string>;
  };

  const lines = markdown.split(/\r?\n/);
  const blocks: RawBlock[] = [];
  let current: RawBlock | null = null;

  for (const line of lines) {
    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      current = {
        isIntegration: !headingMatch[2],
        name: (headingMatch[2] ?? 'Integration').trim(),
        position: headingMatch[1] ? parseInt(headingMatch[1], 10) : 99,
        fields: {},
      };
      blocks.push(current);
      continue;
    }
    if (!current) continue;
    // Stop collecting fields once a new ## heading begins (handled above) or
    // we hit a blank line followed by free prose. We keep collecting `key:`
    // lines and stop at non-matching lines after at least one field captured.
    const fieldMatch = FIELD_RE.exec(line);
    if (fieldMatch) {
      const key = fieldMatch[1]!.toLowerCase();
      const value = fieldMatch[2]!.trim();
      // Don't overwrite — first occurrence wins. Lets `description:` body
      // text containing `something:` not trample the real field.
      if (!(key in current.fields)) current.fields[key] = value;
    }
  }

  if (blocks.length === 0) return null;

  const out: Decomposition = { features: [], integration: null };

  for (const block of blocks) {
    const slug = block.fields['slug'];
    if (!slug) {
      throw new Error(
        `Decomposition block "${block.name}" is missing required "slug:" field`,
      );
    }
    const depRaw = block.fields['depends-on'] ?? block.fields['dependson'] ?? '';
    const dependsOn = parseDependsOn(depRaw);
    const desc = block.fields['description'];
    const specPath = block.fields['spec-path'] ?? block.fields['specpath'];

    const input: CreateFeatureInput = {
      workstreamId,
      name: block.name,
      slug,
      kind: block.isIntegration ? 'integration' : 'feature',
      ...(desc ? { description: desc } : {}),
      ...(specPath ? { specPath } : {}),
      position: block.position,
      ...(dependsOn.length ? { dependsOn } : {}),
    };

    if (block.isIntegration) {
      out.integration = input;
    } else {
      out.features.push(input);
    }
  }

  // Normalise positions so the integration always sorts last.
  out.features.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  return out;
}

function parseDependsOn(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (/^\(?\s*none\s*\)?$/i.test(trimmed)) return [];
  return trimmed
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Build the LLM prompt that drives decomposition. The output format MUST
 * match what `parseDecomposition` expects.
 */
export function buildDecompositionPrompt(input: DecomposeInput): string {
  return [
    'You are decomposing a software task into independently-implementable features.',
    'Read the specification below and split it into 1–6 parallel features.',
    'Features SHOULD be independent (no cross-feature code dependencies) so they',
    'can be implemented concurrently on separate branches. If two features touch',
    'the same module, prefer making one depend on the other rather than overlapping.',
    '',
    'Output ONLY structured Markdown in EXACTLY this format. No preamble, no explanation:',
    '',
    '## Feature 01: <Short Name>',
    'slug: 01-<kebab-name>',
    'depends-on: (none)',
    'spec-path: specs/features/01-<kebab-name>.feature.md',
    'description: <one-line summary of what this feature delivers>',
    '',
    '## Feature 02: <Short Name>',
    'slug: 02-<kebab-name>',
    'depends-on: 01-<kebab-name>   (or "(none)" if independent)',
    'spec-path: specs/features/02-<kebab-name>.feature.md',
    'description: <one-line summary>',
    '',
    '## Integration',
    'slug: 99-integration',
    'spec-path: specs/features/99-integration.feature.md',
    'description: <one-line summary of how the features compose end-to-end>',
    '',
    'Rules:',
    '- Always emit a final "## Integration" block.',
    '- slugs must be lowercase kebab-case prefixed with NN (zero-padded order).',
    '- depends-on lists slug names (comma-separated) or "(none)".',
    '- spec-path follows the pattern shown above; the engine writes a per-feature spec at that path.',
    '- description is exactly one line.',
    '- Aim for 2–5 features when possible. If the task is small enough to be a single feature, emit one Feature block plus the Integration block.',
    '',
    `# Task: ${input.title}`,
    '',
    '# Workstream specification:',
    input.spec,
  ].join('\n');
}
