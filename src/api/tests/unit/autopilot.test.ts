import { describe, it, expect } from 'vitest';
import { parseVerdict, Budget, gateVerdict } from '../../src/engine/autopilot.js';

describe('parseVerdict', () => {
  it('parses a done verdict with em-dash reason', () => {
    const v = parseVerdict('VERDICT: done — login implemented and tests green');
    expect(v?.status).toBe('done');
    expect(v?.reason).toBe('login implemented and tests green');
  });

  it('parses blocked with colon separator', () => {
    const v = parseVerdict('VERDICT: blocked: missing API key in workspace');
    expect(v?.status).toBe('blocked');
    expect(v?.reason).toContain('missing API key');
  });

  it('parses continue without reason', () => {
    const v = parseVerdict('VERDICT: continue');
    expect(v?.status).toBe('continue');
    expect(v?.reason).toContain('continue');
  });

  it('returns null when no verdict line present', () => {
    expect(parseVerdict('I am thinking about what to do next.')).toBeNull();
  });

  it('returns the LAST verdict when multiple are present', () => {
    const text = `VERDICT: continue — still iterating
... more work ...
VERDICT: done — finished now`;
    expect(parseVerdict(text)?.status).toBe('done');
  });

  it('is case-insensitive on VERDICT and status', () => {
    expect(parseVerdict('verdict: Done — ok')?.status).toBe('done');
    expect(parseVerdict('Verdict: BLOCKED — nope')?.status).toBe('blocked');
  });

  it('ignores non-verdict words', () => {
    expect(parseVerdict('My verdict is that this is hard')).toBeNull();
  });
});

describe('Budget', () => {
  it('starts healthy and counts turns', () => {
    const b = new Budget({ maxTurns: 3, maxWallMs: 60_000 });
    expect(b.isHealthy()).toBe(true);
    b.recordTurn();
    b.recordTurn();
    const snap = b.snapshot();
    expect(snap.turnsUsed).toBe(2);
    expect(snap.turnsRemaining).toBe(1);
    expect(snap.exhausted).toBe(false);
  });

  it('exhausts on turn cap', () => {
    const b = new Budget({ maxTurns: 1, maxWallMs: 60_000 });
    b.recordTurn();
    expect(b.isHealthy()).toBe(false);
    expect(b.snapshot().reason).toContain('1/1 turns');
  });

  it('exhausts on wall-clock cap', () => {
    const b = new Budget({ maxTurns: 100, maxWallMs: 1 });
    // wait synchronously enough for clock to tick past 1ms
    const start = Date.now();
    while (Date.now() - start < 5) {
      // spin
    }
    expect(b.isHealthy()).toBe(false);
    expect(b.snapshot().reason).toContain('wall');
  });
});

describe('gateVerdict', () => {
  const allGood = {
    testsExitCode: 0,
    deployHealthy: true,
    gherkinAllPassed: true,
    checksRan: { tests: true, deploy: true, gherkin: true },
  };

  it('accepts done when all objective checks green', () => {
    expect(
      gateVerdict({
        verdict: { status: 'done', reason: 'ok', raw: 'VERDICT: done' },
        objective: allGood,
      }),
    ).toBeNull();
  });

  it('rejects done when tests red', () => {
    const r = gateVerdict({
      verdict: { status: 'done', reason: 'ok', raw: 'VERDICT: done' },
      objective: { ...allGood, testsExitCode: 1 },
    });
    expect(r).toContain('tests are red');
  });

  it('rejects done when deploy unhealthy', () => {
    const r = gateVerdict({
      verdict: { status: 'done', reason: 'ok', raw: 'VERDICT: done' },
      objective: { ...allGood, deployHealthy: false },
    });
    expect(r).toContain('deploy is not healthy');
  });

  it('rejects done when tests never ran', () => {
    const r = gateVerdict({
      verdict: { status: 'done', reason: 'ok', raw: 'VERDICT: done' },
      objective: {
        ...allGood,
        checksRan: { tests: false, deploy: true, gherkin: true },
      },
    });
    expect(r).toContain('tests were never run');
  });

  it('passes through blocked verdicts without gating', () => {
    expect(
      gateVerdict({
        verdict: { status: 'blocked', reason: 'no creds', raw: 'V' },
        objective: { ...allGood, testsExitCode: 99 },
      }),
    ).toBeNull();
  });

  it('allows gherkin to be skipped (specs without acceptance.feature)', () => {
    const r = gateVerdict({
      verdict: { status: 'done', reason: 'ok', raw: 'VERDICT: done' },
      objective: {
        ...allGood,
        checksRan: { tests: true, deploy: true, gherkin: false },
      },
    });
    expect(r).toBeNull();
  });
});
