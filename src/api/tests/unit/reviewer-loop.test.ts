import { describe, it, expect } from 'vitest';
import {
  parseReviewerReply,
  buildReviewPrompt,
  makeFeedbackRecord,
  REVIEWER_MAX_ATTEMPTS,
} from '../../src/engine/reviewer-loop.js';

describe('parseReviewerReply', () => {
  it('returns null + matched=true for plain NO-FEEDBACK', () => {
    const r = parseReviewerReply('NO-FEEDBACK');
    expect(r.matched).toBe(true);
    expect(r.feedback).toBeNull();
  });

  it('is case-insensitive on NO-FEEDBACK', () => {
    const r = parseReviewerReply('no-feedback');
    expect(r.matched).toBe(true);
    expect(r.feedback).toBeNull();
  });

  it('accepts NO FEEDBACK with a space', () => {
    const r = parseReviewerReply('No feedback');
    expect(r.matched).toBe(true);
    expect(r.feedback).toBeNull();
  });

  it('treats NO-FEEDBACK with trailing garbage on the next line as no-feedback', () => {
    const r = parseReviewerReply('NO-FEEDBACK\n(I checked acceptance criteria)');
    expect(r.matched).toBe(true);
    expect(r.feedback).toBeNull();
  });

  it('extracts feedback body when first line is FEEDBACK', () => {
    const r = parseReviewerReply('FEEDBACK\n- src/auth.ts: missing password complexity check\n- session never expires');
    expect(r.matched).toBe(true);
    expect(r.feedback).toContain('missing password complexity');
    expect(r.feedback).toContain('session never expires');
  });

  it('is case-insensitive on FEEDBACK token', () => {
    const r = parseReviewerReply('feedback\n- one concern');
    expect(r.matched).toBe(true);
    expect(r.feedback).toContain('one concern');
  });

  it('rejects positive-boilerplate-with-token-inside-line as not matched', () => {
    // "Looks good — NO-FEEDBACK" must NOT match because the first line does
    // not START with NO-FEEDBACK; it's chatty preamble.
    const r = parseReviewerReply('Looks good — NO-FEEDBACK');
    expect(r.matched).toBe(false);
    expect(r.feedback).toBeNull();
  });

  it('treats free-form text as not matched (conservative skip)', () => {
    const r = parseReviewerReply('After reviewing the change I think it looks fine but...');
    expect(r.matched).toBe(false);
    expect(r.feedback).toBeNull();
  });

  it('returns matched=false for empty input', () => {
    const r = parseReviewerReply('');
    expect(r.matched).toBe(false);
    expect(r.feedback).toBeNull();
  });

  it('returns matched=false for whitespace-only input', () => {
    const r = parseReviewerReply('   \n  \t  ');
    expect(r.matched).toBe(false);
    expect(r.feedback).toBeNull();
  });

  it('trims leading whitespace before checking first line', () => {
    const r = parseReviewerReply('\n\nNO-FEEDBACK');
    expect(r.matched).toBe(true);
    expect(r.feedback).toBeNull();
  });
});

describe('buildReviewPrompt', () => {
  it('builds a spec prompt that includes the spec body', () => {
    const p = buildReviewPrompt({
      kind: 'spec',
      repository: 'owner/repo',
      taskTitle: 'Add login',
      taskDescription: 'Users should be able to log in.',
      spec: '# Spec\n## Acceptance Criteria\n- AC1: Valid creds',
    });
    expect(p).toContain('draft specification');
    expect(p).toContain('Add login');
    expect(p).toContain('AC1: Valid creds');
    expect(p).toContain('owner/repo');
    expect(p).toContain('NO-FEEDBACK');
  });

  it('builds a coder-initial prompt that includes diff stat + changed files', () => {
    const p = buildReviewPrompt({
      kind: 'coder-initial',
      workspaceRoot: '/tmp/repo',
      sha: 'abc1234',
      taskTitle: 'Add login',
      taskDescription: 'Login feature',
      diffStat: ' src/auth.ts | 12 ++\n 1 file changed',
      changedFiles: ['src/auth.ts'],
    });
    expect(p).toContain('initial commit');
    expect(p).toContain('abc1234');
    expect(p).toContain('src/auth.ts');
    expect(p).toContain('NO-FEEDBACK');
  });

  it('builds a coder-iter prompt labelled follow-up', () => {
    const p = buildReviewPrompt({
      kind: 'coder-iter',
      workspaceRoot: '/tmp/repo',
      sha: 'def5678',
      taskTitle: 'Add login',
      taskDescription: 'Login feature',
    });
    expect(p).toContain('follow-up commit');
    expect(p).toContain('def5678');
  });

  it('builds a deploy prompt that includes the dev URL and validation outcome', () => {
    const p = buildReviewPrompt({
      kind: 'deploy',
      workspaceRoot: '/tmp/repo',
      sha: 'abc1234',
      taskTitle: 'Add login',
      taskDescription: 'Login feature',
      devUrl: 'https://example.com/preview',
      validationOutcome: 'healthy',
    });
    expect(p).toContain('deploy + validation');
    expect(p).toContain('https://example.com/preview');
    expect(p).toContain('healthy');
  });

  it('all prompts include the strict NO-FEEDBACK/FEEDBACK output contract', () => {
    const kinds: Array<{ ctx: Parameters<typeof buildReviewPrompt>[0] }> = [
      { ctx: { kind: 'spec', taskTitle: 't', taskDescription: 'd', spec: 's' } },
      {
        ctx: {
          kind: 'coder-initial',
          workspaceRoot: '/x',
          sha: 's',
          taskTitle: 't',
          taskDescription: 'd',
        },
      },
      {
        ctx: {
          kind: 'coder-iter',
          workspaceRoot: '/x',
          sha: 's',
          taskTitle: 't',
          taskDescription: 'd',
        },
      },
      {
        ctx: {
          kind: 'deploy',
          workspaceRoot: '/x',
          sha: 's',
          taskTitle: 't',
          taskDescription: 'd',
        },
      },
    ];
    for (const { ctx } of kinds) {
      const p = buildReviewPrompt(ctx);
      expect(p).toMatch(/NO-FEEDBACK/);
      expect(p).toMatch(/FEEDBACK/);
      expect(p).toMatch(/READ-ONLY/i);
    }
  });
});

describe('makeFeedbackRecord', () => {
  it('builds a record with id, kind, text, createdAt, attempts=0', () => {
    const r = makeFeedbackRecord('spec', 'some concern');
    expect(r.id).toMatch(/[0-9a-f-]+/);
    expect(r.kind).toBe('spec');
    expect(r.text).toBe('some concern');
    expect(r.attempts).toBe(0);
    expect(typeof r.createdAt).toBe('string');
    expect(r.sha).toBeUndefined();
  });

  it('includes sha when provided', () => {
    const r = makeFeedbackRecord('coder-initial', 'bug', 'abc1234');
    expect(r.sha).toBe('abc1234');
  });
});

describe('REVIEWER_MAX_ATTEMPTS', () => {
  it('has a sane default >= 1', () => {
    expect(REVIEWER_MAX_ATTEMPTS).toBeGreaterThanOrEqual(1);
  });
});
