/**
 * GitHub PR helper — minimal REST wrapper, no external deps.
 *
 * Uses the same COPILOT_GITHUB_TOKEN as git operations.
 */

export interface OpenPullRequestOptions {
  /** "owner/repo" */
  repo: string;
  /** PR title. */
  title: string;
  /** PR body / description. */
  body?: string;
  /** Source branch (the agent's feature branch). */
  head: string;
  /** Target branch. Default: "main". */
  base?: string;
  /** Open as draft. Default: false. */
  draft?: boolean;
}

export interface PullRequest {
  number: number;
  htmlUrl: string;
  apiUrl: string;
  state: string;
}

function getToken(): string {
  const token =
    process.env['COPILOT_GITHUB_TOKEN'] ??
    process.env['GH_TOKEN'] ??
    process.env['GITHUB_TOKEN'];
  if (!token) {
    throw new Error('No GitHub token found.');
  }
  return token;
}

interface GitHubPrResponse {
  number: number;
  html_url: string;
  url: string;
  state: string;
}

export type RepoVerification =
  | { ok: true; defaultBranch: string }
  | { ok: false; status: number; reason: string };

/**
 * Verify the configured token can access "owner/repo" via the GitHub REST API.
 * Used at task creation to fail loudly on typoed / inaccessible repos rather
 * than letting the error surface mid-pipeline as a confusing clone failure.
 *
 * Never throws. On network/timeout failures it returns ok=false with a
 * descriptive reason so callers can decide whether to allow or block.
 */
export async function verifyRepositoryAccess(
  ownerRepo: string,
  timeoutMs = 8000,
): Promise<RepoVerification> {
  // Normalize "https://github.com/owner/repo(.git)?" → "owner/repo".
  const normalized = ownerRepo
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  if (!/^[^/\s]+\/[^/\s]+$/.test(normalized)) {
    return { ok: false, status: 400, reason: 'repository must be "owner/repo" (or a github.com URL)' };
  }
  let token: string;
  try {
    token = getToken();
  } catch {
    return { ok: false, status: 401, reason: 'No GitHub token configured on the server.' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.github.com/repos/${normalized}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: controller.signal,
    });
    if (res.status === 404) {
      return {
        ok: false,
        status: 404,
        reason: `Repository "${normalized}" not found or not accessible with the configured token. Check the spelling and that the token has access.`,
      };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        status: res.status,
        reason: `GitHub denied access to "${normalized}" (HTTP ${res.status}). The token may be missing scopes or expired.`,
      };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        status: res.status,
        reason: `GitHub returned HTTP ${res.status} for "${normalized}": ${text.slice(0, 200)}`,
      };
    }
    const json = (await res.json()) as { default_branch?: string };
    return { ok: true, defaultBranch: json.default_branch ?? 'main' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 502,
      reason: `Could not reach GitHub to verify "${normalized}": ${message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function openPullRequest(
  options: OpenPullRequestOptions,
): Promise<PullRequest> {
  const token = getToken();
  const url = `https://api.github.com/repos/${options.repo}/pulls`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: options.title,
      body: options.body ?? '',
      head: options.head,
      base: options.base ?? 'main',
      draft: options.draft ?? false,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub PR creation failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as GitHubPrResponse;
  return {
    number: data.number,
    htmlUrl: data.html_url,
    apiUrl: data.url,
    state: data.state,
  };
}

/**
 * Mark a draft PR as ready for review using the GraphQL API.
 * REST has no endpoint for this — only GraphQL.
 */
export async function markPullRequestReady(repo: string, prNumber: number): Promise<void> {
  const token = getToken();
  // Need the PR's node_id first
  const meta = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (!meta.ok) {
    throw new Error(`Could not fetch PR #${prNumber}: ${meta.status} ${await meta.text()}`);
  }
  const { node_id } = (await meta.json()) as { node_id: string };

  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: 'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }',
      variables: { id: node_id },
    }),
  });
  const data = (await res.json()) as { errors?: Array<{ message: string }> };
  if (!res.ok || data.errors?.length) {
    throw new Error(
      `Mark-ready failed: ${data.errors?.map((e) => e.message).join('; ') ?? res.statusText}`,
    );
  }
}

/** Close a PR without merging. */
export async function closePullRequest(repo: string, prNumber: number): Promise<void> {
  const token = getToken();
  const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ state: 'closed' }),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Close PR failed (${res.status}): ${await res.text()}`);
  }
}
