import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Copilot client so tests don't need a real auth token.
vi.mock('../../src/engine/copilot-client.js', () => ({
  getCopilotClient: vi.fn(),
  isSdkConnectionClosed: vi.fn(() => false),
  resetCopilotClient: vi.fn(async () => undefined),
}));

import { runFeatureDecomposer } from '../../src/engine/feature-decomposer-runner.js';
import { getCopilotClient } from '../../src/engine/copilot-client.js';

const mockedGetClient = vi.mocked(getCopilotClient);

beforeEach(() => {
  vi.clearAllMocks();
});

function makeSession(content: string | null) {
  return {
    sendAndWait: vi.fn().mockResolvedValue(
      content === null ? { data: { content: '' } } : { data: { content } },
    ),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

function makeClient(content: string | null) {
  return {
    createSession: vi.fn().mockResolvedValue(makeSession(content)),
  } as unknown as Awaited<ReturnType<typeof getCopilotClient>>;
}

describe('runFeatureDecomposer', () => {
  it('returns null when SDK throws', async () => {
    mockedGetClient.mockRejectedValueOnce(new Error('no auth'));
    const r = await runFeatureDecomposer({
      workstreamId: 'w1',
      title: 'T',
      spec: 'spec body',
    });
    expect(r).toBeNull();
  });

  it('returns null on empty response', async () => {
    mockedGetClient.mockResolvedValueOnce(makeClient(null));
    const r = await runFeatureDecomposer({
      workstreamId: 'w1',
      title: 'T',
      spec: 'spec body',
    });
    expect(r).toBeNull();
  });

  it('returns null on response with no headings', async () => {
    mockedGetClient.mockResolvedValueOnce(
      makeClient('I am a noisy LLM with no markdown structure'),
    );
    const r = await runFeatureDecomposer({
      workstreamId: 'w1',
      title: 'T',
      spec: 'spec body',
    });
    expect(r).toBeNull();
  });

  it('returns null on parse error (missing slug)', async () => {
    const broken = `## Feature 01: Login
description: missing-slug
`;
    mockedGetClient.mockResolvedValueOnce(makeClient(broken));
    const r = await runFeatureDecomposer({
      workstreamId: 'w1',
      title: 'T',
      spec: 'spec body',
    });
    expect(r).toBeNull();
  });

  it('parses well-formed response into Decomposition', async () => {
    const valid = `## Feature 01: Login
slug: 01-login
depends-on: (none)
spec-path: specs/features/01-login.feature.md
description: User can sign in

## Feature 02: Search
slug: 02-search
depends-on: 01-login
spec-path: specs/features/02-search.feature.md
description: User can search

## Integration
slug: 99-integration
spec-path: specs/features/99-integration.feature.md
description: end to end
`;
    mockedGetClient.mockResolvedValueOnce(makeClient(valid));
    const r = await runFeatureDecomposer({
      workstreamId: 'w1',
      title: 'T',
      spec: 'spec body',
    });
    expect(r).not.toBeNull();
    expect(r!.features).toHaveLength(2);
    expect(r!.features[0]?.slug).toBe('01-login');
    expect(r!.features[1]?.dependsOn).toEqual(['01-login']);
    expect(r!.integration?.slug).toBe('99-integration');
  });

  it('disconnects the session even when parsing fails', async () => {
    const session = makeSession('garbage');
    const client = {
      createSession: vi.fn().mockResolvedValue(session),
    };
    mockedGetClient.mockResolvedValueOnce(
      client as unknown as Awaited<ReturnType<typeof getCopilotClient>>,
    );
    await runFeatureDecomposer({
      workstreamId: 'w1',
      title: 'T',
      spec: 'spec body',
    });
    expect(session.disconnect).toHaveBeenCalledOnce();
  });
});
