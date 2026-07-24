import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveDockerfile } from '../../src/engine/dockerfile-detector.js';

describe('dockerfile-detector', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'liliput-dockerfile-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('should preserve Dockerfile.liliput when the repository already provides one', async () => {
    // Validates: frd-autonomous-workstream-campaigns.md, AC 481 and release gate 362.
    const dockerfile = [
      'FROM mcr.microsoft.com/azurelinux/base/nodejs:20',
      'WORKDIR /app',
      'COPY liliput-server.mjs ./',
      'EXPOSE 80',
      'CMD ["node", "/app/liliput-server.mjs"]',
      '',
    ].join('\n');
    await writeFile(
      path.join(workspace, 'package.json'),
      JSON.stringify({ name: 'existing-preview' }),
      'utf8',
    );
    await writeFile(
      path.join(workspace, 'Dockerfile.liliput'),
      dockerfile,
      'utf8',
    );

    const result = await resolveDockerfile(workspace);

    expect(result).toMatchObject({
      dockerfile: 'Dockerfile.liliput',
      port: 80,
      generated: false,
    });
    await expect(
      readFile(path.join(workspace, 'Dockerfile.liliput'), 'utf8'),
    ).resolves.toBe(dockerfile);
  });
});
