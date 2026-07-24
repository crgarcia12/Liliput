import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { remoteBranchSha, type RepoHandle } from '../../src/engine/git-client.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

describe('git-client', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'liliput-git-client-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('should read the pushed task branch SHA from a single-branch clone', async () => {
    // Validates: frd-autonomous-workstream-campaigns.md, AC 481.
    const remote = path.join(root, 'remote.git');
    const seed = path.join(root, 'seed');
    const workspace = path.join(root, 'workspace');
    const branch = 'liliput/task-e226889d';

    await mkdir(seed);
    await git(root, 'init', '--bare', '--quiet', remote);
    await git(seed, 'init', '--quiet');
    await git(seed, 'config', 'user.name', 'Liliput Test');
    await git(seed, 'config', 'user.email', 'liliput-test@example.com');
    await writeFile(path.join(seed, 'README.md'), '# Test\n', 'utf8');
    await git(seed, 'add', 'README.md');
    await git(seed, 'commit', '--quiet', '-m', 'Initial commit');
    await git(seed, 'branch', '-M', 'main');
    await git(seed, 'remote', 'add', 'origin', remote);
    await git(seed, 'push', '--quiet', '--set-upstream', 'origin', 'main');

    await git(
      root,
      'clone',
      '--quiet',
      '--single-branch',
      '--branch',
      'main',
      remote,
      workspace,
    );
    await git(workspace, 'config', 'user.name', 'Liliput Test');
    await git(workspace, 'config', 'user.email', 'liliput-test@example.com');
    await git(workspace, 'switch', '--quiet', '-c', branch);
    await writeFile(path.join(workspace, 'feature.txt'), 'implemented\n', 'utf8');
    await git(workspace, 'add', 'feature.txt');
    await git(workspace, 'commit', '--quiet', '-m', 'Implement feature');
    await git(workspace, 'push', '--quiet', '--set-upstream', 'origin', branch);

    const localSha = await git(workspace, 'rev-parse', 'HEAD');
    const handle: RepoHandle = { cwd: workspace, repo: 'local/test', branch };

    await expect(remoteBranchSha(handle)).resolves.toBe(localSha);
  }, 20_000);
});
