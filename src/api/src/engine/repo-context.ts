/**
 * Repo context extractor — used by the spec generator so the LLM has actual
 * facts about the target repository (README, manifest files, file tree)
 * instead of having to invent what the project is from a vague user
 * description like "modernize this thing".
 *
 * Strategy:
 *   1. Shallow-clone the target repo into a throwaway workspace dir.
 *   2. Read a fixed set of useful files (README, package.json, etc.) and
 *      produce a shallow file tree.
 *   3. Truncate everything aggressively so the prompt stays under ~12k chars.
 *   4. Best-effort cleanup of the temp clone.
 *
 * Failures are non-fatal — callers fall back to the title/description-only
 * prompt if extraction throws.
 */

import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import * as git from './git-client.js';
import { logger } from '../logger.js';

const README_CANDIDATES = ['README.md', 'README.MD', 'Readme.md', 'readme.md', 'README'];
const MANIFEST_CANDIDATES = [
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Gemfile',
  'composer.json',
  'index.html',
];

const README_LIMIT = 6000;
const MANIFEST_LIMIT = 2500;
const TREE_ENTRY_LIMIT = 80;

async function tryReadFirst(cwd: string, candidates: string[], limit: number): Promise<string | null> {
  for (const name of candidates) {
    try {
      const buf = await readFile(path.join(cwd, name), 'utf8');
      const truncated = buf.length > limit ? buf.slice(0, limit) + `\n\n…(truncated, original ${buf.length} chars)` : buf;
      return `### ${name}\n${truncated}`;
    } catch {
      // try next candidate
    }
  }
  return null;
}

async function readManifests(cwd: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of MANIFEST_CANDIDATES) {
    try {
      const buf = await readFile(path.join(cwd, name), 'utf8');
      const truncated = buf.length > MANIFEST_LIMIT ? buf.slice(0, MANIFEST_LIMIT) + '\n…(truncated)' : buf;
      out.push(`### ${name}\n${truncated}`);
    } catch {
      // missing — fine
    }
  }
  return out;
}

async function shallowTree(cwd: string): Promise<string> {
  const entries: string[] = [];
  let count = 0;
  try {
    const top = await readdir(cwd, { withFileTypes: true });
    for (const e of top.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === '.git' || e.name === 'node_modules' || e.name === 'dist' || e.name === '.next') continue;
      if (count >= TREE_ENTRY_LIMIT) break;
      if (e.isDirectory()) {
        entries.push(`${e.name}/`);
        count++;
        // one level deep
        try {
          const sub = await readdir(path.join(cwd, e.name), { withFileTypes: true });
          for (const s of sub.sort((a, b) => a.name.localeCompare(b.name))) {
            if (count >= TREE_ENTRY_LIMIT) break;
            if (s.name.startsWith('.')) continue;
            entries.push(`  ${e.name}/${s.name}${s.isDirectory() ? '/' : ''}`);
            count++;
          }
        } catch {
          // ignore unreadable subdir
        }
      } else {
        entries.push(e.name);
        count++;
      }
    }
  } catch (err) {
    logger.warn({ err }, 'shallowTree readdir failed');
  }
  return entries.join('\n');
}

export interface RepoContextOptions {
  repository: string;
  baseBranch?: string;
  /** Used to derive a unique workspace dir; cleaned up after extraction. */
  taskId: string;
  /** Soft timeout for the whole extraction (clone + reads). Default 60s. */
  timeoutMs?: number;
  /** Optional progress hook — called as the extractor advances through stages. */
  onProgress?: ProgressHandler;
}

export type ProgressStage =
  | 'cloning'
  | 'reading-files'
  | 'extracted'
  | 'clone-failed'
  | 'timeout';

export type ProgressHandler = (stage: ProgressStage, detail?: string) => void;

export interface RepoContext {
  /** Markdown blob to inject into the LLM prompt. */
  prompt: string;
  /** Bytes of the prompt blob — useful for telemetry. */
  bytes: number;
}

/**
 * Clone + read + format. Best effort: returns null if anything fails badly
 * enough that the spec generator should proceed without repo context.
 */
export async function extractRepoContext(opts: RepoContextOptions): Promise<RepoContext | null> {
  const workdirName = `spec-${opts.taskId.slice(0, 8)}-${Date.now().toString(36)}`;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const progress = opts.onProgress ?? (() => undefined);
  const startedAt = Date.now();
  let handle: git.RepoHandle | null = null;

  const work = (async () => {
    progress('cloning', `git clone --depth 1 ${opts.repository}${opts.baseBranch ? ` (branch: ${opts.baseBranch})` : ''}`);
    handle = await git.clone({
      repo: opts.repository,
      ...(opts.baseBranch ? { ref: opts.baseBranch } : {}),
      depth: 1,
      workdirName,
    });

    const cwd = handle.cwd;
    progress('reading-files', 'Reading README, manifests, and file tree');
    const [readme, manifests, tree] = await Promise.all([
      tryReadFirst(cwd, README_CANDIDATES, README_LIMIT),
      readManifests(cwd),
      shallowTree(cwd),
    ]);

    const sections: string[] = [
      `## Target repository: ${opts.repository}${opts.baseBranch ? ` (branch: ${opts.baseBranch})` : ''}`,
      '',
      'Below is the *current* state of the repo at HEAD. Base your spec on what',
      'this repo ALREADY IS. Describe what to ADD/CHANGE — do not invent the',
      'project from scratch. If the repo already implements the feature, the',
      'spec should describe the modifications/improvements only.',
      '',
    ];

    if (readme) {
      sections.push('## Repo README', readme, '');
    } else {
      sections.push('## Repo README', '_(no README found at the repo root)_', '');
    }

    if (manifests.length > 0) {
      sections.push('## Manifest files', ...manifests, '');
    }

    if (tree) {
      sections.push('## File tree (depth 2, some dirs omitted)', '```', tree, '```', '');
    }

    const prompt = sections.join('\n');
    progress('extracted', `${prompt.length} chars (README:${readme ? 'yes' : 'no'}, manifests:${manifests.length}, tree:${tree ? 'yes' : 'no'})`);
    return { prompt, bytes: prompt.length };
  })();

  try {
    const result = await Promise.race([
      work,
      new Promise<null>((resolve) =>
        setTimeout(() => {
          const elapsed = Date.now() - startedAt;
          logger.warn({ taskId: opts.taskId, repo: opts.repository, timeoutMs, elapsedMs: elapsed }, 'Repo context extraction timed out');
          progress('timeout', `${timeoutMs}ms exceeded (clone is unusually slow — falling back)`);
          resolve(null);
        }, timeoutMs),
      ),
    ]);
    return result;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    logger.warn({ taskId: opts.taskId, repo: opts.repository, err: m }, 'Repo context extraction failed');
    progress('clone-failed', m);
    return null;
  } finally {
    if (handle) {
      try {
        await rm((handle as git.RepoHandle).cwd, { recursive: true, force: true });
      } catch (cleanupErr) {
        logger.debug({ cleanupErr }, 'spec-clone cleanup failed (non-fatal)');
      }
    }
  }
}
