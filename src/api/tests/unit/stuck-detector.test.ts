import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyFailure,
  recordAndDecide,
  resetStuckHistory,
  STUCK_THRESHOLD,
} from '../../src/engine/stuck-detector.js';

describe('stuck-detector', () => {
  beforeEach(() => {
    resetStuckHistory('t1');
    resetStuckHistory('t2');
  });

  describe('classifyFailure', () => {
    it('classifies HTTP 4xx', () => {
      expect(classifyFailure('HTTP 404 from http://x/y')).toBe('http-4xx');
    });
    it('classifies HTTP 5xx', () => {
      expect(classifyFailure('HTTP 502 from x (5xx — upstream broken)')).toBe(
        'http-5xx',
      );
    });
    it('classifies CrashLoopBackOff', () => {
      expect(classifyFailure('Pod app-xyz is Pending (CrashLoopBackOff)')).toBe(
        'pod-crashloop',
      );
    });
    it('classifies ImagePullBackOff', () => {
      expect(
        classifyFailure('Pod app-xyz is Pending (ImagePullBackOff)'),
      ).toBe('pod-imagepullbackoff');
    });
    it('classifies redirect-out-of-base', () => {
      expect(
        classifyFailure(
          'HTTP 200 from http://gw/dev/x but redirected OUT of its base path → http://gw/',
        ),
      ).toBe('redirect-out-of-base');
    });
    it('classifies probe error as unreachable', () => {
      expect(
        classifyFailure('HTTP probe of http://gw/dev/x failed: ECONNREFUSED'),
      ).toBe('http-unreachable');
    });
    it('classifies no pods', () => {
      expect(classifyFailure('No pods in namespace devx-foo')).toBe('no-pods');
    });
    it('falls back to unknown', () => {
      expect(classifyFailure('something unexpected happened')).toBe('unknown');
    });
  });

  describe('recordAndDecide', () => {
    it('does not declare stuck before threshold', () => {
      const summary = 'HTTP 404 from x';
      for (let i = 0; i < STUCK_THRESHOLD - 1; i++) {
        const d = recordAndDecide('t1', summary);
        expect(d.stuck).toBe(false);
        expect(d.escalationBlock).toBeNull();
      }
    });

    it('declares stuck once threshold is hit and emits an escalation block', () => {
      const summary = 'HTTP 404 from x';
      let last;
      for (let i = 0; i < STUCK_THRESHOLD; i++) {
        last = recordAndDecide('t1', summary);
      }
      expect(last!.stuck).toBe(true);
      expect(last!.signature).toBe('http-4xx');
      expect(last!.streak).toBe(STUCK_THRESHOLD);
      expect(last!.escalationBlock).toBeTruthy();
      expect(last!.escalationBlock!).toMatch(/STUCK/);
      expect(last!.strategyIndex).toBe(0);
    });

    it('rotates strategies across consecutive escalations', () => {
      const summary = 'HTTP 404 from x';
      // Burn STUCK_THRESHOLD-1 to get just under
      for (let i = 0; i < STUCK_THRESHOLD - 1; i++) {
        recordAndDecide('t1', summary);
      }
      const e0 = recordAndDecide('t1', summary);
      const e1 = recordAndDecide('t1', summary);
      const e2 = recordAndDecide('t1', summary);
      const e3 = recordAndDecide('t1', summary);
      expect(e0.strategyIndex).toBe(0);
      expect(e1.strategyIndex).toBe(1);
      expect(e2.strategyIndex).toBe(2);
      expect(e3.strategyIndex).toBe(0); // rotates
    });

    it('resets streak when signature changes', () => {
      // Two http-404, then a 5xx — streak resets
      recordAndDecide('t1', 'HTTP 404 from x');
      recordAndDecide('t1', 'HTTP 404 from x');
      const d = recordAndDecide('t1', 'HTTP 502 from x');
      expect(d.signature).toBe('http-5xx');
      expect(d.streak).toBe(1);
      expect(d.stuck).toBe(false);
    });

    it('isolates history per task', () => {
      const summary = 'HTTP 404 from x';
      for (let i = 0; i < STUCK_THRESHOLD; i++) recordAndDecide('t1', summary);
      const d2 = recordAndDecide('t2', summary);
      expect(d2.stuck).toBe(false);
      expect(d2.streak).toBe(1);
    });

    it('resetStuckHistory wipes a task', () => {
      const summary = 'HTTP 404 from x';
      for (let i = 0; i < STUCK_THRESHOLD; i++) recordAndDecide('t1', summary);
      resetStuckHistory('t1');
      const d = recordAndDecide('t1', summary);
      expect(d.stuck).toBe(false);
      expect(d.streak).toBe(1);
    });
  });
});
