/**
 * Liliput Deploy Contract.
 *
 * Single source of truth for the runtime constraints every deployed-app
 * agent needs to satisfy. The same text is:
 *
 *   1. Prepended to the coder agent's initial prompt (so the agent builds
 *      the app right the FIRST time).
 *   2. Prepended to the ops-fixer prompt (so the fixer reasons about the
 *      proxy when the build is broken).
 *   3. Dropped as `LILIPUT_DEPLOY_CONTRACT.md` at the cloned workspace root
 *      (and excluded from git via `.git/info/exclude`) so the agent can
 *      re-read it any time during the session.
 *
 * Why this exists: target apps are deployed behind a path-stripping nginx
 * gateway that lives in the liliput-gateway pod. The agent's natural
 * mental model is "the pod IS the public origin" — which causes redirect
 * loops, 404s on absolute asset URLs, and other proxy-mismatch bugs that
 * the agent cannot diagnose by curl-ing localhost from inside the pod.
 * By making the contract explicit and present at every relevant prompt,
 * the agent has the information it needs to build a path-prefix-aware app.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { logger } from '../logger.js';

/** Compute the deterministic public path-prefix for a (repo, branch) pair. */
export function pathPrefixFor(repo: string, branch: string): string {
  const [owner = 'unknown', name = 'repo'] = repo.split('/');
  return `/dev/${sanitiseSegment(owner)}/${sanitiseSegment(name)}/${sanitiseSegment(branch)}`;
}

function sanitiseSegment(s: string): string {
  // Match the same sanitisation k8s namespace creation uses.
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
}

export interface DeployContractContext {
  /** e.g. "/dev/owner/repo/branch" — no trailing slash. */
  pathPrefix: string;
  /** Container port the app must listen on. May be undefined at coder phase. */
  port?: number;
  /** Full public URL e.g. "http://host/dev/owner/repo/branch/". May be undefined pre-deploy. */
  devUrl?: string;
}

export const LILIPUT_CONTRACT_FILENAME = 'LILIPUT_DEPLOY_CONTRACT.md';

/**
 * The full contract as a Markdown string.
 * Compact (~50 lines) — designed to be cheap to embed in every relevant
 * prompt and to be skim-readable by the agent.
 */
export function buildDeployContract(ctx: DeployContractContext): string {
  const { pathPrefix, port, devUrl } = ctx;
  const portStr = port ? String(port) : '$PORT (the port your Dockerfile EXPOSEs)';
  const devUrlStr = devUrl ?? `http://<liliput-host>${pathPrefix}/`;

  return [
    '# 🛰️  Liliput Deploy Contract',
    '',
    'Your app is deployed behind a **path-stripping reverse proxy** (nginx in the liliput-gateway pod).',
    'You will be tempted to assume your container is the public origin. **It is not.**',
    'Misunderstand this and your dev preview will redirect-loop, 404 on assets, or both.',
    '',
    '## Topology',
    '',
    '```',
    `Browser → http://<liliput-host>${pathPrefix}/...`,
    `         ↓ nginx rewrite: ^${pathPrefix}/(.*)$ → /$1     (PREFIX IS STRIPPED)`,
    `         ↓ X-Forwarded-Prefix: ${pathPrefix}`,
    `Pod    → http://app.<namespace>.svc.cluster.local:${portStr}/...   (sees ROOT paths)`,
    '```',
    '',
    '## Hard rules for your container',
    '',
    `1. **Bind to \`0.0.0.0:${portStr}\`** — never \`127.0.0.1\`. The Service will not reach localhost-only listeners.`,
    `2. **Serve everything at \`/\`** (\`/\`, \`/assets/*\`, \`/api/*\`, …). Do NOT mount routes under \`${pathPrefix}\` — nginx already stripped that.`,
    `3. **Never emit a \`Location:\` header containing \`${pathPrefix}\`.** \`res.redirect()\` writes that header to the *browser*, which re-enters the proxy → nginx strips → your app redirects again → infinite loop. The classic broken pattern is \`if (path !== BASE_PATH) res.redirect(BASE_PATH)\` — delete it.`,
    `4. **SPAs (Vite / Next / etc.): bake the prefix into the BUILD output, not the server.** Asset URLs in the served HTML must be **prefixed**, e.g. \`<script src="${pathPrefix}/assets/x.js">\`, because the browser resolves \`/assets/x.js\` against host root and bypasses the prefix entirely.`,
    `   - Vite: \`vite build --base=${pathPrefix}/\` (or \`base: '${pathPrefix}/'\` in vite.config).`,
    `   - Next.js: \`basePath: '${pathPrefix}'\` and \`assetPrefix: '${pathPrefix}'\` in next.config.`,
    `   - Plain HTML: edit \`<script src="...">\`/\`<link href="...">\` to start with \`${pathPrefix}/\`.`,
    `5. **API calls from the browser** must include the prefix too: \`fetch("${pathPrefix}/api/...")\` — same reason as #4.`,
    '6. **Honour `X-Forwarded-Prefix`** if you must generate self-links server-side. Otherwise ignore it for routing — nginx already stripped the path before you saw it.',
    '',
    '## How to verify',
    '',
    `Inside-pod curls **prove nothing**. The only test that matters is:`,
    '',
    '```bash',
    `curl -sv ${devUrlStr}                     # must return 200 with your real HTML`,
    `curl -sv ${devUrlStr}assets/<some-asset>   # must return 200 with the right content-type`,
    '```',
    '',
    'If the root returns a 302 with `Location` pointing back at itself → you have rule #3 wrong.',
    'If assets return 404 → you have rule #4 wrong (HTML is emitting absolute `/assets/...`).',
    `If 502/503 → your app is not listening on \`0.0.0.0:${portStr}\` (rule #1).`,
    '',
    '## Environment variables provided by Liliput',
    '',
    `- \`PORT\` — the port the Service expects you to listen on${port ? ` (= ${port})` : ''}.`,
    `- \`BASE_PATH\` is **NOT** set by Liliput. If your existing app code reads it, set it to the empty string.`,
    `- \`X-Forwarded-Prefix: ${pathPrefix}\` is set on every inbound request header.`,
  ].join('\n');
}

/**
 * Drops `LILIPUT_DEPLOY_CONTRACT.md` at the cloned workspace root and
 * appends it to `.git/info/exclude` so it never gets committed into the
 * target repo.
 */
export async function writeContractIntoWorkspace(
  cwd: string,
  ctx: DeployContractContext,
): Promise<void> {
  const contractPath = path.join(cwd, LILIPUT_CONTRACT_FILENAME);
  try {
    await fs.writeFile(contractPath, buildDeployContract(ctx), 'utf8');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), cwd },
      'Failed to write LILIPUT_DEPLOY_CONTRACT.md into workspace',
    );
    return;
  }

  // Add to local-only gitignore so `git add -A` (run by Liliput after the
  // agent finishes) does not commit our scaffolding into the target repo.
  const excludePath = path.join(cwd, '.git', 'info', 'exclude');
  try {
    let existing = '';
    try {
      existing = await fs.readFile(excludePath, 'utf8');
    } catch {
      // file may not exist yet; that's fine
    }
    if (!existing.split('\n').some((line) => line.trim() === LILIPUT_CONTRACT_FILENAME)) {
      const next = (existing.endsWith('\n') || existing === '' ? existing : existing + '\n')
        + LILIPUT_CONTRACT_FILENAME + '\n';
      await fs.mkdir(path.dirname(excludePath), { recursive: true });
      await fs.writeFile(excludePath, next, 'utf8');
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), cwd },
      'Failed to add LILIPUT_DEPLOY_CONTRACT.md to .git/info/exclude (file may be committed)',
    );
  }
}
