import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { classifyError } from '../../src/engine/auth-status.js';

// classifyError consults the env to disambiguate "missing token" from "401".
// In CI no token is set, so we ensure one is present for these unit tests.
const TOKEN_KEYS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'];
const savedTokens: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of TOKEN_KEYS) savedTokens[k] = process.env[k];
  process.env['GITHUB_TOKEN'] = 'fake-test-token';
});
afterAll(() => {
  for (const k of TOKEN_KEYS) {
    if (savedTokens[k] === undefined) delete process.env[k];
    else process.env[k] = savedTokens[k];
  }
});

describe('classifyError', () => {
  it('classifies 401 as unauthorized', () => {
    const r = classifyError(new Error('Request failed: 401 Unauthorized'));
    expect(r.kind).toBe('unauthorized');
    expect(r.message).toMatch(/regenerate/i);
  });

  it('classifies "Bad credentials" as unauthorized', () => {
    const r = classifyError(new Error('Bad credentials'));
    expect(r.kind).toBe('unauthorized');
  });

  it('classifies 403 / forbidden as forbidden', () => {
    const r = classifyError(new Error('403 Forbidden — no Copilot subscription'));
    expect(r.kind).toBe('forbidden');
    expect(r.message).toMatch(/subscription/i);
  });

  it('classifies rate-limit as quota', () => {
    expect(classifyError(new Error('429 Too Many Requests')).kind).toBe('quota');
    expect(classifyError(new Error('quota exceeded')).kind).toBe('quota');
  });

  it('classifies network errors', () => {
    expect(classifyError(new Error('getaddrinfo ENOTFOUND')).kind).toBe('network');
    expect(classifyError(new Error('fetch failed')).kind).toBe('network');
  });

  it('classifies timeouts', () => {
    expect(classifyError(new Error('Operation timed out')).kind).toBe('timeout');
  });

  it('falls back to unknown', () => {
    const r = classifyError(new Error('some weird thing'));
    expect(r.kind).toBe('unknown');
    expect(r.message).toContain('some weird thing');
  });
});
