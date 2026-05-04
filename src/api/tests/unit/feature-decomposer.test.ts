import { describe, it, expect } from 'vitest';
import {
  parseDecomposition,
  buildDecompositionPrompt,
} from '../../src/engine/feature-decomposer.js';

const WS = 'ws-1';

describe('parseDecomposition', () => {
  it('parses a 2-feature + integration decomposition', () => {
    const md = `## Feature 01: User Login
slug: 01-user-login
depends-on: (none)
spec-path: specs/features/01-user-login.feature.md
description: Email/password login with sessions

## Feature 02: Search
slug: 02-search
depends-on: 01-user-login
spec-path: specs/features/02-search.feature.md
description: Authenticated full-text search

## Integration
slug: 99-integration
spec-path: specs/features/99-integration.feature.md
description: Login + search end-to-end`;
    const d = parseDecomposition(WS, md)!;
    expect(d.features).toHaveLength(2);
    expect(d.features[0]?.slug).toBe('01-user-login');
    expect(d.features[0]?.kind).toBe('feature');
    expect(d.features[0]?.dependsOn).toBeUndefined();
    expect(d.features[1]?.dependsOn).toEqual(['01-user-login']);
    expect(d.integration?.slug).toBe('99-integration');
    expect(d.integration?.kind).toBe('integration');
  });

  it('returns null on empty input', () => {
    expect(parseDecomposition(WS, '')).toBeNull();
    expect(parseDecomposition(WS, '   ')).toBeNull();
  });

  it('returns null when no Feature/Integration heading is present', () => {
    expect(parseDecomposition(WS, '# Some other doc\n\nbody')).toBeNull();
  });

  it('throws when slug is missing', () => {
    const md = `## Feature 01: Bad
description: missing slug`;
    expect(() => parseDecomposition(WS, md)).toThrow(/slug/);
  });

  it('handles "(none)" and bare "none" as no deps', () => {
    const md = `## Feature 01: A
slug: 01-a
depends-on: (none)
description: x

## Feature 02: B
slug: 02-b
depends-on: none
description: y

## Integration
slug: 99-integration
description: z`;
    const d = parseDecomposition(WS, md)!;
    expect(d.features[0]?.dependsOn).toBeUndefined();
    expect(d.features[1]?.dependsOn).toBeUndefined();
  });

  it('parses comma-separated depends-on into an array', () => {
    const md = `## Feature 01: A
slug: 01-a
description: x
## Feature 02: B
slug: 02-b
description: y
## Feature 03: C
slug: 03-c
depends-on: 01-a, 02-b
description: z
## Integration
slug: 99-integration
description: end`;
    const d = parseDecomposition(WS, md)!;
    expect(d.features[2]?.dependsOn).toEqual(['01-a', '02-b']);
  });

  it('sorts features by their NN position', () => {
    const md = `## Feature 03: C
slug: 03-c
description: c

## Feature 01: A
slug: 01-a
description: a

## Feature 02: B
slug: 02-b
description: b

## Integration
slug: 99-integration
description: i`;
    const d = parseDecomposition(WS, md)!;
    expect(d.features.map((f) => f.slug)).toEqual([
      '01-a',
      '02-b',
      '03-c',
    ]);
  });

  it('is tolerant of case in heading and field keys', () => {
    const md = `## feature 01: Lower
SLUG: 01-lower
Description: yes
## INTEGRATION
slug: 99-integration
description: ok`;
    const d = parseDecomposition(WS, md)!;
    expect(d.features[0]?.slug).toBe('01-lower');
    expect(d.integration?.slug).toBe('99-integration');
  });

  it('allows decomposition with only an integration block to be rejected as malformed (no real features)', () => {
    // Single integration block with no Feature blocks is not useful — but the
    // parser does not guard against it (caller is expected to handle).
    const md = `## Integration
slug: 99-integration
description: only`;
    const d = parseDecomposition(WS, md);
    expect(d?.features).toHaveLength(0);
    expect(d?.integration).not.toBeNull();
  });

  it('preserves workstreamId on every feature', () => {
    const md = `## Feature 01: A
slug: 01-a
description: x
## Integration
slug: 99-integration
description: y`;
    const d = parseDecomposition('my-ws', md)!;
    expect(d.features[0]?.workstreamId).toBe('my-ws');
    expect(d.integration?.workstreamId).toBe('my-ws');
  });

  it('uses spec-path when provided', () => {
    const md = `## Feature 01: A
slug: 01-a
spec-path: custom/path.feature.md
description: x
## Integration
slug: 99-integration
description: y`;
    const d = parseDecomposition(WS, md)!;
    expect(d.features[0]?.specPath).toBe('custom/path.feature.md');
  });
});

describe('buildDecompositionPrompt', () => {
  it('includes the spec body and task title', () => {
    const out = buildDecompositionPrompt({
      workstreamId: WS,
      title: 'Login feature',
      spec: '# Spec\nbody here',
    });
    expect(out).toContain('Login feature');
    expect(out).toContain('# Spec\nbody here');
    expect(out).toContain('## Integration');
  });

  it('describes the required output format', () => {
    const out = buildDecompositionPrompt({
      workstreamId: WS,
      title: 'X',
      spec: 'Y',
    });
    expect(out).toContain('## Feature 01:');
    expect(out).toContain('slug:');
    expect(out).toContain('depends-on:');
  });
});
