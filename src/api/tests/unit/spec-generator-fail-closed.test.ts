import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  extractRepoContext: vi.fn(),
  getCopilotClient: vi.fn(),
  resetCopilotClient: vi.fn(),
}));

vi.mock('../../src/engine/repo-context.js', () => ({
  extractRepoContext: mocks.extractRepoContext,
}));

vi.mock('../../src/engine/copilot-client.js', () => ({
  getCopilotClient: mocks.getCopilotClient,
  isSdkConnectionClosed: () => false,
  resetCopilotClient: mocks.resetCopilotClient,
}));

vi.mock('../../src/engine/force-effort.js', () => ({
  setForceEffort: vi.fn(),
}));

import { generateSpec } from '../../src/engine/spec-generator.js';

describe('generateSpec fail-closed behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should stop when the target repository cannot be grounded', async () => {
    mocks.extractRepoContext.mockResolvedValue(null);

    await expect(
      generateSpec('Modernize the app', 'Improve the existing application.', {
        repository: 'crgarcia12/modern-winamp',
        taskId: 'task-123',
      }),
    ).rejects.toMatchObject({ code: 'repository-grounding-failed' });

    expect(mocks.getCopilotClient).not.toHaveBeenCalled();
  });

  it('should not replace an LLM failure with a generic specification', async () => {
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const sendAndWait = vi.fn().mockRejectedValue(new Error('model unavailable'));
    const createSession = vi.fn().mockResolvedValue({
      sendAndWait,
      disconnect,
      setModel: vi.fn().mockResolvedValue(undefined),
    });
    mocks.getCopilotClient.mockResolvedValue({ createSession });

    await expect(
      generateSpec('Build the app', 'Deliver the requested application.'),
    ).rejects.toMatchObject({
      code: 'model-generation-failed',
      message: expect.stringContaining('model unavailable'),
    });

    expect(disconnect).toHaveBeenCalledOnce();
  });
});
