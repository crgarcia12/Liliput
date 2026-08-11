/**
 * Greenfield project bootstrap orchestrator.
 *
 * Given a name + description + visibility, this:
 *   1. Validates the input.
 *   2. Creates a brand-new GitHub repo under the authenticated user.
 *   3. Clones it into the agent workspace.
 *   4. Runs `npx --yes spec2cloud init --ref vNext` against the clone.
 *   5. Commits + pushes the spec2cloud scaffolding back to the new repo.
 *      (The Liliput deploy contract is intentionally NOT committed —
 *       `writeContractIntoWorkspace` adds it to `.git/info/exclude`.)
 *   6. Drops `LILIPUT_DEPLOY_CONTRACT.md` into the workspace so the agent
 *      sees it on the very first turn.
 *   7. Creates a normal Liliput task wired to the new repo, with the
 *      operator's description as the first user chat message.
 *
 * Failures after step 2 (repo created) do NOT delete the GitHub repo. The
 * task is created with a system message describing what failed, so the
 * operator can retry or clean up manually on GitHub.
 */

import { spawn } from 'node:child_process';
import {
  createRepoForAuthenticatedUser,
  getAuthenticatedUserLogin,
  repoExists,
  RepoCreateError,
  validateRepoName,
  type CreatedRepo,
} from './github-repo-service.js';
import * as git from '../engine/git-client.js';
import { pathPrefixFor, writeContractIntoWorkspace } from '../engine/liliput-deploy-contract.js';
import * as taskStore from '../stores/task-store.js';
import * as workstreamStore from '../stores/workstream-store.js';
import type { Task } from '../../../shared/types/index.js';
import { logger } from '../logger.js';

export interface BootstrapInput {
  name: string;
  description: string;
  visibility: 'public' | 'private';
  /** Optional default branch name for the new repo (defaults to GitHub's `main`). */
  initialBranch?: string;
  /** Optional model id for the resulting task — passes through to taskStore. */
  model?: string;
  /** Optional reasoning-effort hint for the resulting task. Auto-derived from model id when missing. */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  /** Pause for human specification approval instead of building automatically. */
  requireSpecApproval?: boolean;
}

export interface BootstrapResult {
  task: Task;
  repository: {
    owner: string;
    name: string;
    fullName: string;
    htmlUrl: string;
    visibility: 'public' | 'private';
    defaultBranch: string;
  };
  /** True when one or more post-create steps failed but we still produced
   *  a task with a system message describing the failure. */
  partial: boolean;
  warnings: string[];
}

export interface BootstrapDeps {
  taskStore: Pick<typeof taskStore, 'createTask' | 'addChatMessage' | 'getTask'>;
  workstreamStore: Pick<typeof workstreamStore, 'ensureDefaultWorkstream'>;
  /** Override `npx ...` execution. Used in tests. */
  runSpec2cloudInit?: (cwd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** Override repo creation. Used in tests to avoid hitting GitHub. */
  createRepo?: typeof createRepoForAuthenticatedUser;
  /** Override existence check. Used in tests. */
  exists?: typeof repoExists;
  /** Override owner lookup. Used in tests. */
  whoami?: typeof getAuthenticatedUserLogin;
  /** Override the git-client surface. Used in tests. */
  gitClient?: Pick<typeof git, 'clone' | 'commitAll' | 'push'>;
  /** Override contract writer. Used in tests. */
  writeContract?: typeof writeContractIntoWorkspace;
}

const SPEC2CLOUD_REF = 'vNext';

export class ProjectBootstrapError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'ProjectBootstrapError';
  }
}

/** Run `npx --yes spec2cloud init --ref vNext` in the cloned workspace. */
function defaultRunSpec2cloudInit(cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn('npx', ['--yes', 'spec2cloud', 'init', '--ref', SPEC2CLOUD_REF], {
      cwd,
      env: process.env,
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      logger.info({ cwd, stream: 'stdout' }, `[spec2cloud] ${text.trimEnd()}`);
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr += text;
      logger.warn({ cwd, stream: 'stderr' }, `[spec2cloud] ${text.trimEnd()}`);
    });
    proc.on('error', (err) => {
      stderr += `\nspawn error: ${err.message}`;
      resolve({ exitCode: -1, stdout, stderr });
    });
    proc.on('close', (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });
}

export async function bootstrapProject(
  input: BootstrapInput,
  deps: BootstrapDeps,
): Promise<BootstrapResult> {
  // Step 0: input validation. These errors should be surfaced at the route
  // layer with HTTP 400 and never produce a side-effect.
  const nameCheck = validateRepoName(input.name);
  if (!nameCheck.ok) {
    throw new ProjectBootstrapError(nameCheck.reason, 400, 'name');
  }
  if (!input.description || !input.description.trim()) {
    throw new ProjectBootstrapError('description is required', 400, 'description');
  }
  if (input.visibility !== 'public' && input.visibility !== 'private') {
    throw new ProjectBootstrapError('visibility must be "public" or "private"', 400, 'visibility');
  }
  const initialBranch = input.initialBranch?.trim() || 'main';
  if (!/^[A-Za-z0-9._\-/]+$/.test(initialBranch)) {
    throw new ProjectBootstrapError('initialBranch contains invalid characters', 400, 'initialBranch');
  }

  const whoami = deps.whoami ?? getAuthenticatedUserLogin;
  const exists = deps.exists ?? repoExists;
  const createRepo = deps.createRepo ?? createRepoForAuthenticatedUser;
  const runInit = deps.runSpec2cloudInit ?? defaultRunSpec2cloudInit;
  const gitClient = deps.gitClient ?? {
    clone: git.clone,
    commitAll: git.commitAll,
    push: git.push,
  };
  const writeContract = deps.writeContract ?? writeContractIntoWorkspace;

  // Step 1: pre-flight existence check (fail fast with 409 before mutating state).
  const owner = await whoami();
  if (await exists(owner, input.name)) {
    throw new ProjectBootstrapError(
      `A repository named "${input.name}" already exists under ${owner}.`,
      409,
      'name',
    );
  }

  // Step 2: create the GitHub repo.
  let created: CreatedRepo;
  try {
    created = await createRepo({
      name: input.name,
      description: input.description.split('\n', 1)[0]?.slice(0, 350) ?? input.name,
      visibility: input.visibility,
      defaultBranch: initialBranch,
    });
  } catch (err) {
    if (err instanceof RepoCreateError) {
      const status = err.code === 'name-taken' ? 409 : err.status;
      throw new ProjectBootstrapError(err.message, status, 'name');
    }
    throw err;
  }

  // From here on, the repo EXISTS on GitHub. We never delete it on failure;
  // we accumulate warnings and surface them as task system messages.
  const warnings: string[] = [];
  let partial = false;

  // Step 3: clone the brand-new repo.
  let handle: git.RepoHandle | undefined;
  try {
    handle = await gitClient.clone({
      repo: created.fullName,
      ref: created.defaultBranch,
      depth: 1,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ repo: created.fullName, err: msg }, 'Failed to clone freshly created repo');
    warnings.push(`Cloned the new repo failed: ${msg}. spec2cloud was NOT installed; do it manually with \`npx spec2cloud init --ref vNext\` after \`git clone ${created.htmlUrl}\`.`);
    partial = true;
  }

  // Step 4: spec2cloud init.
  if (handle) {
    try {
      const initResult = await runInit(handle.cwd);
      if (initResult.exitCode !== 0) {
        warnings.push(
          `\`npx spec2cloud init --ref ${SPEC2CLOUD_REF}\` exited with code ${initResult.exitCode}. ` +
          `Stderr (last 500 chars): ${initResult.stderr.slice(-500) || '(empty)'}`,
        );
        partial = true;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`spec2cloud init crashed: ${msg}`);
      partial = true;
    }

    // Step 5: commit + push whatever spec2cloud produced. If init succeeded
    // but produced nothing (very unusual), commitAll throws 'No changes to
    // commit' — treat that as a non-fatal warning rather than a failure.
    try {
      await gitClient.commitAll(handle, 'chore: spec2cloud init (automated by Liliput)');
      await gitClient.push(handle);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/no changes to commit/i.test(msg)) {
        warnings.push('spec2cloud init produced no committable changes — the repo was left as auto_init created it.');
      } else {
        warnings.push(`Pushing spec2cloud scaffolding failed: ${msg}`);
        partial = true;
      }
    }

    // Step 6: drop the Liliput deploy contract into the workspace (NOT
    // committed — `writeContractIntoWorkspace` adds it to .git/info/exclude).
    try {
      const prefix = pathPrefixFor(created.fullName, created.defaultBranch);
      const ingressHost = process.env['LILIPUT_INGRESS_HOST'] ?? 'liliput.crgarcia.com.ar';
      await writeContract(handle.cwd, {
        pathPrefix: prefix,
        port: 8080,
        devUrl: `http://${ingressHost}${prefix}/`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Failed to write LILIPUT_DEPLOY_CONTRACT.md: ${msg}`);
      partial = true;
    }
  }

  // Step 7: create the Liliput task and seed the description as the first
  // user chat message. From here the standard agent loop takes over.
  const workstream = deps.workstreamStore.ensureDefaultWorkstream(created.fullName);
  const task = deps.taskStore.createTask(input.name, input.description.trim(), created.fullName, {
    baseBranch: created.defaultBranch,
    workstreamId: workstream.id,
    ...(input.model ? { model: input.model } : {}),
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.requireSpecApproval !== undefined
      ? { requireSpecApproval: input.requireSpecApproval }
      : {}),
  });

  deps.taskStore.addChatMessage(
    task.id,
    'system',
    `🆕 Project created: ${created.htmlUrl} (${created.visibility}, default branch \`${created.defaultBranch}\`).`,
  );
  if (warnings.length > 0) {
    deps.taskStore.addChatMessage(
      task.id,
      'system',
      `⚠️ Bootstrap completed with ${warnings.length} warning(s):\n- ${warnings.join('\n- ')}`,
    );
  }
  // Note: we deliberately do NOT pre-seed the operator's description as a
  // `gulliver` chat message here. The spec generator only kicks off via the
  // `POST /api/tasks/:id/chat` route (it transitions clarifying -> specifying
  // and starts the LLM run). The frontend is responsible for calling that
  // endpoint with `input.description` immediately after this returns, which
  // mirrors the existing-repo flow.

  const persisted = deps.taskStore.getTask(task.id) ?? task;

  logger.info(
    { taskId: persisted.id, repo: created.fullName, partial, warnings: warnings.length },
    'Project bootstrap complete',
  );

  return {
    task: persisted,
    repository: {
      owner: created.owner,
      name: created.name,
      fullName: created.fullName,
      htmlUrl: created.htmlUrl,
      visibility: created.visibility,
      defaultBranch: created.defaultBranch,
    },
    partial,
    warnings,
  };
}
