import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  commitAll,
  remoteBranchSha,
  repositorySlugFromRemoteUrl,
  unsafeGeneratedArtifactPaths,
  type RepoHandle,
} from '../../src/engine/git-client.js';

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

  it('should normalize authenticated and SSH GitHub remotes', () => {
    expect(
      repositorySlugFromRemoteUrl(
        'https://x-access-token:secret@github.com/crgarcia12/Liliput.git',
      ),
    ).toBe('crgarcia12/Liliput');
    expect(
      repositorySlugFromRemoteUrl('git@github.com:crgarcia12/Liliput.git'),
    ).toBe('crgarcia12/Liliput');
  });

  it('should identify generated dependencies and environment files', () => {
    expect(
      unsafeGeneratedArtifactPaths([
        'src/index.ts',
        'node_modules/pkg/index.js',
        '.env.production',
        '.env.example',
        'coverage/coverage.json',
        '.next/cache/webpack/client.pack',
        'dist/index.js',
        'packages/api/build/server.js',
      ]),
    ).toEqual([
      'node_modules/pkg/index.js',
      '.env.production',
      'coverage/coverage.json',
      '.next/cache/webpack/client.pack',
      'dist/index.js',
      'packages/api/build/server.js',
    ]);
  });

  it('should allow explicitly versioned build output prefixes', () => {
    expect(
      unsafeGeneratedArtifactPaths(
        ['dist/index.js', 'packages/api/build/server.js', '.next/cache/data.bin'],
        ['dist', 'packages/api/build'],
      ),
    ).toEqual(['.next/cache/data.bin']);
    expect(
      unsafeGeneratedArtifactPaths(
        ['packages/api/build/server.js'],
        ['packages'],
      ),
    ).toEqual(['packages/api/build/server.js']);
  });

  it('should refuse a commit that stages generated dependencies', async () => {
    const workspace = path.join(root, 'guarded-workspace');
    const branch = 'liliput/task-guard';
    await mkdir(workspace);
    await git(workspace, 'init', '--quiet');
    await git(workspace, 'config', 'user.name', 'Liliput Test');
    await git(workspace, 'config', 'user.email', 'liliput-test@example.com');
    await writeFile(path.join(workspace, 'README.md'), '# Test\n', 'utf8');
    await git(workspace, 'add', 'README.md');
    await git(workspace, 'commit', '--quiet', '-m', 'Initial commit');
    await git(workspace, 'branch', '-M', 'main');
    await git(
      workspace,
      'remote',
      'add',
      'origin',
      'https://github.com/local/test.git',
    );
    await git(workspace, 'switch', '--quiet', '-c', branch);
    await mkdir(path.join(workspace, 'node_modules', 'pkg'), {
      recursive: true,
    });
    await writeFile(
      path.join(workspace, 'node_modules', 'pkg', 'index.js'),
      'module.exports = {};\n',
      'utf8',
    );
    await writeFile(path.join(workspace, 'feature.ts'), 'export {};\n', 'utf8');

    const handle: RepoHandle = { cwd: workspace, repo: 'local/test', branch };
    await expect(commitAll(handle, 'Implement feature')).rejects.toThrow(
      'Refusing to commit generated',
    );
    expect(await git(workspace, 'log', '-1', '--format=%s')).toBe(
      'Initial commit',
    );
  });

  it('should allow build output from a committed repository allowlist', async () => {
    const workspace = path.join(root, 'allowlisted-workspace');
    const branch = 'liliput/task-build-output';
    await mkdir(workspace);
    await git(workspace, 'init', '--quiet');
    await git(workspace, 'config', 'user.name', 'Liliput Test');
    await git(workspace, 'config', 'user.email', 'liliput-test@example.com');
    await writeFile(path.join(workspace, 'README.md'), '# Test\n', 'utf8');
    await writeFile(
      path.join(workspace, '.liliput-generated-artifacts.allow'),
      'dist/\n',
      'utf8',
    );
    await git(workspace, 'add', 'README.md', '.liliput-generated-artifacts.allow');
    await git(workspace, 'commit', '--quiet', '-m', 'Initial commit');
    await git(workspace, 'branch', '-M', 'main');
    await git(
      workspace,
      'remote',
      'add',
      'origin',
      'https://github.com/local/test.git',
    );
    await git(workspace, 'switch', '--quiet', '-c', branch);
    await mkdir(path.join(workspace, 'dist'));
    await writeFile(path.join(workspace, 'dist', 'index.js'), 'export {};\n', 'utf8');

    const handle: RepoHandle = { cwd: workspace, repo: 'local/test', branch };
    await expect(commitAll(handle, 'Update versioned output')).resolves.toBeDefined();
  });
});
