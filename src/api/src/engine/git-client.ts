/**
 * Git client — clone, branch, commit, push.
 *
 * Auth: embeds COPILOT_GITHUB_TOKEN in the remote URL via the
 * `x-access-token:<token>@github.com/...` form, which works for both
 * classic PATs and gh OAuth tokens.
 *
 * Workspaces are scoped per-task under AGENT_WORKSPACE_ROOT (default
 * /workspaces). Each clone goes into a fresh subdir to avoid collisions.
 */

import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const WORKSPACE_ROOT = process.env['AGENT_WORKSPACE_ROOT'] ?? '/workspaces';
const DEFAULT_AUTHOR_NAME = process.env['GIT_AUTHOR_NAME'] ?? 'Liliput Agent';
const DEFAULT_AUTHOR_EMAIL =
  process.env['GIT_AUTHOR_EMAIL'] ?? 'liliput-agent@users.noreply.github.com';

export interface CloneOptions {
  /** "owner/repo" — public or private (token must have access). */
  repo: string;
  /** Branch to check out after clone (default: repository default). */
  ref?: string;
  /** Subdirectory name inside WORKSPACE_ROOT. Default: derived from repo + timestamp. */
  workdirName?: string;
  /** Shallow clone depth. Default: 1 (fastest). Pass 0 for full history. */
  depth?: number;
}

export interface RepoHandle {
  /** Absolute path on disk. */
  cwd: string;
  /** "owner/repo" — useful for downstream PR creation. */
  repo: string;
  /** Branch currently checked out. */
  branch: string;
}

function getToken(): string {
  const token =
    process.env['COPILOT_GITHUB_TOKEN'] ??
    process.env['GH_TOKEN'] ??
    process.env['GITHUB_TOKEN'];
  if (!token) {
    throw new Error(
      'No GitHub token found. Set COPILOT_GITHUB_TOKEN to enable git operations.',
    );
  }
  return token;
}

function authenticatedUrl(repo: string, token: string): string {
  // x-access-token works for both classic PATs and GitHub Apps' installation tokens.
  return `https://x-access-token:${token}@github.com/${repo}.git`;
}

/** Run a process with the given args. Throws with stderr on non-zero exit. */
function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new Error(
            `${cmd} ${args.join(' ')} exited with ${code}\nstderr: ${stderr.trim()}`,
          ),
        );
    });
  });
}

/** Clone a repo into a fresh workspace directory and return a handle. */
export async function clone(options: CloneOptions): Promise<RepoHandle> {
  const token = getToken();
  const repoSlug = options.repo.replace(/\//g, '-');
  const dirName =
    options.workdirName ?? `${repoSlug}-${Date.now().toString(36)}`;
  const cwd = path.join(WORKSPACE_ROOT, dirName);

  await mkdir(WORKSPACE_ROOT, { recursive: true });
  if (existsSync(cwd)) {
    await rm(cwd, { recursive: true, force: true });
  }

  const args = ['clone'];
  const depth = options.depth ?? 1;
  if (depth > 0) args.push('--depth', String(depth));
  if (options.ref) args.push('--branch', options.ref);
  args.push(authenticatedUrl(options.repo, token), cwd);

  await run('git', args);

  // Set per-clone author config (avoids polluting global config)
  await run('git', ['config', 'user.name', DEFAULT_AUTHOR_NAME], { cwd });
  await run('git', ['config', 'user.email', DEFAULT_AUTHOR_EMAIL], { cwd });

  const { stdout: branch } = await run(
    'git',
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    { cwd },
  );

  return { cwd, repo: options.repo, branch: branch.trim() };
}

/** Create and switch to a new branch. */
export async function createBranch(
  handle: RepoHandle,
  branchName: string,
): Promise<void> {
  await run('git', ['checkout', '-b', branchName], { cwd: handle.cwd });
  handle.branch = branchName;
}

/** Stage all changes and commit. Returns the new commit SHA. */
export async function commitAll(
  handle: RepoHandle,
  message: string,
): Promise<string> {
  await run('git', ['add', '-A'], { cwd: handle.cwd });

  // Detect "nothing to commit" up front for a friendlier error.
  const { stdout: status } = await run('git', ['status', '--porcelain'], {
    cwd: handle.cwd,
  });
  if (status.trim() === '') {
    throw new Error('No changes to commit.');
  }

  await run('git', ['commit', '-m', message], { cwd: handle.cwd });
  const { stdout: sha } = await run('git', ['rev-parse', 'HEAD'], {
    cwd: handle.cwd,
  });
  return sha.trim();
}

/** Push the current branch to origin. Sets upstream on first push. */
export async function push(handle: RepoHandle): Promise<void> {
  await run('git', ['push', '--set-upstream', 'origin', handle.branch], {
    cwd: handle.cwd,
  });
}

/** Returns the list of files modified in the working tree relative to HEAD. */
export async function changedFiles(handle: RepoHandle): Promise<string[]> {
  const { stdout } = await run('git', ['status', '--porcelain'], {
    cwd: handle.cwd,
  });
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^\S+\s+/, '').trim())
    .filter(Boolean);
}

/** Remove the workspace directory. Best-effort — never throws. */
export async function cleanup(handle: RepoHandle): Promise<void> {
  try {
    await rm(handle.cwd, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
