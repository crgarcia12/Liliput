import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { installCucumberIfMissing } from '../../src/engine/cucumber-installer.js';

async function mkTmp(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('cucumber-installer', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkTmp('cuc-installer-');
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('skips when no package.json exists', async () => {
    const r = await installCucumberIfMissing(tmp);
    expect(r.installed).toBe(false);
    expect(r.skippedReason).toBe('no-package-json');
  });

  it('skips when @cucumber/cucumber already in devDependencies', async () => {
    await fs.writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        name: 'x',
        devDependencies: { '@cucumber/cucumber': '^10.0.0' },
      }),
      'utf8',
    );
    const r = await installCucumberIfMissing(tmp);
    expect(r.installed).toBe(false);
    expect(r.skippedReason).toBe('already-in-package-json');
  });

  it('skips when @cucumber/cucumber already in dependencies', async () => {
    await fs.writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        name: 'x',
        dependencies: { '@cucumber/cucumber': '10.0.0' },
      }),
      'utf8',
    );
    const r = await installCucumberIfMissing(tmp);
    expect(r.installed).toBe(false);
    expect(r.skippedReason).toBe('already-in-package-json');
  });

  it('skips when cucumber-js binary already in node_modules/.bin', async () => {
    await fs.writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'x' }),
      'utf8',
    );
    await fs.mkdir(path.join(tmp, 'node_modules', '.bin'), { recursive: true });
    const binName =
      process.platform === 'win32' ? 'cucumber-js.cmd' : 'cucumber-js';
    await fs.writeFile(path.join(tmp, 'node_modules', '.bin', binName), '', 'utf8');
    const r = await installCucumberIfMissing(tmp);
    expect(r.installed).toBe(false);
    expect(r.skippedReason).toBe('already-in-node-modules');
  });

  it('treats malformed package.json as no-package-json (no install attempt)', async () => {
    await fs.writeFile(path.join(tmp, 'package.json'), '{ not json', 'utf8');
    const r = await installCucumberIfMissing(tmp);
    expect(r.installed).toBe(false);
    expect(r.skippedReason).toBe('no-package-json');
  });
});
