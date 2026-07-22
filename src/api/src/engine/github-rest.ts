/**
 * Minimal GitHub REST client used by the PM / Dev / RM agent loop.
 *
 * Keep this module dependency-free (only `fetch` + the same token resolution
 * as `github-pr.ts`) so it is trivial to mock in tests. Every function takes
 * an optional `fetchImpl` override so unit tests can inject a stub without
 * monkey-patching the global.
 *
 * All operations are *idempotent* at the GitHub level:
 *   - `ensureLabel`     — 200 if exists, 201 if created, never 422.
 *   - `createIssue`     — caller is responsible for idempotency. The PM flow
 *                         persists `feature.githubIssueNumber` first and
 *                         skips on the next call.
 *   - `addLabels`       — GitHub merges into the existing set; safe to repeat.
 *   - `removeLabel`     — 404 is treated as success (already gone).
 *   - `addComment`      — caller dedups by content marker if needed.
 */

export type FetchImpl = typeof fetch;

const API = 'https://api.github.com';
const API_HEADERS_BASE = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

/** Resolve the GitHub token using the same fallback chain as `github-pr.ts`. */
export function getGitHubToken(): string {
  const token =
    process.env['COPILOT_GITHUB_TOKEN'] ??
    process.env['GH_TOKEN'] ??
    process.env['GITHUB_TOKEN'];
  if (!token) {
    throw new Error('No GitHub token found (set COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN).');
  }
  return token;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${getGitHubToken()}`,
    ...API_HEADERS_BASE,
  };
}

export class GitHubApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
    public readonly responseText: string,
  ) {
    super(`GitHub ${endpoint} failed (${status}): ${responseText.slice(0, 300)}`);
    this.name = 'GitHubApiError';
  }
}

export interface EnsureLabelOptions {
  repo: string;            // "owner/repo"
  name: string;            // label name (e.g. "pm:ready", "workstream:billing")
  color?: string;          // 6-char hex without `#`. Default: "ededed".
  description?: string;    // optional label description (<=100 chars)
  fetchImpl?: FetchImpl;
}

/**
 * Idempotent label upsert. Tries POST first; on 422 ("already_exists") it
 * does NOT PATCH (avoids overwriting human-customised colors). Returns:
 *   - `created`  — fresh insert
 *   - `existed`  — already present, left untouched
 */
export async function ensureLabel(
  opts: EnsureLabelOptions,
): Promise<{ result: 'created' | 'existed' }> {
  const f = opts.fetchImpl ?? fetch;
  const url = `${API}/repos/${opts.repo}/labels`;
  const body = JSON.stringify({
    name: opts.name,
    color: opts.color ?? 'ededed',
    description: (opts.description ?? '').slice(0, 100),
  });
  const res = await f(url, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body,
  });
  if (res.status === 201) return { result: 'created' };
  if (res.status === 422) {
    // "already_exists" — confirm via GET so we don't mask a different 422.
    const txt = await res.text();
    if (/already_exists/i.test(txt)) return { result: 'existed' };
    throw new GitHubApiError(res.status, 'POST /labels', txt);
  }
  throw new GitHubApiError(res.status, 'POST /labels', await res.text());
}

export interface CreateIssueOptions {
  repo: string;
  title: string;
  body: string;
  labels?: string[];
  fetchImpl?: FetchImpl;
}

export interface CreatedIssue {
  number: number;
  htmlUrl: string;
  nodeId: string;
}

/**
 * Create a GitHub issue. Returns the assigned number + html_url.
 *
 * Callers in the PM flow should NOT include `pm:ready` here — that label is
 * applied in a second call (`addLabels`) AFTER `feature.githubIssueNumber`
 * has been persisted. This avoids the race where a webhook fires before
 * the local DB knows which Feature the issue belongs to.
 */
export async function createIssue(opts: CreateIssueOptions): Promise<CreatedIssue> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${API}/repos/${opts.repo}/issues`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: opts.title,
      body: opts.body,
      labels: opts.labels ?? [],
    }),
  });
  if (!res.ok) {
    throw new GitHubApiError(res.status, 'POST /issues', await res.text());
  }
  const data = (await res.json()) as {
    number: number;
    html_url: string;
    node_id: string;
  };
  return { number: data.number, htmlUrl: data.html_url, nodeId: data.node_id };
}

export interface AddLabelsOptions {
  repo: string;
  issueNumber: number;
  labels: string[];
  fetchImpl?: FetchImpl;
}

/** Add labels to an existing issue. GitHub merges (no duplicate side-effect). */
export async function addLabels(opts: AddLabelsOptions): Promise<void> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(
    `${API}/repos/${opts.repo}/issues/${opts.issueNumber}/labels`,
    {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels: opts.labels }),
    },
  );
  if (!res.ok) {
    throw new GitHubApiError(
      res.status,
      `POST /issues/${opts.issueNumber}/labels`,
      await res.text(),
    );
  }
}

export interface RemoveLabelOptions {
  repo: string;
  issueNumber: number;
  label: string;
  fetchImpl?: FetchImpl;
}

/** Remove a single label. 404 = already gone = success. */
export async function removeLabel(opts: RemoveLabelOptions): Promise<void> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(
    `${API}/repos/${opts.repo}/issues/${opts.issueNumber}/labels/${encodeURIComponent(opts.label)}`,
    { method: 'DELETE', headers: authHeaders() },
  );
  if (res.status === 404) return;
  if (!res.ok) {
    throw new GitHubApiError(
      res.status,
      `DELETE /issues/${opts.issueNumber}/labels/${opts.label}`,
      await res.text(),
    );
  }
}

export interface AddCommentOptions {
  repo: string;
  issueNumber: number;
  body: string;
  fetchImpl?: FetchImpl;
}

export async function addComment(opts: AddCommentOptions): Promise<void> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(
    `${API}/repos/${opts.repo}/issues/${opts.issueNumber}/comments`,
    {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: opts.body }),
    },
  );
  if (!res.ok) {
    throw new GitHubApiError(
      res.status,
      `POST /issues/${opts.issueNumber}/comments`,
      await res.text(),
    );
  }
}

// ─── Webhooks ─────────────────────────────────────────────────────────

export interface ListWebhooksOptions {
  repo: string;
  fetchImpl?: FetchImpl;
}

export interface RepoWebhook {
  id: number;
  active: boolean;
  events: string[];
  config: { url?: string; content_type?: string; insecure_ssl?: string };
}

/** List the webhooks installed on a repo. Used to skip recreating one we
 *  already own (idempotent bootstrap). Returns the full GitHub payload. */
export async function listWebhooks(opts: ListWebhooksOptions): Promise<RepoWebhook[]> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${API}/repos/${opts.repo}/hooks?per_page=100`, {
    method: 'GET',
    headers: authHeaders(),
  });
  if (!res.ok) {
    throw new GitHubApiError(res.status, 'GET /hooks', await res.text());
  }
  return (await res.json()) as RepoWebhook[];
}

export interface CreateWebhookOptions {
  repo: string;
  url: string;            // payload destination — `${PUBLIC_BASE_URL}/api/github/webhook`
  secret: string;         // HMAC secret — must match GITHUB_WEBHOOK_SECRET
  events?: string[];      // default: ['issues','pull_request','check_suite','check_run']
  fetchImpl?: FetchImpl;
}

const DEFAULT_WEBHOOK_EVENTS = ['issues', 'pull_request', 'check_suite', 'check_run'];

/** Create a "web" hook on the target repo. Caller is responsible for not
 *  recreating an existing one (use `listWebhooks` first). */
export async function createWebhook(
  opts: CreateWebhookOptions,
): Promise<{ id: number }> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${API}/repos/${opts.repo}/hooks`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'web',
      active: true,
      events: opts.events ?? DEFAULT_WEBHOOK_EVENTS,
      config: {
        url: opts.url,
        content_type: 'json',
        insecure_ssl: '0',
        secret: opts.secret,
      },
    }),
  });
  if (!res.ok) {
    throw new GitHubApiError(res.status, 'POST /hooks', await res.text());
  }
  const data = (await res.json()) as { id: number };
  return { id: data.id };
}

// ─── Pull requests + checks + merge (Release Manager) ─────────────────

export interface GetPullRequestOptions {
  repo: string;
  number: number;
  fetchImpl?: FetchImpl;
}

export interface PullRequestData {
  number: number;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  mergeable: boolean | null;
  mergeable_state: string; // 'clean' | 'dirty' | 'blocked' | 'behind' | 'unknown' | ...
  title: string;
  body: string | null;
  html_url: string;
  labels: Array<{ name: string }>;
  head: { sha: string; ref: string };
  base: { ref: string };
  user: { login: string } | null;
}

/** GET /repos/{repo}/pulls/{n}. Includes mergeable + mergeable_state which
 *  GitHub computes asynchronously after open — may be `null` / `"unknown"`
 *  on the first call after a push. Callers retry on the next event. */
export async function getPullRequest(opts: GetPullRequestOptions): Promise<PullRequestData> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${API}/repos/${opts.repo}/pulls/${opts.number}`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    throw new GitHubApiError(res.status, `GET /pulls/${opts.number}`, await res.text());
  }
  return (await res.json()) as PullRequestData;
}

export interface ListCheckRunsOptions {
  repo: string;
  ref: string; // commit SHA
  fetchImpl?: FetchImpl;
}

export interface CheckRun {
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion:
    | 'success'
    | 'failure'
    | 'neutral'
    | 'cancelled'
    | 'timed_out'
    | 'action_required'
    | 'stale'
    | 'skipped'
    | null;
  html_url: string;
}

/** List the check runs for a commit SHA (typically the PR head). Returns
 *  the merged list across paginated pages up to `per_page=100`. */
export async function listCheckRunsForRef(opts: ListCheckRunsOptions): Promise<CheckRun[]> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(
    `${API}/repos/${opts.repo}/commits/${opts.ref}/check-runs?per_page=100`,
    { headers: authHeaders() },
  );
  if (!res.ok) {
    throw new GitHubApiError(res.status, `GET /commits/${opts.ref}/check-runs`, await res.text());
  }
  const data = (await res.json()) as { check_runs?: CheckRun[] };
  return data.check_runs ?? [];
}

export interface MergePullRequestOptions {
  repo: string;
  number: number;
  /** Merge commit title. Default: GitHub uses the PR title. */
  commitTitle?: string;
  /** Merge commit body. */
  commitMessage?: string;
  /** "merge" | "squash" | "rebase". Default: "squash". */
  mergeMethod?: 'merge' | 'squash' | 'rebase';
  /** Required: the SHA we believe is at HEAD. GitHub rejects with 409 if the
   *  branch advanced since we checked. The RM passes the SHA it just reviewed. */
  sha?: string;
  fetchImpl?: FetchImpl;
}

export interface MergeResult {
  merged: boolean;
  sha: string;
  message: string;
}

/** PUT /repos/{repo}/pulls/{n}/merge. Throws on conflict (409 — branch moved)
 *  so the caller can re-fetch and retry on the next webhook. */
export async function mergePullRequest(opts: MergePullRequestOptions): Promise<MergeResult> {
  const f = opts.fetchImpl ?? fetch;
  const body: Record<string, unknown> = {
    merge_method: opts.mergeMethod ?? 'squash',
  };
  if (opts.commitTitle) body['commit_title'] = opts.commitTitle;
  if (opts.commitMessage) body['commit_message'] = opts.commitMessage;
  if (opts.sha) body['sha'] = opts.sha;
  const res = await f(`${API}/repos/${opts.repo}/pulls/${opts.number}/merge`, {
    method: 'PUT',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new GitHubApiError(res.status, `PUT /pulls/${opts.number}/merge`, await res.text());
  }
  return (await res.json()) as MergeResult;
}

export interface CloseIssueOptions {
  repo: string;
  number: number;
  reason?: 'completed' | 'not_planned' | 'reopened';
  fetchImpl?: FetchImpl;
}

/** PATCH /repos/{repo}/issues/{n} to close an issue explicitly. We do this
 *  in addition to the PR's `Closes #N` because GitHub will NOT auto-close
 *  when the PR targets a non-default branch (Liliput integration branches). */
export async function closeIssue(opts: CloseIssueOptions): Promise<void> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${API}/repos/${opts.repo}/issues/${opts.number}`, {
    method: 'PATCH',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      state: 'closed',
      state_reason: opts.reason ?? 'completed',
    }),
  });
  // 404 is already-gone; treat as success for idempotency.
  if (res.status === 404) return;
  if (!res.ok) {
    throw new GitHubApiError(res.status, `PATCH /issues/${opts.number}`, await res.text());
  }
}

export interface ListIssueCommentsOptions {
  repo: string;
  issueNumber: number;
  fetchImpl?: FetchImpl;
}

export interface IssueComment {
  id: number;
  body: string;
  user: { login: string } | null;
  created_at: string;
}

/** List comments on an issue or PR (issues + PRs share the same endpoint).
 *  Used by the RM to count past `rm:changes-requested` attempts via a
 *  hidden marker, without needing a new DB column. */
export async function listIssueComments(
  opts: ListIssueCommentsOptions,
): Promise<IssueComment[]> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(
    `${API}/repos/${opts.repo}/issues/${opts.issueNumber}/comments?per_page=100`,
    { headers: authHeaders() },
  );
  if (!res.ok) {
    throw new GitHubApiError(
      res.status,
      `GET /issues/${opts.issueNumber}/comments`,
      await res.text(),
    );
  }
  return (await res.json()) as IssueComment[];
}

export interface ListIssuesByLabelOptions {
  repo: string;
  labels?: string[];           // e.g. ['pm:ready']; omitted means no label filter
  state?: 'open' | 'closed' | 'all';
  fetchImpl?: FetchImpl;
}

export interface IssueSummary {
  number: number;
  state: 'open' | 'closed';
  title: string;
  body: string | null;
  html_url: string;
  labels: Array<{ name: string }>;
  pull_request?: unknown; // present when this "issue" is actually a PR
}

/** GET /repos/{r}/issues?labels=... — returns issues AND PRs (GitHub's API
 *  conflates them). Callers must filter by `!item.pull_request` to skip PRs.
 *  Used by the reconciler to find issues we missed because a webhook never
 *  arrived (token without admin:repo_hook ⇒ webhook in polling_fallback). */
export async function listIssuesByLabel(
  opts: ListIssuesByLabelOptions,
): Promise<IssueSummary[]> {
  const f = opts.fetchImpl ?? fetch;
  const state = opts.state ?? 'open';
  const labels =
    opts.labels && opts.labels.length > 0
      ? `&labels=${encodeURIComponent(opts.labels.join(','))}`
      : '';
  const res = await f(
    `${API}/repos/${opts.repo}/issues?state=${state}${labels}&per_page=100`,
    { headers: authHeaders() },
  );
  if (!res.ok) {
    throw new GitHubApiError(res.status, 'GET /issues?labels=...', await res.text());
  }
  return (await res.json()) as IssueSummary[];
}

export interface ListPullsOptions {
  repo: string;
  state?: 'open' | 'closed' | 'all';
  fetchImpl?: FetchImpl;
}

export interface PullSummary {
  number: number;
  state: 'open' | 'closed';
  draft: boolean;
  title: string;
  html_url: string;
  labels: Array<{ name: string }>;
  head: { sha: string };
}

/** GET /repos/{r}/pulls — used by the reconciler to find PRs with rm:review
 *  that the webhook missed. Filtering by label requires the search API; we
 *  list all open PRs (100/page) and filter client-side. */
export async function listPulls(opts: ListPullsOptions): Promise<PullSummary[]> {
  const f = opts.fetchImpl ?? fetch;
  const state = opts.state ?? 'open';
  const res = await f(
    `${API}/repos/${opts.repo}/pulls?state=${state}&per_page=100`,
    { headers: authHeaders() },
  );
  if (!res.ok) {
    throw new GitHubApiError(res.status, 'GET /pulls', await res.text());
  }
  return (await res.json()) as PullSummary[];
}

export interface GetRepositoryBranchShaOptions {
  repo: string;
  branch: string;
  fetchImpl?: FetchImpl;
}

export async function getRepositoryBranchSha(
  opts: GetRepositoryBranchShaOptions,
): Promise<string> {
  const f = opts.fetchImpl ?? fetch;
  const branch = encodeURIComponent(opts.branch);
  const res = await f(`${API}/repos/${opts.repo}/branches/${branch}`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    throw new GitHubApiError(
      res.status,
      `GET /branches/${opts.branch}`,
      await res.text(),
    );
  }
  const body = (await res.json()) as { commit?: { sha?: string } };
  if (!body.commit?.sha) {
    throw new Error(
      `GitHub branch ${opts.repo}:${opts.branch} did not include a commit SHA`,
    );
  }
  return body.commit.sha;
}

export interface RepositoryTreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

export interface GetRepositoryTreeOptions {
  repo: string;
  commitSha: string;
  fetchImpl?: FetchImpl;
}

export async function getRepositoryTreeAtCommit(
  opts: GetRepositoryTreeOptions,
): Promise<{ entries: RepositoryTreeEntry[]; truncated: boolean }> {
  const f = opts.fetchImpl ?? fetch;
  const commitRes = await f(
    `${API}/repos/${opts.repo}/git/commits/${encodeURIComponent(opts.commitSha)}`,
    { headers: authHeaders() },
  );
  if (!commitRes.ok) {
    throw new GitHubApiError(
      commitRes.status,
      `GET /git/commits/${opts.commitSha}`,
      await commitRes.text(),
    );
  }
  const commit = (await commitRes.json()) as { tree?: { sha?: string } };
  if (!commit.tree?.sha) {
    throw new Error(
      `GitHub commit ${opts.repo}@${opts.commitSha} did not include a tree SHA`,
    );
  }

  const treeRes = await f(
    `${API}/repos/${opts.repo}/git/trees/${encodeURIComponent(commit.tree.sha)}?recursive=1`,
    { headers: authHeaders() },
  );
  if (!treeRes.ok) {
    throw new GitHubApiError(
      treeRes.status,
      `GET /git/trees/${commit.tree.sha}`,
      await treeRes.text(),
    );
  }
  const tree = (await treeRes.json()) as {
    tree?: RepositoryTreeEntry[];
    truncated?: boolean;
  };
  return {
    entries: tree.tree ?? [],
    truncated: tree.truncated === true,
  };
}

export interface GetRepositoryFileOptions {
  repo: string;
  path: string;
  ref: string;
  fetchImpl?: FetchImpl;
}

export async function getRepositoryFileAtRef(
  opts: GetRepositoryFileOptions,
): Promise<{ content: string; sha: string; size: number; htmlUrl?: string }> {
  const f = opts.fetchImpl ?? fetch;
  const encodedPath = opts.path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const res = await f(
    `${API}/repos/${opts.repo}/contents/${encodedPath}?ref=${encodeURIComponent(opts.ref)}`,
    { headers: authHeaders() },
  );
  if (!res.ok) {
    throw new GitHubApiError(
      res.status,
      `GET /contents/${opts.path}`,
      await res.text(),
    );
  }
  const body = (await res.json()) as {
    type?: string;
    content?: string;
    encoding?: string;
    sha?: string;
    size?: number;
    html_url?: string;
  };
  if (
    body.type !== 'file' ||
    body.encoding !== 'base64' ||
    !body.content ||
    !body.sha
  ) {
    throw new Error(
      `GitHub content ${opts.repo}:${opts.path}@${opts.ref} is not a readable file`,
    );
  }
  return {
    content: Buffer.from(body.content.replace(/\s/g, ''), 'base64').toString(
      'utf8',
    ),
    sha: body.sha,
    size: body.size ?? 0,
    ...(body.html_url ? { htmlUrl: body.html_url } : {}),
  };
}

export interface PullReviewComment {
  id: number;
  body: string;
  path: string;
  line: number | null;
  user: { login: string } | null;
  created_at: string;
  html_url: string;
}

export interface ListPullReviewCommentsOptions {
  repo: string;
  pullNumber: number;
  fetchImpl?: FetchImpl;
}

export async function listPullReviewComments(
  opts: ListPullReviewCommentsOptions,
): Promise<PullReviewComment[]> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(
    `${API}/repos/${opts.repo}/pulls/${opts.pullNumber}/comments?per_page=100`,
    { headers: authHeaders() },
  );
  if (!res.ok) {
    throw new GitHubApiError(
      res.status,
      `GET /pulls/${opts.pullNumber}/comments`,
      await res.text(),
    );
  }
  return (await res.json()) as PullReviewComment[];
}
