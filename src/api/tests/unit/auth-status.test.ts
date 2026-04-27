import { describe, it, expect } from 'vitest';
import { classifyError } from '../../src/engine/auth-status.js';

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
