/**
 * Title generator — turns a long workstream description into a 1-4 word
 * snappy title via a cheap LLM call. Best-effort: always returns a title
 * (falls back to a heuristic on any error / empty response). Never throws.
 *
 * Used by ``POST /api/title-suggest`` so the new-workstream form can show
 * a clean title in the workstreams list instead of the user's raw prose.
 */

import { approveAll } from '@github/copilot-sdk';
import { getCopilotClient } from './copilot-client.js';
import { logger } from '../logger.js';

const TITLE_MODEL = process.env['LILIPUT_TITLE_MODEL'] ?? 'gpt-5-mini';
const TIMEOUT_MS = 15_000;
const MAX_WORDS = 4;

const PROMPT = [
  'You are a title generator. Read the user prompt below and reply with a',
  '1 to 4 word title that captures the core intent. The title should be:',
  '- Title Case (capitalise each word)',
  '- No punctuation, no quotes, no markdown',
  '- 1, 2, 3, or 4 English words — never more',
  '- An imperative verb phrase when possible (e.g. "Add Login", "Fix Search Bug")',
  '',
  'Reply with ONLY the title. No preamble, no explanation.',
  '',
  '--- USER PROMPT ---',
].join('\n');

/** Trim, dequote, dehash, and clamp to MAX_WORDS Title-Case words. */
function sanitise(raw: string): string {
  let s = raw.trim();
  // Strip leading/trailing quotes, asterisks, hashes, code fences.
  s = s.replace(/^[`*#"'\s]+/, '').replace(/[`*#"'\s]+$/, '');
  // Collapse whitespace, drop trailing punctuation.
  s = s.replace(/\s+/g, ' ').replace(/[.,;:!?]+$/, '');
  // Take at most MAX_WORDS words.
  const words = s.split(' ').filter(Boolean).slice(0, MAX_WORDS);
  // Title-case each word (preserve all-caps acronyms ≤ 4 chars).
  return words
    .map((w) =>
      w.length <= 4 && w === w.toUpperCase() && /[A-Z]/.test(w)
        ? w
        : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
    )
    .join(' ');
}

/** Heuristic title for when the LLM is unavailable / silent. */
function fallbackTitle(input: string): string {
  const cleaned = input
    .replace(/^(please|can you|could you|i want to|i'd like to|let's|lets)\s+/i, '')
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'New Workstream';
  return sanitise(cleaned) || 'New Workstream';
}

export async function suggestTitle(input: string): Promise<string> {
  const trimmed = input.trim();
  if (!trimmed) return 'New Workstream';
  // Already snappy? Skip the LLM round trip.
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (wordCount <= MAX_WORDS && trimmed.length <= 40) {
    return sanitise(trimmed) || fallbackTitle(trimmed);
  }

  const prompt = `${PROMPT}\n${trimmed}\n--- END ---`;
  try {
    const client = await getCopilotClient();
    const session = await client.createSession({
      model: TITLE_MODEL,
      onPermissionRequest: approveAll,
    });
    try {
      const result = await session.sendAndWait({ prompt }, TIMEOUT_MS);
      const content = result?.data?.content?.trim();
      if (!content) {
        logger.warn({ model: TITLE_MODEL }, 'title-suggest: empty LLM response');
        return fallbackTitle(trimmed);
      }
      // The model can produce multiple lines; take the first non-empty one.
      const firstLine = content.split('\n').map((l: string) => l.trim()).find((l: string) => l.length > 0) ?? content;
      const cleaned = sanitise(firstLine);
      return cleaned || fallbackTitle(trimmed);
    } finally {
      await session.disconnect().catch(() => undefined);
    }
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    logger.warn({ err: m, model: TITLE_MODEL }, 'title-suggest: LLM call failed — using heuristic fallback');
    return fallbackTitle(trimmed);
  }
}
