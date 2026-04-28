/**
 * LLM-driven editing loop.
 *
 * Strategy: ask the model for a JSON `EditPlan` describing all file edits
 * needed to fulfil a spec, apply it, and stop. We do a single-shot rather
 * than a multi-iteration tool-using loop — simpler, faster, sufficient for
 * the demo. The loop can be extended later with file-read tools.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { approveAll } from '@github/copilot-sdk';
import { getCopilotClient } from './copilot-client.js';
import { applyEditPlan, isEditPlan, type EditPlan, type ApplyResult } from './edit-applier.js';
import { logger } from '../logger.js';

const MODEL = process.env['COPILOT_MODEL'] ?? 'claude-sonnet-4';
// Default: 10 minutes. Big repos with multi-file edits routinely take 4-6
// minutes for the LLM to plan the full EditPlan. Override via env if needed.
const TIMEOUT_MS = parseInt(process.env['AGENT_LOOP_TIMEOUT_MS'] ?? '600000', 10);
const TREE_MAX_FILES = 200;
const FILE_PREVIEW_BYTES = 4000;

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.venv',
  '__pycache__',
  'target',
  'vendor',
]);

export interface RunAgentOptions {
  workspaceRoot: string;
  taskTitle: string;
  taskDescription: string;
  spec?: string;
  /** Hook called whenever the agent emits a textual progress message. */
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface RunAgentResult {
  plan: EditPlan;
  apply: ApplyResult;
  rawResponse: string;
}

async function listRepoTree(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    if (out.length >= TREE_MAX_FILES) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= TREE_MAX_FILES) return;
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      if (IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(full, relPath);
      } else if (entry.isFile()) {
        out.push(relPath);
      }
    }
  }
  await walk(root, '');
  return out;
}

async function previewKeyFiles(root: string, files: string[]): Promise<string> {
  const preferred = [
    'package.json',
    'README.md',
    'pyproject.toml',
    'requirements.txt',
    'pom.xml',
    'go.mod',
    'index.html',
    'src/index.ts',
    'src/index.js',
    'src/main.ts',
    'app.py',
    'main.py',
  ];
  const picks: string[] = [];
  for (const p of preferred) {
    if (files.includes(p)) picks.push(p);
    if (picks.length >= 5) break;
  }

  const parts: string[] = [];
  for (const rel of picks) {
    try {
      const abs = path.join(root, rel);
      const s = await stat(abs);
      if (!s.isFile()) continue;
      const content = await readFile(abs, 'utf8');
      const truncated = content.length > FILE_PREVIEW_BYTES
        ? content.substring(0, FILE_PREVIEW_BYTES) + '\n... (truncated)'
        : content;
      parts.push(`### ${rel}\n\`\`\`\n${truncated}\n\`\`\``);
    } catch {
      /* ignore */
    }
  }
  return parts.join('\n\n');
}

function buildEditPrompt(opts: RunAgentOptions, tree: string[], previews: string): string {
  return [
    'You are an autonomous code-editing agent. Your job is to fulfil the user task',
    'by emitting a JSON EditPlan that, when applied to the repository, makes the',
    'requested changes.',
    '',
    'Output rules — STRICT:',
    '- Reply with a SINGLE JSON object and nothing else. No prose, no markdown fences.',
    '- Schema: { "summary": string, "done": boolean, "ops": [EditOp, ...] }',
    '- Each EditOp is one of:',
    '    { "op": "write",  "path": "<relative>", "content": "<full file content>" }',
    '    { "op": "append", "path": "<relative>", "content": "<text to append>" }',
    '    { "op": "delete", "path": "<relative>" }',
    '    { "op": "mkdir",  "path": "<relative>" }',
    '- ALWAYS use full file content for "write" ops — never partial diffs or "..." placeholders.',
    '- Only include files you actually need to create or change. Do not rewrite untouched files.',
    '- Do not modify .git or any build artefacts.',
    '- Set "done": true unless you genuinely need a follow-up turn (you currently get only one).',
    '',
    `Task title: ${opts.taskTitle}`,
    '',
    'Task description:',
    opts.taskDescription,
    '',
    opts.spec ? `Approved specification:\n${opts.spec}\n` : '',
    `Repository tree (first ${TREE_MAX_FILES} files):`,
    tree.join('\n'),
    '',
    previews ? `Key file previews:\n${previews}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  // Strip optional code fence
  const fenceMatch = trimmed.match(/^```(?:json)?\n([\s\S]*?)\n```$/i);
  const inner = fenceMatch?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(inner);
  } catch {
    // Last-ditch: find the first { ... } that parses.
    const start = inner.indexOf('{');
    const end = inner.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON object in response');
    return JSON.parse(inner.substring(start, end + 1));
  }
}

export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const log = opts.onLog ?? (() => {});

  log('info', 'Scanning repository tree…');
  const tree = await listRepoTree(opts.workspaceRoot);
  log('info', `Found ${tree.length} files. Reading key files…`);
  const previews = await previewKeyFiles(opts.workspaceRoot, tree);

  log('info', `Asking ${MODEL} for an edit plan…`);
  const prompt = buildEditPrompt(opts, tree, previews);

  const client = await getCopilotClient();
  const session = await client.createSession({ model: MODEL, onPermissionRequest: approveAll });
  let raw = '';
  try {
    const result = await session.sendAndWait({ prompt }, TIMEOUT_MS);
    raw = result?.data?.content?.trim() ?? '';
  } finally {
    await session.disconnect().catch(() => undefined);
  }

  if (!raw) {
    throw new Error('LLM returned empty response');
  }

  let parsed: unknown;
  try {
    parsed = extractJson(raw);
  } catch (err) {
    logger.error({ raw }, 'Failed to parse LLM response as JSON');
    throw new Error(
      `LLM did not return valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!isEditPlan(parsed)) {
    logger.error({ parsed }, 'LLM response is not a valid EditPlan');
    throw new Error('LLM response did not match the EditPlan schema');
  }

  log('info', `Edit plan received: ${parsed.ops.length} ops — ${parsed.summary ?? ''}`);
  const apply = await applyEditPlan(opts.workspaceRoot, parsed);
  log('info', `Applied ${apply.changedFiles.length} edits (${apply.errors.length} errors)`);
  for (const e of apply.errors) {
    log('warn', `Edit failed for ${e.path} (${e.op}): ${e.message}`);
  }
  return { plan: parsed, apply, rawResponse: raw };
}
