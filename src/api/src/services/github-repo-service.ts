/**
 * Thin GitHub REST wrapper for repo *creation* + existence checks.
 * Mirrors the fetch + bearer-token style used by `github-pr.ts` to keep
 * the codebase free of an octokit dependency for now.
 */

const GITHUB_API = 'https://api.github.com';

function getToken(): string {
  const token =
    process.env['COPILOT_GITHUB_TOKEN'] ??
    process.env['GH_TOKEN'] ??
    process.env['GITHUB_TOKEN'];
  if (!token) {
    throw new Error('No GitHub token configured (COPILOT_GITHUB_TOKEN).');
  }
  return token;
}

const headers = (): Record<string, string> => ({
  Authorization: `Bearer ${getToken()}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'liliput',
});

export interface CreatedRepo {
  owner: string;
  name: string;
  fullName: string;     // "owner/name"
  htmlUrl: string;
  cloneUrl: string;     // https URL the agent uses to clone
  defaultBranch: string;
  visibility: 'public' | 'private';
}

export interface CreateRepoInput {
  name: string;
  description?: string;
  visibility: 'public' | 'private';
  /** Initial branch name. GitHub creates it via auto_init. */
  defaultBranch?: string;
}

export class RepoCreateError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: 'name-taken' | 'invalid' | 'forbidden' | 'gh-down' | 'unknown',
  ) {
    super(message);
    this.name = 'RepoCreateError';
  }
}

/**
 * Get the authenticated user's login. Used to namespace newly created repos.
 * Cached per process — the token doesn't change at runtime.
 */
let cachedLogin: string | undefined;
export async function getAuthenticatedUserLogin(): Promise<string> {
  if (cachedLogin) return cachedLogin;
  const res = await fetch(`${GITHUB_API}/user`, { headers: headers() });
  if (!res.ok) {
    throw new RepoCreateError(
      `GitHub /user returned ${res.status}: ${await res.text()}`,
      res.status,
      res.status === 401 || res.status === 403 ? 'forbidden' : 'gh-down',
    );
  }
  const body = (await res.json()) as { login: string };
  cachedLogin = body.login;
  return cachedLogin;
}

/**
 * Test/dev hook to clear the user-login cache.
 */
export function resetGithubRepoServiceCache(): void {
  cachedLogin = undefined;
}

/**
 * Returns true iff GitHub already has a repo at owner/name (HTTP 200).
 * 404 → false. Anything else throws.
 */
export async function repoExists(owner: string, name: string): Promise<boolean> {
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${name}`, { headers: headers() });
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw new RepoCreateError(
    `GitHub /repos/${owner}/${name} returned ${res.status}`,
    res.status,
    res.status === 401 || res.status === 403 ? 'forbidden' : 'gh-down',
  );
}

/**
 * Create a new repository under the authenticated user. Always uses
 * `auto_init: true` so the default branch exists immediately and we can
 * clone without a "remote HEAD is ambiguous" warning.
 */
export async function createRepoForAuthenticatedUser(
  input: CreateRepoInput,
): Promise<CreatedRepo> {
  const body = {
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    private: input.visibility === 'private',
    auto_init: true,
    ...(input.defaultBranch ? { default_branch: input.defaultBranch } : {}),
  };
  const res = await fetch(`${GITHUB_API}/user/repos`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 201) {
    const repo = (await res.json()) as {
      name: string;
      full_name: string;
      html_url: string;
      clone_url: string;
      default_branch: string;
      private: boolean;
      owner: { login: string };
    };
    return {
      owner: repo.owner.login,
      name: repo.name,
      fullName: repo.full_name,
      htmlUrl: repo.html_url,
      cloneUrl: repo.clone_url,
      defaultBranch: repo.default_branch,
      visibility: repo.private ? 'private' : 'public',
    };
  }
  const text = await res.text();
  if (res.status === 422) {
    // GitHub returns 422 for both "name already exists" and other
    // validation errors. Inspect the body to distinguish.
    const taken = /name already exists/i.test(text);
    throw new RepoCreateError(
      taken
        ? `A repository named "${input.name}" already exists on this account.`
        : `GitHub rejected the repo: ${text}`,
      taken ? 409 : 400,
      taken ? 'name-taken' : 'invalid',
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new RepoCreateError(
      `GitHub denied repo creation (HTTP ${res.status}). The token may be missing the 'repo' scope.`,
      res.status,
      'forbidden',
    );
  }
  throw new RepoCreateError(
    `GitHub /user/repos returned ${res.status}: ${text}`,
    res.status >= 500 ? 502 : res.status,
    'gh-down',
  );
}

/**
 * Validate a repo name against GitHub's accepted character set BEFORE
 * making any API call. Saves a round-trip and produces a friendlier error
 * for the form. Mirrors GitHub's documented rules.
 */
export function validateRepoName(name: string): { ok: true } | { ok: false; reason: string } {
  if (!name || !name.trim()) return { ok: false, reason: 'Name is required.' };
  const trimmed = name.trim();
  if (trimmed.length > 100) return { ok: false, reason: 'Name must be 100 characters or fewer.' };
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    return {
      ok: false,
      reason: 'Only letters, numbers, ".", "_" and "-" are allowed.',
    };
  }
  if (/^[.-]/.test(trimmed)) {
    return { ok: false, reason: 'Name cannot start with "." or "-".' };
  }
  if (trimmed === '.' || trimmed === '..') {
    return { ok: false, reason: 'Reserved name.' };
  }
  return { ok: true };
}
