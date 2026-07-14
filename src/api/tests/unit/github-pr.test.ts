import { describe, expect, it } from 'vitest';
import { buildPullRequestDescription } from '../../src/engine/github-pr.js';

describe('buildPullRequestDescription', () => {
  it('should describe completed work without exposing the original user prompt', () => {
    const originalPrompt =
      'Add a private billing dashboard and use the customer details from my request.';

    const body = buildPullRequestDescription({
      implementationNotes: [
        `Implemented the billing dashboard with account totals. ${originalPrompt}`,
      ],
      changedFiles: [
        'src/web/app/billing/page.tsx',
        'src/api/src/routes/billing.ts',
      ],
      commitSha: '1234567890abcdef',
      previewUrl: 'https://preview.example.test/task/',
      originalPrompt,
    });

    expect(body).not.toContain(originalPrompt);
    expect(body).toContain('Implemented the billing dashboard with account totals.');
    expect(body).toContain('`src/web/app/billing/page.tsx`');
    expect(body).toContain('`src/api/src/routes/billing.ts`');
    expect(body).toContain('`1234567`');
    expect(body).toContain('https://preview.example.test/task/');
  });

  it('should report each implementation round and remove agent-only evidence metadata', () => {
    const body = buildPullRequestDescription({
      implementationNotes: [
        'Added route validation.\n\n```evidence\n$ npm test\n12 passed\n```\nVERDICT: done — shipped',
        'Added error-state UI and retry behavior.',
      ],
      changedFiles: ['src/api/src/routes/tasks.ts', 'src/api/src/routes/tasks.ts'],
    });

    expect(body).toContain('### Initial implementation');
    expect(body).toContain('### Follow-up 1');
    expect(body).toContain('Added route validation.');
    expect(body).toContain('Added error-state UI and retry behavior.');
    expect(body).not.toContain('```evidence');
    expect(body).not.toContain('VERDICT:');
    expect(body.match(/`src\/api\/src\/routes\/tasks\.ts`/g)).toHaveLength(1);
  });
});
