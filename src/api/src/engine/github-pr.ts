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
