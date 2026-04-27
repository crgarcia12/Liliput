/**
 * Agent test endpoints — exercise the full clone → edit → commit → push → PR
 * → ACR build cycle. Useful for verifying the agent infrastructure works
 * end-to-end without writing real agent logic yet.
 *
 * Disabled in production unless ENABLE_AGENT_DRY_RUN=true.
 */

import { Router, type Request, type Response } from 'express';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as git from '../engine/git-client.js';
import { openPullRequest } from '../engine/github-pr.js';
import { acrBuild } from '../engine/azure-builder.js';

const ENABLED = process.env['ENABLE_AGENT_DRY_RUN'] !== 'false';

interface DryRunBody {
  repo?: string;
  base?: string;
  /** Skip the ACR build step. Default: true (build can take 2-5 min). */
  skipBuild?: boolean;
  /** If skipBuild=false, build this image name from the cloned repo. */
  imageName?: string;
  /** Dockerfile path inside the repo. */
  dockerfile?: string;
}

interface StepResult {
  step: string;
  ok: boolean;
  durationMs: number;
  detail?: unknown;
  error?: string;
}

export function createAgentRouter(): Router {
  const router = Router();

  if (!ENABLED) {
    router.use((_req: Request, res: Response) => {
      res
        .status(404)
        .json({ error: 'Agent test endpoints disabled (ENABLE_AGENT_DRY_RUN=false).' });
    });
    return router;
  }

  router.post('/dry-run', async (req: Request, res: Response): Promise<void> => {
    const body: DryRunBody = req.body ?? {};
    const repo = body.repo ?? 'crgarcia12/Liliput';
    const base = body.base ?? 'main';
    const skipBuild = body.skipBuild ?? true;
    const branch = `liliput-agent/dry-run-${Date.now().toString(36)}`;
    const steps: StepResult[] = [];
    let handle: git.RepoHandle | undefined;

    const time = async <T>(
      step: string,
      fn: () => Promise<T>,
    ): Promise<T | undefined> => {
      const start = Date.now();
      try {
        const result = await fn();
        steps.push({ step, ok: true, durationMs: Date.now() - start });
        return result;
      } catch (err) {
        steps.push({
          step,
          ok: false,
          durationMs: Date.now() - start,
          error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      }
    };

    handle = await time('clone', () => git.clone({ repo, ref: base }));
    if (!handle) {
      res.status(500).json({ ok: false, branch, steps });
      return;
    }

    const cloned = handle;

    await time('createBranch', () => git.createBranch(cloned, branch));

    const stampedFile = path.join(cloned.cwd, '.liliput-agent-dry-run.txt');
    await time('writeFile', async () => {
      await writeFile(
        stampedFile,
        `Liliput agent dry-run at ${new Date().toISOString()}\n`,
        'utf8',
      );
    });

    const sha = await time('commit', () =>
      git.commitAll(cloned, `chore(agent): dry-run ${branch}`),
    );

    await time('push', () => git.push(cloned));

    const pr = await time('openPullRequest', () =>
      openPullRequest({
        repo,
        title: `[agent dry-run] ${branch}`,
        body:
          'Automated dry-run from the Liliput agent infrastructure. Verifies clone → edit → commit → push → PR.\n\n' +
          'Safe to close — this only adds a single timestamped file.',
        head: branch,
        base,
        draft: true,
      }),
    );

    let buildResult;
    if (!skipBuild && body.imageName) {
      buildResult = await time('acrBuild', () =>
        acrBuild({
          cwd: cloned.cwd,
          imageName: body.imageName!,
          tag: (sha ?? 'dryrun').substring(0, 12),
          dockerfile: body.dockerfile,
        }),
      );
    }

    await time('cleanup', () => git.cleanup(cloned));

    const ok = steps.every((s) => s.ok);
    res.status(ok ? 200 : 500).json({
      ok,
      repo,
      branch,
      commitSha: sha,
      pullRequest: pr
        ? { number: pr.number, url: pr.htmlUrl, state: pr.state }
        : undefined,
      build: buildResult
        ? { imageRef: buildResult.imageRef, durationMs: buildResult.durationMs }
        : undefined,
      steps,
    });
  });

  return router;
}
