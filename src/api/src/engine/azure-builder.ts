/**
 * Azure Container Registry build helper.
 *
 * Uses the bundled `az` CLI (installed in the runner image) plus
 * AAD Workload Identity to push images without storing credentials.
 *
 * Required env (set in the deployment):
 *   AZURE_TENANT_ID, AZURE_SUBSCRIPTION_ID, AZURE_CLIENT_ID, ACR_NAME
 *
 * Workload identity provides AZURE_FEDERATED_TOKEN_FILE automatically.
 */

import { spawn } from 'node:child_process';

const ACR_NAME = process.env['ACR_NAME'];
const TENANT_ID = process.env['AZURE_TENANT_ID'];
const CLIENT_ID = process.env['AZURE_CLIENT_ID'];
const SUBSCRIPTION_ID = process.env['AZURE_SUBSCRIPTION_ID'];
const FEDERATED_TOKEN_FILE = process.env['AZURE_FEDERATED_TOKEN_FILE'];

export interface AcrBuildOptions {
  /** Working directory containing the Dockerfile + build context. */
  cwd: string;
  /** Image name without registry prefix, e.g. "liliput-api". */
  imageName: string;
  /** Image tag, e.g. a commit SHA. */
  tag: string;
  /** Path to Dockerfile relative to `cwd`. Default: "Dockerfile". */
  dockerfile?: string;
  /** Optional extra tags applied to the same build. */
  extraTags?: string[];
}

export interface AcrBuildResult {
  imageRef: string;
  stdout: string;
  durationMs: number;
}

/** Sticky azCliReady flag — only run `az login` once per process. */
let azLoggedIn = false;

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
            `${cmd} ${args.slice(0, 3).join(' ')}... exited with ${code}\nstderr: ${stderr.trim()}`,
          ),
        );
    });
  });
}

async function ensureAzLogin(): Promise<void> {
  if (azLoggedIn) return;
  if (!TENANT_ID || !CLIENT_ID || !FEDERATED_TOKEN_FILE) {
    throw new Error(
      'Workload identity not configured: AZURE_TENANT_ID, AZURE_CLIENT_ID, and AZURE_FEDERATED_TOKEN_FILE must be set.',
    );
  }

  // Read federated token from the projected SA token file
  const { readFile } = await import('node:fs/promises');
  const federatedToken = (await readFile(FEDERATED_TOKEN_FILE, 'utf8')).trim();

  await run('az', [
    'login',
    '--service-principal',
    '--tenant', TENANT_ID,
    '--username', CLIENT_ID,
    '--federated-token', federatedToken,
    '--allow-no-subscriptions',
    '--output', 'none',
  ]);

  if (SUBSCRIPTION_ID) {
    await run('az', ['account', 'set', '--subscription', SUBSCRIPTION_ID, '--output', 'none']);
  }
  azLoggedIn = true;
}

/** Trigger an ACR remote build. Returns the full image reference. */
export async function acrBuild(options: AcrBuildOptions): Promise<AcrBuildResult> {
  if (!ACR_NAME) {
    throw new Error('ACR_NAME env var is not set.');
  }

  await ensureAzLogin();

  const start = Date.now();
  const args = [
    'acr', 'build',
    '--registry', ACR_NAME,
    '--image', `${options.imageName}:${options.tag}`,
  ];
  for (const extra of options.extraTags ?? []) {
    args.push('--image', `${options.imageName}:${extra}`);
  }
  if (options.dockerfile) args.push('--file', options.dockerfile);
  args.push('--output', 'none', '.');

  const { stdout } = await run('az', args, { cwd: options.cwd });
  return {
    imageRef: `${ACR_NAME}.azurecr.io/${options.imageName}:${options.tag}`,
    stdout,
    durationMs: Date.now() - start,
  };
}
