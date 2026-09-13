/**
 * One sliding-window throttle, shared by every attempt-limited flow.
 *
 * Three acceptance criteria prescribe rate limits with the same shape but
 * different numbers, so they are expressed as parameters rather than as three
 * near-identical implementations:
 *
 * | Rule                  | Requirement | window | limit | cooldown |
 * | --------------------- | ----------- | ------ | ----- | -------- |
 * | Verification resend   | 1.7         | 60s    | 1     | none     |
 * | Signin failures       | 2.3         | 5min   | 10    | 60s      |
 * | Password reset sends  | 2.9         | 60min  | 3     | none     |
 *
 * The module is pure: no clock, no storage, no randomness. `nowMs` and the
 * recorded attempt timestamps are supplied by the caller, which is what lets
 * the throttle be tested as a predicate over generated attempt sequences
 * rather than by sleeping.
 *
 * The two release rules are worth stating plainly, because they differ:
 *
 * - With a cooldown (the signin rule), reaching the limit blocks for exactly
 *   the cooldown measured from the most recent attempt, and reaching the end of
 *   that cooldown *discharges* the recorded attempts. Requirement 2.3 blocks
 *   for "the following 60 seconds" and then accepts an attempt again, so the
 *   ten failures cannot keep blocking for the remainder of the 5-minute window —
 *   and, in the other direction, an attempt ageing out of the window part-way
 *   through the cooldown cannot cut the 60 seconds short either.
 * - With no cooldown (the resend and reset rules), the block lifts when an
 *   attempt ages out of the window and brings the count back under the limit.
 *   Requirements 1.7 and 2.9 are stated as "at most N per interval", which is
 *   exactly that.
 */

/** A window, an attempt limit inside that window, and a post-limit cooldown. */
export interface ThrottleRule {
  /** Length of the sliding window, in milliseconds. */
  readonly windowMs: number;
  /** Attempts permitted inside the window. At least 1. */
  readonly limit: number;
  /**
   * Block duration applied once the limit is reached, measured from the most
   * recent attempt. Zero means the block lifts by window expiry instead.
   */
  readonly cooldownMs: number;
}

/** Whether the next attempt is admitted, and the ledger to persist. */
export interface ThrottleDecision {
  /** True when the next attempt may proceed. */
  readonly allowed: boolean;
  /**
   * Whole seconds until the next attempt is admitted — the exact ceiling of
   * the time remaining, so a caller counting down never displays 0 while the
   * attempt is still blocked. Always 0 when `allowed` is true.
   */
  readonly retryAfterSeconds: number;
  /**
   * The recorded attempts after aged-out entries are dropped and, when a
   * cooldown has run out, after the discharge. Callers persist this in place of
   * what they read, which is what keeps a stored ledger from growing without
   * bound. While a cooldown is running the entries are kept as recorded, since
   * dropping one as it ages out of the window would end the block early.
   */
  readonly attempts: number[];
}

/** Requirement 1.7 — at most one verification resend per 60 seconds. */
export const VERIFICATION_RESEND_RULE: ThrottleRule = {
  windowMs: 60_000,
  limit: 1,
  cooldownMs: 0,
};

/** Requirement 2.3 — 10 failures inside 5 minutes blocks the next 60 seconds. */
export const SIGNIN_FAILURE_RULE: ThrottleRule = {
  windowMs: 300_000,
  limit: 10,
  cooldownMs: 60_000,
};

/** Requirement 2.9 — at most 3 password reset messages per 60 minutes. */
export const PASSWORD_RESET_RULE: ThrottleRule = {
  windowMs: 3_600_000,
  limit: 3,
  cooldownMs: 0,
};

function assertRule(rule: ThrottleRule): void {
  if (!Number.isFinite(rule.windowMs) || rule.windowMs < 0) {
    throw new RangeError('A throttle rule needs a finite, non-negative windowMs.');
  }
  if (!Number.isInteger(rule.limit) || rule.limit < 1) {
    throw new RangeError('A throttle rule needs an integer limit of at least 1.');
  }
  if (!Number.isFinite(rule.cooldownMs) || rule.cooldownMs < 0) {
    throw new RangeError('A throttle rule needs a finite, non-negative cooldownMs.');
  }
}

/**
 * The attempts still inside the window at `nowMs`, ascending.
 *
 * An attempt timestamp in the future (a clock moved backwards, a ledger copied
 * between machines) is kept rather than dropped, so skew cannot lift a block
 * early.
 */
function attemptsInWindow(
  attempts: Iterable<number>,
  nowMs: number,
  rule: ThrottleRule
): number[] {
  return Array.from(attempts)
    .filter((at) => Number.isFinite(at) && nowMs - at < rule.windowMs)
    .sort((a, b) => a - b);
}

/** Whole seconds remaining, as an exact ceiling, never negative. */
function secondsUntil(releaseAtMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((releaseAtMs - nowMs) / 1000));
}

/**
 * The instant a cooldown was armed, i.e. the most recent of `limit` attempts
 * that fall inside one window — the tenth failure in Requirement 2.3's wording.
 * Null when the recorded attempts never filled the limit inside a window.
 *
 * This looks at the recorded attempts rather than only the ones still inside the
 * window at `nowMs`: the block runs for the cooldown measured from the trigger,
 * so an attempt ageing out part-way through must not end it early.
 */
function cooldownTriggerAt(recorded: readonly number[], rule: ThrottleRule): number | null {
  if (rule.cooldownMs <= 0 || recorded.length < rule.limit) return null;
  const recent = recorded.slice(-rule.limit);
  const triggeredAtMs = recent[recent.length - 1];
  return triggeredAtMs - recent[0] < rule.windowMs ? triggeredAtMs : null;
}

/**
 * Decides whether the next attempt is admitted at `nowMs`.
 *
 * Under a rule with a cooldown, an attempt is admitted exactly when no cooldown
 * is armed or the armed one has run out — in which case the returned `attempts`
 * are empty, because that cooldown has discharged them. Under a rule without
 * one, an attempt is admitted exactly when fewer than `limit` recorded attempts
 * fall inside the preceding window.
 */
export function evaluateThrottle(
  attempts: Iterable<number>,
  nowMs: number,
  rule: ThrottleRule
): ThrottleDecision {
  assertRule(rule);
  const recorded = Array.from(attempts)
    .filter((at) => Number.isFinite(at))
    .sort((a, b) => a - b);
  const inWindow = attemptsInWindow(recorded, nowMs, rule);

  const triggeredAtMs = cooldownTriggerAt(recorded, rule);
  if (triggeredAtMs !== null) {
    const releaseAtMs = triggeredAtMs + rule.cooldownMs;
    if (nowMs >= releaseAtMs) {
      // The trigger is the most recent recorded attempt, so the cooldown running
      // out discharges the whole ledger.
      return { allowed: true, retryAfterSeconds: 0, attempts: [] };
    }
    // Handed back as recorded, not window-filtered: the block lasts the full
    // cooldown even when an attempt ages out before it ends.
    return {
      allowed: false,
      retryAfterSeconds: secondsUntil(releaseAtMs, nowMs),
      attempts: recorded.slice(-rule.limit),
    };
  }

  if (inWindow.length < rule.limit) {
    return { allowed: true, retryAfterSeconds: 0, attempts: inWindow };
  }

  // No armed cooldown: the block lifts when the limit-th most recent attempt
  // ages out of the window, the first instant the count falls under the limit.
  const releaseAtMs = inWindow[inWindow.length - rule.limit] + rule.windowMs;
  return { allowed: false, retryAfterSeconds: secondsUntil(releaseAtMs, nowMs), attempts: inWindow };
}

/**
 * The ledger after recording an attempt at `nowMs`.
 *
 * Aged-out entries are dropped and only the most recent `limit` entries are
 * kept: nothing beyond them can change a later decision, since every rule reads
 * either the count against the limit or the limit-th most recent timestamp.
 */
export function recordAttempt(
  attempts: Iterable<number>,
  nowMs: number,
  rule: ThrottleRule
): number[] {
  assertRule(rule);
  const kept = attemptsInWindow(attempts, nowMs, rule);
  kept.push(nowMs);
  kept.sort((a, b) => a - b);
  return kept.slice(-rule.limit);
}
