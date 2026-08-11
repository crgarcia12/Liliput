import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the SDK client + force-effort so the bounded stages run without a real
// Copilot connection. Individual tests override getCopilotClient's behavior.
const getCopilotClient = vi.fn();
vi.mock('../../src/engine/copilot-client.js', () => ({
  getCopilotClient: (...args: unknown[]) => getCopilotClient(...args),
  isSdkConnectionClosed: () => false,
  resetCopilotClient: () => Promise.resolve(),
}));
vi.mock('../../src/engine/force-effort.js', () => ({
  setForceEffort: () => {},
}));

import {
  rewriteRequest,
  researchRequest,
  generatePlan,
  composePlanningContext,
} from '../../src/engine/pipeline-stages.js';
import { buildReviewPrompt } from '../../src/engine/reviewer-loop.js';

/** Build a fake SDK client whose sendAndWait resolves the given content. */
function fakeClientReturning(content: string) {
  return {
    createSession: vi.fn().mockResolvedValue({
      sendAndWait: vi.fn().mockResolvedValue({ data: { content } }),
      disconnect: vi.fn().mockResolvedValue(undefined),
    }),
  };
}

beforeEach(() => {
  getCopilotClient.mockReset();
});

describe('rewriteRequest', () => {
  it('returns the rewritten text when the SDK replies', async () => {
    getCopilotClient.mockResolvedValue(fakeClientReturning('Add a dark-mode toggle to the settings page.'));
    const r = await rewriteRequest('Dark mode', 'pls make it dark', {});
    expect(r.ran).toBe(true);
    expect(r.rewritten).toContain('dark-mode toggle');
  });

  it('falls back to the original request when the SDK throws', async () => {
    getCopilotClient.mockRejectedValue(new Error('connection refused'));
    const r = await rewriteRequest('Dark mode', 'pls make it dark', {});
    expect(r.ran).toBe(false);
    expect(r.rewritten).toBe('pls make it dark');
  });

  it('treats an empty request as a no-op', async () => {
    const r = await rewriteRequest('Empty', '   ', {});
    expect(r.ran).toBe(false);
    expect(getCopilotClient).not.toHaveBeenCalled();
  });
});

describe('generatePlan', () => {
  it('returns plan markdown when the SDK replies', async () => {
    getCopilotClient.mockResolvedValue(fakeClientReturning('## Plan\n1. Edit settings\n2. Add toggle'));
    const r = await generatePlan('Dark mode', 'add dark mode', { repository: 'o/r' });
    expect(r.ran).toBe(true);
    expect(r.plan).toContain('## Plan');
  });

  it('returns null plan when the SDK is unavailable', async () => {
    getCopilotClient.mockRejectedValue(new Error('no client'));
    const r = await generatePlan('Dark mode', 'add dark mode', {});
    expect(r.ran).toBe(false);
    expect(r.plan).toBeNull();
  });
});

describe('researchRequest', () => {
  it('returns a bounded brief and labels it unverified when no search tool runs', async () => {
    const client = fakeClientReturning(
      '## Expected Product Baseline\nResponsive UI.\n\n## Verified Technical Guidance\nUse current framework docs.\n\n## Risks and Pitfalls\nNone.\n\n## Assumptions and Unknowns\nStorage is local.',
    );
    getCopilotClient.mockResolvedValue(client);

    const r = await researchRequest('Language app', 'Build a language app', {
      repository: 'o/r',
    });

    expect(r.ran).toBe(true);
    expect(r.grounded).toBe(false);
    expect(r.brief).toContain('External research was unavailable');
    expect(r.brief).toContain('Expected Product Baseline');
    expect(client.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        enableConfigDiscovery: false,
        availableTools: ['web_search'],
        onPermissionRequest: expect.any(Function),
      }),
    );
  });
});

describe('composePlanningContext', () => {
  it('returns empty string when nothing is provided', () => {
    expect(composePlanningContext({})).toBe('');
  });

  it('includes the rewritten request, research, plan, and critique sections', () => {
    const ctx = composePlanningContext({
      rewritten: 'Add a dark-mode toggle.',
      research: 'Follow WCAG contrast guidance.',
      plan: '## Plan\n1. Edit settings',
      critique: '- Watch out for SSR hydration mismatch',
    });
    expect(ctx).toContain('Pre-implementation planning');
    expect(ctx).toContain('Rewritten request');
    expect(ctx).toContain('Add a dark-mode toggle.');
    expect(ctx).toContain('Research grounding');
    expect(ctx).toContain('WCAG');
    expect(ctx).toContain('untrusted reference data');
    expect(ctx).toContain('Implementation plan');
    expect(ctx).toContain('Plan critique');
    expect(ctx).toContain('hydration mismatch');
  });

  it('omits sections that are empty or null', () => {
    const ctx = composePlanningContext({ plan: '## Plan\n1. do it', critique: null });
    expect(ctx).toContain('Implementation plan');
    expect(ctx).not.toContain('Plan critique');
    expect(ctx).not.toContain('Rewritten request');
  });
});

describe('buildReviewPrompt (plan kind)', () => {
  it('builds a plan-critique prompt including the plan body', () => {
    const p = buildReviewPrompt({
      kind: 'plan',
      repository: 'owner/repo',
      taskTitle: 'Add login',
      taskDescription: 'Users should be able to log in.',
      plan: '## Plan\n1. Add auth route\n2. Hash passwords',
    });
    expect(p).toContain('implementation plan');
    expect(p).toContain('Add auth route');
    expect(p).toContain('owner/repo');
    expect(p).toMatch(/NO-FEEDBACK/);
    expect(p).toMatch(/FEEDBACK/);
  });
});
