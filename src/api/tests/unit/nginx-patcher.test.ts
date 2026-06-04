import { describe, it, expect } from 'vitest';
import {
  renderRoutesBlock,
  injectRoutesBlock,
  type DevRoute,
} from '../../src/engine/nginx-patcher.js';

const route: DevRoute = {
  pathPrefix: '/dev/owner/repo/branch',
  upstreamHost: 'app.dev-owner-repo-branch.svc.cluster.local',
  upstreamPort: 80,
};

describe('renderRoutesBlock', () => {
  it('should emit empty marker block when there are no routes', () => {
    const out = renderRoutesBlock([]);
    expect(out).toContain('# === LILIPUT-DEV-ENVS-BEGIN ===');
    expect(out).toContain('# === LILIPUT-DEV-ENVS-END ===');
    expect(out).not.toContain('location');
  });

  it('should resolve the upstream via a variable so DNS is deferred to request time', () => {
    const out = renderRoutesBlock([route]);
    // A `set $upstream <host>;` + variable proxy_pass keeps nginx booting even
    // when the upstream namespace is gone (per-route 502 instead of a crash).
    expect(out).toContain('set $upstream app.dev-owner-repo-branch.svc.cluster.local;');
    expect(out).toContain('proxy_pass http://$upstream:80;');
    // Must NOT use a static hostname in proxy_pass (that resolves at boot).
    expect(out).not.toContain('proxy_pass http://app.dev-owner-repo-branch');
  });

  it('should not append a URI or $request_uri to the variable proxy_pass', () => {
    const out = renderRoutesBlock([route]);
    // The rewrite already strips the prefix; a trailing path or $request_uri
    // would corrupt the forwarded URI.
    expect(out).not.toContain('$upstream:80/');
    expect(out).not.toContain('$request_uri');
  });

  it('should keep the prefix-stripping rewrites and forwarding headers', () => {
    const out = renderRoutesBlock([route]);
    expect(out).toContain('rewrite ^/dev/owner/repo/branch/(.*)$ /$1 break;');
    expect(out).toContain('rewrite ^/dev/owner/repo/branch$ / break;');
    expect(out).toContain('proxy_set_header X-Forwarded-Prefix /dev/owner/repo/branch;');
    expect(out).toContain('proxy_set_header Upgrade $http_upgrade;');
  });
});

describe('injectRoutesBlock', () => {
  it('should replace an existing marker block in place', () => {
    const base =
      'http {\n  # === LILIPUT-DEV-ENVS-BEGIN ===\n  old\n  # === LILIPUT-DEV-ENVS-END ===\n}';
    const block = renderRoutesBlock([route]);
    const out = injectRoutesBlock(base, block);
    expect(out).not.toContain('old');
    expect(out).toContain('proxy_pass http://$upstream:80;');
    // Exactly one managed block remains.
    expect(out.match(/LILIPUT-DEV-ENVS-BEGIN/g)?.length).toBe(1);
  });
});
