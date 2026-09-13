import { describe, expect, it } from 'vitest';
import {
  evaluateThrottle,
  PASSWORD_RESET_RULE,
  recordAttempt,
  SIGNIN_FAILURE_RULE,
  VERIFICATION_RESEND_RULE,
} from './throttle';

/**
 * The three rules the shared throttle serves, exercised at the boundaries the
 * acceptance criteria name. Time is a parameter here, so nothing sleeps.
 */

describe('rule parameters', () => {
  it('match the criteria they serve', () => {
    // Requirement 1.7 — at most one resend per 60 seconds.
    expect(VERIFICATION_RESEND_RULE).toEqual({ windowMs: 60_000, limit: 1, cooldownMs: 0 });
    // Requirement 2.3 — 10 failures in 5 minutes, then a 60-second block.
    expect(SIGNIN_FAILURE_RULE).toEqual({ windowMs: 300_000, limit: 10, cooldownMs: 60_000 });
    // Requirement 2.9 — at most 3 reset messages per 60 minutes.
    expect(PASSWORD_RESET_RULE).toEqual({ windowMs: 3_600_000, limit: 3, cooldownMs: 0 });
  });
});

describe('verification resend rule (no cooldown)', () => {
  it('admits the first attempt', () => {
    expect(evaluateThrottle([], 1_000, VERIFICATION_RESEND_RULE)).toEqual({
      allowed: true,
      retryAfterSeconds: 0,
      attempts: [],
    });
  });

  it('blocks a second attempt inside the window and reports the ceiling of the time left', () => {
    const ledger = recordAttempt([], 0, VERIFICATION_RESEND_RULE);

    // 40.001 seconds later, 19.999 seconds remain — reported as 20, never 19.
    const decision = evaluateThrottle(ledger, 40_001, VERIFICATION_RESEND_RULE);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBe(20);
  });

  it('admits again exactly when the recorded attempt ages out', () => {
    const ledger = recordAttempt([], 0, VERIFICATION_RESEND_RULE);

    expect(evaluateThrottle(ledger, 59_999, VERIFICATION_RESEND_RULE).allowed).toBe(false);
    expect(evaluateThrottle(ledger, 60_000, VERIFICATION_RESEND_RULE).allowed).toBe(true);
  });
});

describe('signin failure rule (60-second cooldown)', () => {
  const tenFailures = (startMs = 0): number[] => {
    let ledger: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      ledger = recordAttempt(ledger, startMs + i * 1_000, SIGNIN_FAILURE_RULE);
    }
    return ledger;
  };

  it('admits attempts while fewer than 10 failures fall inside the 5-minute window', () => {
    let ledger: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      ledger = recordAttempt(ledger, i * 1_000, SIGNIN_FAILURE_RULE);
      expect(evaluateThrottle(ledger, i * 1_000, SIGNIN_FAILURE_RULE).allowed).toBe(true);
    }
    expect(ledger).toHaveLength(9);
  });

  it('blocks for the 60 seconds following the tenth failure', () => {
    const ledger = tenFailures();
    const tenthAtMs = 9_000;

    expect(evaluateThrottle(ledger, tenthAtMs, SIGNIN_FAILURE_RULE)).toMatchObject({
      allowed: false,
      retryAfterSeconds: 60,
    });
    expect(evaluateThrottle(ledger, tenthAtMs + 30_500, SIGNIN_FAILURE_RULE).retryAfterSeconds).toBe(30);
    expect(evaluateThrottle(ledger, tenthAtMs + 59_999, SIGNIN_FAILURE_RULE).allowed).toBe(false);
  });

  it('holds the block for the whole 60 seconds when a failure ages out mid-cooldown', () => {
    // Nine failures at 300_000 plus one 241 seconds earlier: the oldest leaves
    // the 5-minute window at 541_000, but Requirement 2.3 blocks for the 60
    // seconds following the tenth failure, so release is 360_000 either way.
    const ledger = [59_000, ...Array.from({ length: 9 }, () => 300_000)];

    expect(evaluateThrottle(ledger, 359_000, SIGNIN_FAILURE_RULE)).toMatchObject({
      allowed: false,
      retryAfterSeconds: 1,
    });
    expect(evaluateThrottle(ledger, 359_999, SIGNIN_FAILURE_RULE).allowed).toBe(false);
    expect(evaluateThrottle(ledger, 360_000, SIGNIN_FAILURE_RULE).allowed).toBe(true);
  });

  it('admits once the cooldown runs out and discharges the recorded failures', () => {
    const ledger = tenFailures();

    const decision = evaluateThrottle(ledger, 9_000 + 60_000, SIGNIN_FAILURE_RULE);
    expect(decision.allowed).toBe(true);
    expect(decision.retryAfterSeconds).toBe(0);
    // Requirement 2.3 accepts an attempt after the 60 seconds, so the ten
    // failures cannot keep blocking for the rest of the 5-minute window.
    expect(decision.attempts).toEqual([]);
  });
});

describe('password reset rule (no cooldown)', () => {
  it('blocks the fourth message until the oldest of three ages out of the hour', () => {
    let ledger: number[] = [];
    ledger = recordAttempt(ledger, 0, PASSWORD_RESET_RULE);
    ledger = recordAttempt(ledger, 600_000, PASSWORD_RESET_RULE);
    ledger = recordAttempt(ledger, 1_200_000, PASSWORD_RESET_RULE);

    expect(evaluateThrottle(ledger, 1_200_000, PASSWORD_RESET_RULE)).toMatchObject({
      allowed: false,
      retryAfterSeconds: 2_400, // 40 minutes until the first send leaves the window
    });
    expect(evaluateThrottle(ledger, 3_600_000, PASSWORD_RESET_RULE).allowed).toBe(true);
  });
});

describe('recordAttempt', () => {
  it('drops attempts that have aged out of the window', () => {
    expect(recordAttempt([0, 1_000], 400_000, SIGNIN_FAILURE_RULE)).toEqual([400_000]);
  });

  it('keeps no more entries than the limit, since older ones cannot change a decision', () => {
    let ledger: number[] = [];
    for (let i = 0; i < 15; i += 1) {
      ledger = recordAttempt(ledger, i * 1_000, SIGNIN_FAILURE_RULE);
    }
    expect(ledger).toHaveLength(SIGNIN_FAILURE_RULE.limit);
    expect(ledger[ledger.length - 1]).toBe(14_000);
  });

  it('keeps an attempt timestamped in the future, so clock skew cannot lift a block early', () => {
    const decision = evaluateThrottle([10_000], 0, VERIFICATION_RESEND_RULE);
    expect(decision.allowed).toBe(false);
  });
});

describe('rule validation', () => {
  it('rejects a rule that cannot admit anything or measures time backwards', () => {
    expect(() => evaluateThrottle([], 0, { windowMs: 1_000, limit: 0, cooldownMs: 0 })).toThrow(RangeError);
    expect(() => evaluateThrottle([], 0, { windowMs: -1, limit: 1, cooldownMs: 0 })).toThrow(RangeError);
    expect(() => recordAttempt([], 0, { windowMs: 1_000, limit: 1, cooldownMs: -5 })).toThrow(RangeError);
  });
});
