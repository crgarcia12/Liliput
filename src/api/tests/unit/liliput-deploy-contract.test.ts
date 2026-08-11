import { describe, expect, it } from 'vitest';
import { buildDeployContract } from '../../src/engine/liliput-deploy-contract.js';

describe('liliput-deploy-contract', () => {
  it('should describe the base-path environment injected into preview pods', () => {
    const contract = buildDeployContract({
      pathPrefix: '/dev/example/app/liliput-task',
      port: 3000,
    });

    expect(contract).toContain(
      '`BASE_PATH` — the public browser prefix (= `/dev/example/app/liliput-task`)',
    );
    expect(contract).toContain(
      '`NEXT_PUBLIC_BASE_PATH` — the same public prefix (= `/dev/example/app/liliput-task`)',
    );
    expect(contract).not.toContain('`BASE_PATH` is **NOT** set by Liliput');
  });

  it('should require a project-compatible Node runtime instead of forcing Node 20', () => {
    const contract = buildDeployContract({
      pathPrefix: '/dev/example/app/liliput-task',
    });

    expect(contract).toContain("satisfies the app's `engines.node`");
    expect(contract).toContain('requires Node 22 or 24');
    expect(contract).not.toContain(
      'Default to `mcr.microsoft.com/azurelinux/base/nodejs:20`',
    );
  });
});
