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
