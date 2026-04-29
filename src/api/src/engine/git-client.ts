/**
 * Git client — clone, branch, commit, push.
 *
 * Auth: embeds COPILOT_GITHUB_TOKEN in the remote URL via the
 * `x-access-token:<token>@github.com/...` form, which works for both
 * classic PATs and gh OAuth tokens.
 *
 * Workspaces are scoped per-task under AGENT_WORKSPACE_ROOT (default
 * /workspaces). Each clone goes into a fresh subdir to avoid collisions.
 *
 * Retry policy: network-touching commands (clone, push) are wrapped in
 * `runWithRetry()` which classifies failures and retries transient ones
 * with exponential backoff. Each retry is reported via the optional
 * `onLog` callback so the UI can show the agent recovering.
 */

import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const WORKSPACE_ROOT = process.env['AGENT_WORKSPACE_ROOT'] ?? '/workspaces';
const DEFAULT_AUTHOR_NAME = process.env['GIT_AUTHOR_NAME'] ?? 'Liliput Agent';
const DEFAULT_AUTHOR_EMAIL =
  process.env['GIT_AUTHOR_EMAIL'] ?? 'liliput-agent@users.noreply.github.com';

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = [1000, 3000, 8000];

export type RetryLog = (message: string) => void;

/** Heuristics for transient errors that are worth retrying. */
const TRANSIENT_PATTERNS: RegExp[] = [
  /could not resolve host/i,
  /temporary failure in name resolution/i,
  /connection (?:refused|reset|timed out)/i,
  /operation timed out/i,
  /\bearly EOF\b/i,
  /\brpc failed\b/i,
  /\bremote end hung up\b/i,
  /\bunexpected disconnect\b/i,
  /\bThe remote server returned an error\b/i,
  /\bHTTP\s*(?:408|425|429|500|502|503|504|520|521|522|524)\b/i,
  /\bgnutls_handshake\b/i,
  /\bSSL_(?:read|write|connect)\b/i,
  /\bTLS handshake\b/i,
  /\b(?:no error|error 0)\b.*?\bremote\b/i,
];

/** Heuristics for permanent errors — don't bother retrying. */
const PERMANENT_PATTERNS: RegExp[] = [
  /authentication failed/i,
  /\bpermission denied\b/i,
  /\brepository not found\b/i,
  /\bcould not read username\b/i,
  /\bcould not read password\b/i,
  /\bdoes not appear to be a git repository\b/i,
  /\b(?:remote ref|branch).*\bnot found\b/i,
  /\bnothing to commit\b/i,
  /\balready exists\b/i,
  /\bnon-fast-forward\b/i,
  /\brejected\b.*\bfetch first\b/i,
];

function classifyError(stderr: string): 'transient' | 'permanent' {
  for (const re of PERMANENT_PATTERNS) if (re.test(stderr)) return 'permanent';
  for (const re of TRANSIENT_PATTERNS) if (re.test(stderr)) return 'transient';
  // Unknown errors: be conservative and treat as permanent so we don't loop
  // forever on logic bugs. Genuine transient errors usually match a pattern.
  return 'permanent';
}

export interface CloneOptions {
  /** "owner/repo" — public or private (token must have access). */
  repo: string;
  /** Branch to check out after clone (default: repository default). */
  ref?: string;
  /** Subdirectory name inside WORKSPACE_ROOT. Default: derived from repo + timestamp. */
  workdirName?: string;
  /** Shallow clone depth. Default: 1 (fastest). Pass 0 for full history. */
  depth?: number;
  /** Optional logger that receives one line per retry attempt + outcome. */
  onLog?: RetryLog;
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

interface RetryConfig {
  maxAttempts?: number;
  backoffMs?: number[];
  /** Called once per attempt: 1, 2, 3… */
  onAttempt?: (attempt: number) => void;
  /** Called on a transient failure with the attempt number and error. */
  onRetry?: (attempt: number, err: Error, waitMs: number) => void;
  /** Called on giving-up failure (permanent or attempts exhausted). */
  onGiveUp?: (attempt: number, err: Error, classification: 'transient' | 'permanent') => void;
  /** Optional async hook to run BEFORE each retry attempt (e.g. clean up partial state). */
  beforeAttempt?: (attempt: number) => Promise<void>;
}

/**
 * Run an async operation with classified retry. Transient failures
 * (network, RPC) are retried up to `maxAttempts` with exponential
 * backoff; permanent failures (auth, not found) bubble up immediately.
 */
export async function runWithRetry<T>(
  op: () => Promise<T>,
  cfg: RetryConfig = {},
): Promise<T> {
  const max = cfg.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoff = cfg.backoffMs ?? DEFAULT_BACKOFF_MS;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    if (cfg.beforeAttempt) await cfg.beforeAttempt(attempt);
    cfg.onAttempt?.(attempt);
    try {
      return await op();
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      const cls = classifyError(e.message);
      if (cls === 'permanent' || attempt >= max) {
        cfg.onGiveUp?.(attempt, e, cls);
        throw e;
      }
      const waitMs = backoff[attempt - 1] ?? backoff[backoff.length - 1] ?? 5000;
      cfg.onRetry?.(attempt, e, waitMs);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

/** Clone a repo into a fresh workspace directory and return a handle. */
export async function clone(options: CloneOptions): Promise<RepoHandle> {
  const token = getToken();
  const repoSlug = options.repo.replace(/\//g, '-');
  const dirName =
    options.workdirName ?? `${repoSlug}-${Date.now().toString(36)}`;
  const cwd = path.join(WORKSPACE_ROOT, dirName);
  const log = options.onLog;

  await mkdir(WORKSPACE_ROOT, { recursive: true });

  const args = ['clone'];
  const depth = options.depth ?? 1;
  if (depth > 0) args.push('--depth', String(depth));
  if (options.ref) args.push('--branch', options.ref);
  args.push(authenticatedUrl(options.repo, token), cwd);

  await runWithRetry(() => run('git', args), {
    onAttempt: (n) => {
      if (n > 1) log?.(`Retrying git clone (attempt ${n})…`);
    },
    onRetry: (n, err, waitMs) => {
      const summary = err.message.split('\n').slice(-2).join(' ').trim();
      log?.(`Transient failure on git clone attempt ${n}: ${summary}. Retrying in ${Math.round(waitMs / 1000)}s.`);
    },
    onGiveUp: (n, err, cls) => {
      log?.(`git clone failed after ${n} attempt(s) [${cls}]: ${err.message.split('\n').pop()?.trim() ?? ''}`);
    },
    beforeAttempt: async () => {
      // Each attempt needs a clean target dir or `git clone` errors with
      // "already exists and is not an empty directory".
      if (existsSync(cwd)) await rm(cwd, { recursive: true, force: true });
    },
  });

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
export async function push(
  handle: RepoHandle,
  opts: { onLog?: RetryLog } = {},
): Promise<void> {
  const log = opts.onLog;
  await runWithRetry(
    () =>
      run('git', ['push', '--set-upstream', 'origin', handle.branch], {
        cwd: handle.cwd,
      }),
    {
      onAttempt: (n) => {
        if (n > 1) log?.(`Retrying git push (attempt ${n})…`);
      },
      onRetry: (n, err, waitMs) => {
        const summary = err.message.split('\n').slice(-2).join(' ').trim();
        log?.(`Transient failure on git push attempt ${n}: ${summary}. Retrying in ${Math.round(waitMs / 1000)}s.`);
      },
      onGiveUp: (n, err, cls) => {
        log?.(`git push failed after ${n} attempt(s) [${cls}]: ${err.message.split('\n').pop()?.trim() ?? ''}`);
      },
    },
  );
}

/** Returns the current HEAD commit SHA. */
export async function headSha(handle: RepoHandle): Promise<string> {
  const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: handle.cwd });
  return stdout.trim();
}

/** True when the working tree (tracked files) is clean — no staged or unstaged changes. */
export async function isWorkingTreeClean(handle: RepoHandle): Promise<boolean> {
  const { stdout } = await run('git', ['status', '--porcelain'], { cwd: handle.cwd });
  return stdout.trim() === '';
}

/**
 * True when the local branch has a remote tracking branch and is up to date
 * with it (no commits to push). Used as a recovery check after a git-fixer
 * turn — if the fixer pushed itself, our re-attempt would error with
 * "Everything up-to-date" so we treat this state as success instead.
 */
export async function isBranchUpToDateWithRemote(handle: RepoHandle): Promise<boolean> {
  // Refresh remote tracking refs so the comparison reflects reality.
  try {
    await run('git', ['fetch', '--quiet', 'origin', handle.branch], { cwd: handle.cwd });
  } catch {
    // Fetch failure (transient network, etc.) — fall through to local check.
  }
  try {
    const { stdout: local } = await run('git', ['rev-parse', 'HEAD'], { cwd: handle.cwd });
    const { stdout: remote } = await run(
      'git',
      ['rev-parse', `origin/${handle.branch}`],
      { cwd: handle.cwd },
    );
    return local.trim() === remote.trim() && local.trim() !== '';
  } catch {
    return false;
  }
}

/** Run an arbitrary git command in the workdir. Used by ad-hoc tooling. */
export async function rawGit(
  handle: RepoHandle,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return run('git', args, { cwd: handle.cwd });
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
