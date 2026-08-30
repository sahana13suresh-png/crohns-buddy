/**
 * Property-based tests for the Auth_Service client-side helpers.
 *
 * Feature: user-auth-and-cloud-storage. This file holds the properties that
 * target `src/lib/throttle.ts` and the pure helpers in `src/lib/auth.ts`, one
 * `describe` per property:
 *
 * - Property 16: sliding-window throttles (below)
 * - Property 17: display name derivation (below)
 *
 * Shared generators and helpers live at module scope so later properties can be
 * appended without restructuring what is already here.
 */

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deriveDisplayName,
  DISPLAY_NAME_MAX_LENGTH,
  getSignInThrottleState,
  recordSignInFailure,
  resetSignInFailures,
  signIn,
  SignInThrottledError,
} from '@/lib/auth';
import {
  evaluateThrottle,
  PASSWORD_RESET_RULE,
  recordAttempt,
  SIGNIN_FAILURE_RULE,
  ThrottleRule,
  VERIFICATION_RESEND_RULE,
} from '@/lib/throttle';
import { arbTrickyString } from '@/test/arbitraries';

// ─── Shared helpers ────────────────────────────────────────────────────────────

/** A plausible "now", well clear of the epoch so offsets never go negative. */
const arbNowMs = fc.integer({ min: Date.UTC(2024, 0, 1), max: Date.UTC(2030, 0, 1) });

/**
 * Addresses that differ only in case and padding as well as in local part, since
 * the ledger keys on a hash of the lowercased, trimmed address.
 */
const arbEmail = fc
  .tuple(
    fc.hexaString({ minLength: 1, maxLength: 10 }),
    fc.constantFrom('example.com', 'Example.COM', 'mail.test'),
    fc.constantFrom('', ' ', '  '),
  )
  .map(([local, domain, padding]) => `${padding}${local}@${domain}${padding}`);

// ─── Property 16 ───────────────────────────────────────────────────────────────

/** The three rules the shared predicate serves, named by the criterion each one encodes. */
const NAMED_RULES: ReadonlyArray<{ readonly name: string; readonly rule: ThrottleRule }> = [
  { name: 'verification resend (1.7)', rule: VERIFICATION_RESEND_RULE },
  { name: 'signin failures (2.3)', rule: SIGNIN_FAILURE_RULE },
  { name: 'password reset sends (2.9)', rule: PASSWORD_RESET_RULE },
];

/**
 * The recorded attempts inside the window at `nowMs`, ascending — expressed as
 * `at > nowMs - windowMs` rather than as the module's `nowMs - at < windowMs` so
 * the expectation is not a copy of the implementation's comparison.
 */
function attemptsInWindow(attempts: readonly number[], nowMs: number, rule: ThrottleRule): number[] {
  return attempts.filter((at) => at > nowMs - rule.windowMs).sort((a, b) => a - b);
}

/**
 * The earliest instant at or after `nowMs` at which the rule admits an attempt,
 * found by bisection rather than by recomputing the release formula.
 *
 * Bisection is sound because admission is monotone in time for a fixed ledger:
 * window membership is `now < at + windowMs`, which only ever stops holding as
 * time advances, so the in-window count never rises and neither the count test
 * nor the cooldown test can flip back from admitting to blocking.
 */
function firstAdmittedInstant(attempts: readonly number[], nowMs: number, rule: ThrottleRule): number {
  if (evaluateThrottle(attempts, nowMs, rule).allowed) return nowMs;

  // By this instant every recorded attempt has aged out, so the count is 0.
  const horizon = Math.max(nowMs, ...attempts) + rule.windowMs + rule.cooldownMs + 1;
  expect(evaluateThrottle(attempts, horizon, rule).allowed).toBe(true);

  let blockedAt = nowMs;
  let admittedAt = horizon;
  while (admittedAt - blockedAt > 1) {
    const mid = Math.floor((blockedAt + admittedAt) / 2);
    if (evaluateThrottle(attempts, mid, rule).allowed) {
      admittedAt = mid;
    } else {
      blockedAt = mid;
    }
  }
  return admittedAt;
}

/**
 * Attempt timestamps scattered around `nowMs`, biased to the instants where the
 * decision turns over: the window edge, the cooldown edge, and the future (a
 * ledger whose clock ran backwards).
 */
function arbScatteredAttempts(nowMs: number, rule: ThrottleRule): fc.Arbitrary<number[]> {
  const edges = [
    0,
    1,
    -1,
    -1_000,
    rule.windowMs - 1,
    rule.windowMs,
    rule.windowMs + 1,
    rule.cooldownMs - 1,
    rule.cooldownMs,
    rule.cooldownMs + 1,
    rule.windowMs + rule.cooldownMs,
  ];
  const arbOffsetMs = fc.oneof(
    { weight: 4, arbitrary: fc.constantFrom(...edges) },
    { weight: 6, arbitrary: fc.integer({ min: -2_000, max: rule.windowMs + rule.cooldownMs + 2_000 }) },
  );
  return fc.array(
    arbOffsetMs.map((offset) => nowMs - offset),
    { minLength: 0, maxLength: rule.limit + 4 },
  );
}

/**
 * A burst that fills the limit, placed at a chosen age. Scattered attempts reach
 * the limit only by luck once the limit is 10, so this shape is generated
 * deliberately: it is what puts the decision on the blocking side of the rule
 * and, when the burst is older than the cooldown, on the discharged side.
 */
function arbBurstAttempts(nowMs: number, rule: ThrottleRule): fc.Arbitrary<number[]> {
  return fc
    .record({
      count: fc.integer({ min: rule.limit, max: rule.limit + 3 }),
      // The age of the most recent attempt in the burst, straddling the cooldown
      // edge and the window edge.
      ageMs: fc.oneof(
        { weight: 5, arbitrary: fc.integer({ min: 0, max: Math.max(1, rule.cooldownMs + 2_000) }) },
        { weight: 3, arbitrary: fc.integer({ min: 0, max: rule.windowMs + 2_000 }) },
        {
          weight: 2,
          arbitrary: fc.constantFrom(
            0,
            rule.cooldownMs - 1,
            rule.cooldownMs,
            rule.cooldownMs + 1,
            rule.windowMs - 1,
            rule.windowMs,
          ),
        },
      ),
      spreadMs: fc.integer({ min: 0, max: Math.max(1, Math.floor(rule.windowMs / 4)) }),
    })
    .map(({ count, ageMs, spreadMs }) =>
      Array.from({ length: count }, (_, index) => {
        const step = count === 1 ? 0 : Math.round((spreadMs * index) / (count - 1));
        return nowMs - ageMs - step;
      }),
    );
}

function arbAttempts(nowMs: number, rule: ThrottleRule): fc.Arbitrary<number[]> {
  return fc.oneof(
    { weight: 5, arbitrary: arbScatteredAttempts(nowMs, rule) },
    { weight: 5, arbitrary: arbBurstAttempts(nowMs, rule) },
  );
}

const arbThrottleScenario = fc
  .tuple(fc.constantFrom(...NAMED_RULES), arbNowMs)
  .chain(([named, nowMs]) =>
    arbAttempts(nowMs, named.rule).map((attempts) => ({ named, nowMs, attempts })),
  );

/** Attempt outcomes, one per signin submission, in the categories the criteria separate. */
type SignInOutcome = 'credential-rejection' | 'validation-rejected' | 'transport-failure' | 'success';

/**
 * A run of submissions for one address. Credential rejections dominate and the
 * gaps are mostly short, because a run that never reaches ten failures inside
 * five minutes would never exercise the blocked side of Requirement 2.3; the
 * occasional long gap and the occasional success still cover the release paths.
 */
const arbSignInSteps = fc.array(
  fc.record({
    outcome: fc.oneof(
      { weight: 12, arbitrary: fc.constant<SignInOutcome>('credential-rejection') },
      { weight: 2, arbitrary: fc.constant<SignInOutcome>('validation-rejected') },
      { weight: 2, arbitrary: fc.constant<SignInOutcome>('transport-failure') },
      { weight: 1, arbitrary: fc.constant<SignInOutcome>('success') },
    ),
    gapMs: fc.oneof(
      { weight: 6, arbitrary: fc.integer({ min: 0, max: 5_000 }) },
      { weight: 3, arbitrary: fc.constantFrom(0, 1, 1_000, 59_999, 60_000, 60_001, 299_999, 300_000) },
      { weight: 1, arbitrary: fc.integer({ min: 0, max: 400_000 }) },
    ),
  }),
  // `minLength` is what makes the blocked side reachable: fast-check biases
  // arrays small, and a run of under ten submissions can never reach the limit.
  { minLength: 20, maxLength: 40 },
);

describe('sliding-window throttles', () => {
  // Feature: user-auth-and-cloud-storage, Property 16: Sliding-window throttles
  // admit an attempt exactly when the window permits.
  // **Validates: Requirements 1.7, 2.1, 2.3, 2.9, 2.11**

  it('admits an attempt exactly when the window permits, reporting the exact whole-second ceiling', () => {
    fc.assert(
      fc.property(arbThrottleScenario, ({ named, nowMs, attempts }) => {
        const { rule } = named;
        const decision = evaluateThrottle(attempts, nowMs, rule);
        const live = attemptsInWindow(attempts, nowMs, rule);

        // The criteria themselves. Without a cooldown (1.7, 2.9): at most `limit`
        // attempts inside the preceding window. With one (2.3): once `limit`
        // attempts fall inside a single window, the cooldown measured from the
        // most recent of them has to run out.
        const recent = [...attempts].sort((a, b) => a - b).slice(-rule.limit);
        const armedAtMs =
          rule.cooldownMs > 0 &&
          recent.length === rule.limit &&
          recent[recent.length - 1] - recent[0] < rule.windowMs
            ? recent[recent.length - 1]
            : null;
        expect(decision.allowed).toBe(
          armedAtMs === null ? live.length < rule.limit : nowMs >= armedAtMs + rule.cooldownMs,
        );

        // The countdown is a whole number of seconds, and it is zero exactly when
        // the attempt is admitted — a blocked caller never sees 0.
        expect(Number.isInteger(decision.retryAfterSeconds)).toBe(true);
        expect(decision.retryAfterSeconds).toBeGreaterThanOrEqual(0);
        expect(decision.retryAfterSeconds === 0).toBe(decision.allowed);

        // The countdown measures the real distance to release: the ceiling of the
        // time left before the earliest instant this ledger admits an attempt.
        const releaseAtMs = firstAdmittedInstant(attempts, nowMs, rule);
        expect(decision.allowed).toBe(releaseAtMs === nowMs);
        expect(decision.retryAfterSeconds).toBe(Math.ceil((releaseAtMs - nowMs) / 1000));

        if (!decision.allowed) {
          // Release is exact to the millisecond, and waiting out the reported
          // whole seconds is always enough — never one second short.
          expect(evaluateThrottle(attempts, releaseAtMs - 1, rule).allowed).toBe(false);
          expect(
            evaluateThrottle(attempts, nowMs + decision.retryAfterSeconds * 1_000, rule).allowed,
          ).toBe(true);
        }

        // The ledger handed back never grows, and it is discharged exactly when a
        // cooldown ran out (Requirement 2.3 accepts an attempt after the 60
        // seconds rather than for the rest of the 5-minute window).
        expect(decision.attempts.length).toBeLessThanOrEqual(Math.max(rule.limit, live.length));
        if (armedAtMs !== null) {
          expect(decision.attempts).toEqual(decision.allowed ? [] : recent);
        } else {
          expect(decision.attempts).toEqual(live);
        }
      }),
      { numRuns: 500 },
    );
  });

  describe('signin failure ledger', () => {
    beforeEach(() => {
      // Only Date is faked: `signIn` reads the clock through its default
      // argument, and nothing here waits on a timer.
      vi.useFakeTimers({ toFake: ['Date'] });
      window.localStorage.clear();
    });

    afterEach(() => {
      vi.useRealTimers();
      window.localStorage.clear();
    });

    it('counts only credential rejections, blocks the same way the rule does, and zeroes on success', async () => {
      await fc.assert(
        fc.asyncProperty(arbEmail, arbNowMs, arbSignInSteps, async (email, startMs, steps) => {
          window.localStorage.clear();

          // The model is the same pure rule, applied only to the attempts the
          // criteria say count: a credential rejection records, a success clears,
          // and nothing else touches the ledger.
          let model: number[] = [];
          let nowMs = startMs;

          for (const step of steps) {
            nowMs += step.gapMs;

            const expected = evaluateThrottle(model, nowMs, SIGNIN_FAILURE_RULE);
            const state = await getSignInThrottleState(email, nowMs);
            expect(state).toEqual({
              allowed: expected.allowed,
              retryAfterSeconds: expected.retryAfterSeconds,
              failureCount: expected.attempts.length,
            });
            // Reading persists the pruned ledger, so the model follows it.
            model = expected.attempts;

            if (!state.allowed) {
              // Requirement 2.3 — while the address is blocked no attempt reaches
              // the Auth_Service. `signIn` rejects with the countdown before it
              // ever asks for a Firebase instance, and the block is not extended.
              vi.setSystemTime(nowMs);
              await expect(signIn(email, 'unused-password')).rejects.toBeInstanceOf(
                SignInThrottledError,
              );
              expect(await getSignInThrottleState(email, nowMs)).toEqual(state);
              continue;
            }

            switch (step.outcome) {
              case 'credential-rejection': {
                const recorded = await recordSignInFailure(email, nowMs);
                model = recordAttempt(model, nowMs, SIGNIN_FAILURE_RULE);
                const afterRecord = evaluateThrottle(model, nowMs, SIGNIN_FAILURE_RULE);
                expect(recorded).toEqual({
                  allowed: afterRecord.allowed,
                  retryAfterSeconds: afterRecord.retryAfterSeconds,
                  failureCount: afterRecord.attempts.length,
                });
                break;
              }

              case 'success': {
                // Requirement 2.1 — the recorded count returns to zero.
                await resetSignInFailures(email);
                model = [];
                expect(await getSignInThrottleState(email, nowMs)).toEqual({
                  allowed: true,
                  retryAfterSeconds: 0,
                  failureCount: 0,
                });
                break;
              }

              case 'validation-rejected':
              case 'transport-failure': {
                // Requirements 2.11 and 2.12 — a field-validation rejection sends
                // no request and a transport failure is not a credential
                // rejection, so neither adds an entry. The ledger is untouched.
                expect(await getSignInThrottleState(email, nowMs)).toEqual(state);
                break;
              }
            }
          }

          // Requirement 2.1 holds from any prior state, including one at the
          // limit and blocked.
          await resetSignInFailures(email);
          expect(await getSignInThrottleState(email, nowMs)).toEqual({
            allowed: true,
            retryAfterSeconds: 0,
            failureCount: 0,
          });
        }),
        { numRuns: 120 },
      );
    });
  });
});

// ─── Property 17 ───────────────────────────────────────────────────────────────

/**
 * The 50-character cap is counted in **Unicode code points**, not UTF-16 code
 * units.
 *
 * Requirements 3.3 and 3.5 both say "the first 50 characters", which is
 * ambiguous for astral-plane characters. The design resolves the identical
 * ambiguity for the 100-character title in Open Technical Decision 2 in favour
 * of code points, so that an emoji is never split into a broken half, and the
 * server-side derivation in `joseAuthTokenVerifier` already truncates that way.
 * The assertions below follow the same reading, and additionally require that
 * the returned name is well-formed UTF-16 — a truncation that cuts a surrogate
 * pair in half fails the lone-surrogate check regardless of how the cap is
 * counted.
 */
const codePointsOf = (value: string): string[] => Array.from(value);

/**
 * Whether `value` holds a surrogate code unit that is not part of a pair, which
 * is the observable damage a code-unit truncation does to an emoji.
 *
 * `Array.from` iterates by code point, so a paired surrogate arrives as a
 * two-unit element and only an unpaired one arrives as a single unit in the
 * surrogate range.
 */
function hasLoneSurrogate(value: string): boolean {
  return codePointsOf(value).some((codePoint) => {
    if (codePoint.length !== 1) return false;
    const unit = codePoint.charCodeAt(0);
    return unit >= 0xd800 && unit <= 0xdfff;
  });
}

/** Whitespace the criteria's "leading and trailing whitespace" covers, plus none at all. */
const arbEdgeWhitespace = fc.constantFrom('', ' ', '   ', '\t', '\n', ' \r\n\t ', '\u00a0', '\u2028');

/**
 * A value whose astral-plane characters straddle the cap, so a truncation
 * counting UTF-16 code units lands inside a surrogate pair.
 *
 * With 49 single-unit fillers the 50th code unit is the high half of the first
 * emoji; the surrounding lengths keep the boundary swept rather than pinned to
 * one arrangement.
 */
const arbSurrogateBoundaryValue = fc
  .tuple(
    fc.integer({ min: 40, max: 60 }),
    fc.constantFrom('a', 'é', '中', 'ש'),
    fc.constantFrom('👩', '🍜', '😀', '🐛', '𝔘'),
  )
  .map(([fillerCount, filler, astral]) => filler.repeat(fillerCount) + astral.repeat(10));

/**
 * Profile display names as an Identity_Provider might supply them: absent,
 * whitespace-only, and present at lengths on both sides of the 50-character cap.
 *
 * `arbTrickyString` covers the awkward content — accents, CJK, emoji with
 * surrogate pairs, combining marks, bidi overrides, newlines, quotation marks —
 * and its bounds hold under both length readings, so a name generated as 1..20
 * is under the cap either way and one generated as 51..120 is over it either way.
 */
const arbProfileNameCore: fc.Arbitrary<string | null | undefined> = fc.oneof(
  { weight: 2, arbitrary: fc.constant(undefined) },
  { weight: 2, arbitrary: fc.constant(null) },
  { weight: 2, arbitrary: fc.constantFrom('', ' ', '   ', '\t\n', '\u00a0\u2028\u2029') },
  { weight: 5, arbitrary: arbTrickyString(1, 20) },
  { weight: 4, arbitrary: arbTrickyString(49, 52) },
  { weight: 4, arbitrary: arbTrickyString(51, 120) },
  { weight: 4, arbitrary: arbSurrogateBoundaryValue },
);

/**
 * Email local parts, including ones longer than the cap and ones that trim away
 * to nothing.
 *
 * `@` is replaced one-for-one so the address still holds exactly one separator
 * and the local part stays known by construction rather than by re-running the
 * module's own parsing inside the expectation.
 */
const arbLocalPartCore: fc.Arbitrary<string> = fc
  .oneof(
    { weight: 4, arbitrary: fc.hexaString({ minLength: 1, maxLength: 10 }) },
    { weight: 4, arbitrary: arbTrickyString(1, 20) },
    { weight: 4, arbitrary: arbTrickyString(51, 120) },
    { weight: 3, arbitrary: arbSurrogateBoundaryValue },
    { weight: 2, arbitrary: fc.constantFrom('', ' ', '  \t ') },
  )
  .map((core) => core.split('@').join('_'));

/**
 * One derivation case: what the provider supplied, and — carried alongside — the
 * trimmed local part of the address it returned, so the expectation never has to
 * split the address itself.
 */
interface DisplayNameCase {
  profileName: string | null | undefined;
  email: string | null | undefined;
  /** The local part after leading and trailing whitespace removal, by construction. */
  localPart: string;
}

const arbDisplayNameCase: fc.Arbitrary<DisplayNameCase> = fc.oneof(
  {
    weight: 9,
    arbitrary: fc
      .record({
        profileName: arbProfileNameCore,
        localPartCore: arbLocalPartCore,
        domain: fc.constantFrom('example.com', 'Example.COM', 'mail.test', 'sub.domain.example'),
        outerPad: arbEdgeWhitespace,
      })
      .map(({ profileName, localPartCore, domain, outerPad }) => ({
        profileName,
        // The address carries its own padding, since the derivation trims the
        // address before it takes the local part.
        email: `${outerPad}${localPartCore}@${domain}${outerPad}`,
        localPart: localPartCore.trim(),
      })),
  },
  {
    // Requirement 3.8 keeps an Account from being created without an address, so
    // an absent address is the documented guard path rather than a normal one —
    // it is generated only to hold the never-empty clause of the property.
    weight: 1,
    arbitrary: fc
      .record({
        profileName: arbProfileNameCore,
        email: fc.constantFrom<Array<string | null | undefined>>(null, undefined, '', '   '),
      })
      .map(({ profileName, email }) => ({ profileName, email, localPart: '' })),
  },
);

describe('display name derivation', () => {
  // Feature: user-auth-and-cloud-storage, Property 17: Display name derivation
  // trims, falls back, and truncates to 50.
  // **Validates: Requirements 3.3, 3.5**

  /** What the derivation returns when neither source yields a single character. */
  const guardValue = deriveDisplayName(null, null);

  it('takes the trimmed profile name, else the email local part, capped at 50 characters', () => {
    fc.assert(
      fc.property(arbDisplayNameCase, ({ profileName, email, localPart }) => {
        const derived = deriveDisplayName(profileName, email);

        // Requirement 3.3 selects the profile name exactly when its trimmed
        // value holds a character; Requirement 3.5 hands the rest to the local
        // part. `trim` is the criteria's own "leading and trailing whitespace
        // removed", so the model states which *source* wins and leaves the
        // truncation to the assertions below.
        const trimmedName = (profileName ?? '').trim();
        const source = trimmedName.length > 0 ? trimmedName : localPart;

        // Never empty, never over the cap, and never ill-formed — the three
        // invariants that hold whatever the inputs were.
        expect(derived).not.toBe('');
        expect(codePointsOf(derived).length).toBeLessThanOrEqual(DISPLAY_NAME_MAX_LENGTH);
        expect(hasLoneSurrogate(derived)).toBe(false);

        if (source === '') {
          // Neither source supplied a character. Compared against the value the
          // derivation itself produces for nothing at all, so the assertion
          // pins the behaviour without naming the fallback text.
          expect(derived).toBe(guardValue);
          return;
        }

        // "The first 50 characters of the source": a prefix of the chosen source
        // whose code point count is the source's, capped at 50. Those two facts
        // together identify the value uniquely, so the expectation does not have
        // to re-slice the source the way the implementation does.
        expect(source.startsWith(derived)).toBe(true);
        expect(codePointsOf(derived).length).toBe(
          Math.min(DISPLAY_NAME_MAX_LENGTH, codePointsOf(source).length),
        );

        // A source already inside the cap survives whole, so trimming is the
        // only edit a short name receives.
        if (codePointsOf(source).length <= DISPLAY_NAME_MAX_LENGTH) {
          expect(derived).toBe(source);
        }

        // Requirement 3.3 reads the address only as a fallback: while the
        // profile name holds a character, a different address cannot change the
        // result.
        if (trimmedName.length > 0) {
          expect(deriveDisplayName(profileName, 'someone.else@other.test')).toBe(derived);
        }
      }),
      { numRuns: 500 },
    );
  });
});
// ─── Property 15 ───────────────────────────────────────────────────────────────

/**
 * Property 15 has two halves, and they need different machinery:
 *
 * - **Validity is a function of age.** `isSessionActive` is pure once the clock
 *   and the stored start instant are supplied, so this half is a predicate over
 *   generated elapsed times, driven with `vi.useFakeTimers()` rather than by
 *   waiting. The 30-day figure is spelled out from Requirement 2.7 below rather
 *   than taken from the module, so a change to `SESSION_MAX_AGE_MS` cannot move
 *   the expectation along with the implementation.
 *
 * - **An invalid Session displays no records.** That is a statement about what
 *   the browser shows, so it drives the real `SessionProvider` together with the
 *   real `AccountMenu` — the component that owns the signin and signup controls —
 *   in jsdom. Only the Auth_Service boundary is replaced (`onAuthChange`,
 *   `signOutEverywhere`, `completeRedirectSignIn`); the 30-day check inside the
 *   provider stays real.
 *
 * The Auth_Service stub is installed with `vi.doMock` plus dynamic imports
 * instead of a hoisted `vi.mock`, so the properties above keep the unmocked
 * `@/lib/auth` they imported at the top of this file.
 */

/** Requirement 2.7's own figure: a Session stays valid for 30 days. */
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** The `AuthSession` shape, referenced without adding a top-level import. */
type Property15Session = import('@/lib/auth').AuthSession;

/** One row of the plan view: enough to count rows and key them. */
interface DisplayedPlan {
  readonly mealPlanId: string;
  readonly title: string;
}

/** The three endings Property 15 names for an already-populated plan view. */
type SessionEnding = 'signout' | 'signout-without-response' | 'expiry';

/** The callback the provider hands to `onAuthChange`. */
type Property15Emit = (session: Property15Session | null) => void;

/**
 * The stand-in for the Auth_Service, mutated per run: `emit` is the callback the
 * provider handed to `onAuthChange`, and `signOutResponds` false is the
 * Requirement 2.8 case where the signout request never comes back.
 */
const authServiceStub: {
  emit: Property15Emit | null;
  signOutResponds: boolean;
} = { emit: null, signOutResponds: true };

/**
 * Reads whichever callback the provider has registered.
 *
 * Written as a function rather than a direct property read: each run resets
 * `emit` to null before rendering, and TypeScript carries that narrowing across
 * the intervening `render`, so a direct read is typed `null` even though the
 * provider has assigned a callback by then.
 */
function currentEmit(): Property15Emit | null {
  return authServiceStub.emit;
}

interface Property15Modules {
  react: typeof import('react');
  rtl: typeof import('@testing-library/react');
  auth: typeof import('@/lib/auth');
  provider: typeof import('@/components/auth/SessionProvider');
  accountMenu: typeof import('@/components/auth/AccountMenu');
}

/**
 * A plan view of the shape the design prescribes for a consumer: it holds the
 * Meal_Plan_Records it fetched and discards them whenever `planViewEpoch`
 * changes, rather than inspecting the Session itself. Written as a factory so
 * React arrives through the dynamic import above.
 */
function buildPlanView(mods: Property15Modules) {
  const { createElement, useEffect, useState } = mods.react;
  const { useSession } = mods.provider;

  return function PlanView({ records }: { records: readonly DisplayedPlan[] }) {
    const { status, planViewEpoch } = useSession();
    const [displayed, setDisplayed] = useState<readonly DisplayedPlan[]>([]);

    // The clear signal: a raised epoch empties the view, whatever the Session
    // then turns out to be.
    useEffect(() => {
      setDisplayed([]);
    }, [planViewEpoch]);

    // The fetch a real list would perform once a Session is active.
    useEffect(() => {
      if (status === 'authenticated') setDisplayed(records);
    }, [status, records]);

    return createElement(
      'ul',
      null,
      displayed.map((plan) =>
        createElement('li', { key: plan.mealPlanId, 'data-testid': 'plan-row' }, plan.title),
      ),
    );
  };
}

/** Elapsed times swept across the 30-day bound, including a backwards clock. */
const arbElapsedMs = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.constantFrom(
      0,
      1,
      1_000,
      THIRTY_DAYS_MS - 1,
      THIRTY_DAYS_MS,
      THIRTY_DAYS_MS + 1,
      2 * THIRTY_DAYS_MS,
    ),
  },
  { weight: 4, arbitrary: fc.integer({ min: 0, max: THIRTY_DAYS_MS + 7 * 24 * 60 * 60 * 1000 }) },
  // A stored start instant in the future: a clock moved backwards, or a ledger
  // copied between machines.
  { weight: 2, arbitrary: fc.integer({ min: -3_600_000, max: -1 }) },
);

const arbSessionAgeCase = fc.record({
  startedAtMs: arbNowMs,
  otherStartedAtMs: arbNowMs,
  elapsedMs: arbElapsedMs,
  extraMs: fc.integer({ min: 0, max: 3 * THIRTY_DAYS_MS }),
});

/**
 * One populated plan view and the ending applied to it. Ages are drawn inside
 * and outside the bound respectively, so the active phase really is active and
 * the expiry really does elapse.
 */
const arbDisplayScenario = fc.record({
  titles: fc.array(arbTrickyString(1, 30), { minLength: 1, maxLength: 6 }),
  activeAgeMs: fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom(0, 1, THIRTY_DAYS_MS - 1) },
    { weight: 7, arbitrary: fc.integer({ min: 0, max: THIRTY_DAYS_MS - 1 }) },
  ),
  ending: fc.constantFrom<SessionEnding>('signout', 'signout-without-response', 'expiry'),
  expiredAgeMs: fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom(THIRTY_DAYS_MS, THIRTY_DAYS_MS + 1) },
    { weight: 7, arbitrary: fc.integer({ min: THIRTY_DAYS_MS, max: 3 * THIRTY_DAYS_MS }) },
  ),
});

/**
 * Loads the components under test against the Auth_Service stub.
 *
 * `vi.doMock` is not hoisted, so the modules that consult `@/lib/auth` have to
 * be imported after it — which is exactly why the stub does not reach the
 * statically imported `signIn` and `deriveDisplayName` the properties above use.
 * The mock is withdrawn immediately afterwards: the already-loaded provider
 * keeps the stub it closed over, and nothing else in this file is affected.
 */
const property15Modules: Property15Modules = await (async () => {
  vi.doMock('@/lib/auth', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/auth')>();
    return {
      ...actual,
      onAuthChange: (callback: (session: Property15Session | null) => void) => {
        authServiceStub.emit = callback;
        return () => {
          authServiceStub.emit = null;
        };
      },
      signOutEverywhere: async () => {
        // Requirement 2.8's "even when the Auth_Service returns no response":
        // a request that never settles.
        if (!authServiceStub.signOutResponds) await new Promise<void>(() => {});
      },
      completeRedirectSignIn: async () => null,
    };
  });

  const loaded: Property15Modules = {
    react: await import('react'),
    rtl: await import('@testing-library/react'),
    auth: await import('@/lib/auth'),
    provider: await import('@/components/auth/SessionProvider'),
    accountMenu: await import('@/components/auth/AccountMenu'),
  };
  vi.doUnmock('@/lib/auth');
  return loaded;
})();

describe('session validity as a function of age', () => {
  // Feature: user-auth-and-cloud-storage, Property 15: Session validity is a
  // function of age, and an invalid Session displays no records.
  // **Validates: Requirements 2.5, 2.7, 2.8, 2.13**

  const mods = property15Modules;

  it('treats a Session as active if and only if its age is under 30 days', () => {
    const { isSessionActive, readSessionStartedAt, writeSessionStartedAt, clearSessionStartedAt, SESSION_MAX_AGE_MS } =
      mods.auth;

    // The bound the module enforces is the one Requirement 2.7 states.
    expect(SESSION_MAX_AGE_MS).toBe(THIRTY_DAYS_MS);

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      fc.assert(
        fc.property(arbSessionAgeCase, ({ startedAtMs, otherStartedAtMs, elapsedMs, extraMs }) => {
          window.localStorage.clear();
          const nowMs = startedAtMs + elapsedMs;

          // The criterion itself: active exactly while the elapsed time since the
          // most recent successful authentication is under 30 days.
          const active = elapsedMs < THIRTY_DAYS_MS;
          expect(isSessionActive(nowMs, startedAtMs)).toBe(active);

          // A *function of age*: the same elapsed time measured from a different
          // instant gives the same answer, so no absolute date can change it.
          expect(isSessionActive(otherStartedAtMs + elapsedMs, otherStartedAtMs)).toBe(active);

          // Requirement 2.7 ends the Session when the 30 days elapse, so once
          // inactive it never becomes active again as time moves forward.
          if (!active) {
            expect(isSessionActive(nowMs + extraMs, startedAtMs)).toBe(false);
          }

          // The bound is at the day boundary itself, checked from both sides and
          // on it — just under is active (2.5), exactly at and just over are not
          // (2.13).
          expect(isSessionActive(startedAtMs + THIRTY_DAYS_MS - 1, startedAtMs)).toBe(true);
          expect(isSessionActive(startedAtMs + THIRTY_DAYS_MS, startedAtMs)).toBe(false);
          expect(isSessionActive(startedAtMs + THIRTY_DAYS_MS + 1, startedAtMs)).toBe(false);

          // The stored start instant is the one a reload reads, so the same
          // answer has to come back through storage and through the wall clock.
          writeSessionStartedAt(startedAtMs);
          expect(readSessionStartedAt()).toBe(startedAtMs);
          expect(isSessionActive(nowMs)).toBe(active);
          vi.setSystemTime(nowMs);
          expect(isSessionActive()).toBe(active);

          // With no stored start there is no Session to restore, whatever the
          // clock says.
          clearSessionStartedAt();
          expect(readSessionStartedAt()).toBeNull();
          expect(isSessionActive(nowMs)).toBe(false);
          expect(isSessionActive()).toBe(false);
        }),
        { numRuns: 500 },
      );
    } finally {
      vi.useRealTimers();
      window.localStorage.clear();
    }
  });

  it('leaves zero records displayed and the signin and signup controls visible after any ending', async () => {
    const { createElement, Fragment } = mods.react;
    const { act, cleanup, fireEvent, render, screen } = mods.rtl;
    const SessionProvider = mods.provider.default;
    const AccountMenu = mods.accountMenu.default;
    const PlanView = buildPlanView(mods);

    await fc.assert(
      fc.asyncProperty(arbDisplayScenario, async ({ titles, activeAgeMs, ending, expiredAgeMs }) => {
        window.localStorage.clear();
        authServiceStub.emit = null;
        authServiceStub.signOutResponds = ending !== 'signout-without-response';

        const records: readonly DisplayedPlan[] = titles.map((title, index) => ({
          mealPlanId: `plan-${index}`,
          title,
        }));

        const sessionStartedAt = (startedAtMs: number): Property15Session => ({
          userId: 'uid-property-15',
          displayName: 'Riley',
          email: 'riley@example.com',
          emailVerified: true,
          authTimeMs: startedAtMs,
          sessionStartedAtMs: startedAtMs,
        });

        try {
          render(
            createElement(
              SessionProvider,
              null,
              createElement(
                Fragment,
                null,
                createElement(PlanView, { records }),
                createElement(AccountMenu),
              ),
            ),
          );

          const emit = currentEmit();
          expect(emit).not.toBeNull();

          // A Session inside the 30 days is restored with the records displayed
          // (Requirement 2.5), which is the state the endings act on.
          await act(async () => emit!(sessionStartedAt(Date.now() - activeAgeMs)));
          expect(screen.queryAllByTestId('plan-row')).toHaveLength(records.length);
          expect(screen.getByRole('button', { name: 'Log Out' })).toBeInTheDocument();

          switch (ending) {
            case 'signout':
            case 'signout-without-response': {
              // Requirement 2.8 — the same assertions hold whether or not the
              // Auth_Service ever answers, because `signOutResponds` decides
              // only that.
              await act(async () => {
                fireEvent.click(screen.getByRole('button', { name: 'Log Out' }));
              });
              break;
            }
            case 'expiry': {
              // Requirement 2.13 — a stored Session whose 30 days have elapsed.
              await act(async () => emit!(sessionStartedAt(Date.now() - expiredAgeMs)));
              break;
            }
          }

          // Zero Meal_Plan_Records displayed, and the signin and signup controls
          // visible — for every one of the three endings.
          expect(screen.queryAllByTestId('plan-row')).toHaveLength(0);
          expect(screen.getByRole('button', { name: 'Log In' })).toBeInTheDocument();
          expect(screen.getByRole('button', { name: 'Sign Up' })).toBeInTheDocument();
          expect(screen.queryByRole('button', { name: 'Log Out' })).toBeNull();

          // The expiry message appears exactly when the Session ended on its own
          // (2.13), never for a Patient who signed out (2.8).
          if (ending === 'expiry') {
            expect(screen.getByRole('status')).toBeInTheDocument();
          } else {
            expect(screen.queryByRole('status')).toBeNull();
          }
        } finally {
          cleanup();
          window.localStorage.clear();
        }
      }),
      { numRuns: 30 },
    );
  });
});

// ─── Property 23 ───────────────────────────────────────────────────────────────

/**
 * Property 23 asks the same question of two subjects, because Requirement 3.10
 * spans both:
 *
 * - **The parse.** `parseConfiguredProviders` in `GoogleSignInButton.tsx` is where
 *   `NEXT_PUBLIC_AUTH_PROVIDERS` becomes a list of Identity_Providers, so the
 *   "exactly one per recognized configured provider, none for an unrecognized or
 *   absent one" clause is checked against that function directly.
 * - **The rendering.** The Auth_UI deliberately renders no password field:
 *   credentials are collected only by Cognito managed login. The second half
 *   renders the real `AuthModal` on both views and checks the managed-login
 *   controls against the deployment configuration.
 *
 * The expected provider list is never obtained by re-running the parse. Each
 * comma segment is generated together with the provider it names, so the
 * expectation is built by construction: a padded, case-varied provider name
 * resolves to that provider, and everything else — an unrelated name, a name with
 * an odd separator inside it, a blank — resolves to nothing.
 */

/** The `IdentityProviderId` union, referenced without adding a top-level import. */
type Property23ProviderId = import('@/components/auth/GoogleSignInButton').IdentityProviderId;

/**
 * The modules Property 23 drives. Loaded dynamically so this section stays
 * self-contained; no Auth_Service stub is installed, because nothing here
 * activates a provider control or submits the form.
 */
const property23Modules = await (async () => ({
  react: await import('react'),
  rtl: await import('@testing-library/react'),
  authModal: await import('@/components/AuthModal'),
  controls: await import('@/components/auth/GoogleSignInButton'),
}))();

/** The providers this build knows how to authenticate with. */
const RECOGNIZED_PROVIDERS: readonly Property23ProviderId[] =
  property23Modules.controls.RECOGNIZED_IDENTITY_PROVIDERS;

/**
 * The visible label of each recognized provider's control. Typed as a total
 * record over the union so adding a provider to the build fails to compile here
 * rather than silently leaving the new control unchecked.
 */
const PROVIDER_LABELS: Record<Property23ProviderId, string> = { google: 'Google' };

const escapeForRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Any social signin control, on either view: `Sign in with X` or `Sign up with X`. */
const PROVIDER_CONTROL_PATTERN = new RegExp(
  `^Sign (in|up) with (${RECOGNIZED_PROVIDERS.map((id) => escapeForRegExp(PROVIDER_LABELS[id])).join('|')})$`,
);

/** Names a deployment might put in the list that no build recognizes. */
const UNRELATED_PROVIDER_NAMES = ['facebook', 'apple', 'twitter', 'microsoft', 'okta'] as const;

/** Whitespace a hand-edited `.env` file leaves around an entry, plus none at all. */
const arbConfigPadding = fc.constantFrom('', ' ', '  ', '\t', '\n', ' \r\n ', '\u00a0');

/** The same name written the ways a deployment might capitalize it. */
function caseVariants(name: string): string[] {
  return [
    name,
    name.toUpperCase(),
    name.charAt(0).toUpperCase() + name.slice(1),
    Array.from(name)
      .map((char, index) => (index % 2 === 0 ? char.toUpperCase() : char))
      .join(''),
  ];
}

/**
 * Values built from a provider's name that still do not name it: two names run
 * together, a name joined to another by an odd separator, and a name with extra
 * characters. `NEXT_PUBLIC_AUTH_PROVIDERS` is comma-separated, so `google;google`
 * is one entry naming no provider rather than two entries naming one.
 */
function malformedVariants(name: string): string[] {
  return [
    `${name}${name}`,
    `${name}!`,
    `x${name}`,
    `${name};${name}`,
    `${name} ${name}`,
    `${name}|apple`,
    `${name}.com`,
    `"${name}"`,
    `${name}:1`,
    Array.from(name).join(' '),
  ];
}

/**
 * One comma segment of the configuration, carrying the provider it names — known
 * by construction, not by parsing it back.
 */
interface ConfigSegment {
  readonly text: string;
  /** The provider this segment names, or null when it names none. */
  readonly resolved: Property23ProviderId | null;
  /**
   * An unrecognized provider name this segment states outright, which must then
   * appear on no control. Null for a blank or a malformed variant, whose text
   * shares a substring with a recognized label and so cannot be searched for.
   */
  readonly absentName: string | null;
}

const arbRecognizedSegment: fc.Arbitrary<ConfigSegment> = fc
  .tuple(fc.constantFrom(...RECOGNIZED_PROVIDERS), fc.nat(), arbConfigPadding, arbConfigPadding)
  .map(([id, pick, before, after]) => {
    const variants = caseVariants(id);
    return {
      text: `${before}${variants[pick % variants.length]}${after}`,
      resolved: id,
      absentName: null,
    };
  });

const arbUnrelatedSegment: fc.Arbitrary<ConfigSegment> = fc
  .tuple(fc.constantFrom(...UNRELATED_PROVIDER_NAMES), fc.nat(), arbConfigPadding, arbConfigPadding)
  .map(([name, pick, before, after]) => {
    const variants = caseVariants(name);
    return {
      text: `${before}${variants[pick % variants.length]}${after}`,
      resolved: null,
      absentName: name,
    };
  });

const arbMalformedSegment: fc.Arbitrary<ConfigSegment> = fc
  .tuple(fc.constantFrom(...RECOGNIZED_PROVIDERS), fc.nat(), arbConfigPadding, arbConfigPadding)
  .map(([id, pick, before, after]) => {
    const variants = malformedVariants(id);
    return {
      text: `${before}${variants[pick % variants.length]}${after}`,
      resolved: null,
      absentName: null,
    };
  });

const arbBlankSegment: fc.Arbitrary<ConfigSegment> = arbConfigPadding.map((text) => ({
  text,
  resolved: null,
  absentName: null,
}));

const arbConfigSegment: fc.Arbitrary<ConfigSegment> = fc.oneof(
  // Recognized segments dominate, because a configuration that never names a
  // provider would leave the "exactly one control" clause unexercised. Duplicates
  // arise from this weighting rather than from a dedicated generator.
  { weight: 6, arbitrary: arbRecognizedSegment },
  { weight: 3, arbitrary: arbUnrelatedSegment },
  { weight: 3, arbitrary: arbMalformedSegment },
  { weight: 2, arbitrary: arbBlankSegment },
);

/** A whole configuration value, with the controls it must produce. */
interface ProviderConfigCase {
  /** The raw `NEXT_PUBLIC_AUTH_PROVIDERS` value; null or undefined when unset. */
  readonly raw: string | null | undefined;
  /** The providers named, in configuration order and without repeats. */
  readonly expected: Property23ProviderId[];
  /** Unrecognized provider names stated in the configuration. */
  readonly absentNames: string[];
}

const arbProviderConfigCase: fc.Arbitrary<ProviderConfigCase> = fc.oneof(
  {
    weight: 9,
    arbitrary: fc
      .record({
        segments: fc.array(arbConfigSegment, { minLength: 0, maxLength: 5 }),
        // Stray commas at the ends, which a hand-edited list collects.
        leadingComma: fc.boolean(),
        trailingComma: fc.boolean(),
      })
      .map(({ segments, leadingComma, trailingComma }) => {
        const texts = segments.map((segment) => segment.text);
        if (leadingComma) texts.unshift('');
        if (trailingComma) texts.push('');

        const expected: Property23ProviderId[] = [];
        for (const segment of segments) {
          if (segment.resolved !== null && !expected.includes(segment.resolved)) {
            expected.push(segment.resolved);
          }
        }

        return {
          raw: texts.join(','),
          expected,
          absentNames: segments.flatMap((segment) =>
            segment.absentName === null ? [] : [segment.absentName],
          ),
        };
      }),
  },
  {
    // The environment variable left unset, which is how a deployment turns social
    // signin off entirely (Requirement 3.10's zero-provider case).
    weight: 1,
    arbitrary: fc
      .constantFrom<Array<string | null | undefined>>(null, undefined)
      .map((raw) => ({ raw, expected: [], absentNames: [] })),
  },
);

describe('Identity_Provider controls mirror the Deployment_Configuration', () => {
  // Feature: user-auth-and-cloud-storage, Property 23: Identity_Provider controls
  // mirror the Deployment_Configuration.
  // **Validates: Requirements 3.1, 3.10**

  const { configuredIdentityProviders, parseConfiguredProviders } = property23Modules.controls;

  it('names each recognized configured provider exactly once and no other', () => {
    fc.assert(
      fc.property(arbProviderConfigCase, ({ raw, expected }) => {
        const parsed = parseConfiguredProviders(raw);

        // The list the criteria describe: one entry per recognized provider the
        // configuration names, in configuration order.
        expect(parsed).toEqual(expected);

        // Stated per provider as well, so a repeated or an unconfigured name
        // cannot hide inside a list that happens to have the right length.
        for (const id of RECOGNIZED_PROVIDERS) {
          expect(parsed.filter((entry) => entry === id)).toHaveLength(
            expected.includes(id) ? 1 : 0,
          );
        }

        // *Mirrors the Deployment_Configuration*: the same list arrives when the
        // value is read from the environment rather than passed in.
        vi.stubEnv('NEXT_PUBLIC_AUTH_PROVIDERS', raw ?? undefined);
        try {
          expect(configuredIdentityProviders()).toEqual(expected);
        } finally {
          vi.unstubAllEnvs();
        }
      }),
      { numRuns: 500 },
    );
  });

  it('renders one control per configured provider on both views without collecting credentials', async () => {
    const { createElement } = property23Modules.react;
    const { cleanup, render, screen } = property23Modules.rtl;
    const AuthModal = property23Modules.authModal.default;
    const noop = () => {};

    await fc.assert(
      fc.asyncProperty(
        arbProviderConfigCase,
        async ({ raw, expected, absentNames }) => {
          // Requirement 3.1 names the signin view and the signup view, so every
          // assertion below is made on both.
          for (const mode of ['login', 'signup'] as const) {
            vi.stubEnv('NEXT_PUBLIC_AUTH_PROVIDERS', raw ?? undefined);
            try {
              render(
                createElement(AuthModal, {
                  mode,
                  onClose: noop,
                  onSuccess: noop,
                  onSwitchMode: noop,
                }),
              );

              const verb = mode === 'signup' ? 'Sign up' : 'Sign in';

              // Exactly one control for each recognized provider the
              // configuration names, and none for one it does not.
              for (const id of RECOGNIZED_PROVIDERS) {
                const controls = screen.queryAllByRole('button', {
                  name: `${verb} with ${PROVIDER_LABELS[id]}`,
                });
                expect(controls).toHaveLength(expected.includes(id) ? 1 : 0);
                for (const control of controls) {
                  // Operable rather than decorative: a real button, not disabled.
                  expect(control.tagName).toBe('BUTTON');
                  expect(control).toBeEnabled();
                }
              }

              // No further social signin control beyond those, so a duplicated or
              // a malformed entry adds nothing.
              expect(screen.queryAllByRole('button', { name: PROVIDER_CONTROL_PATTERN })).toHaveLength(
                expected.length,
              );

              // An unrecognized name in the configuration produces no control at
              // all, rather than a dead one carrying that name.
              for (const name of absentNames) {
                expect(
                  screen.queryAllByRole('button', {
                    name: new RegExp(escapeForRegExp(name), 'i'),
                  }),
                ).toHaveLength(0);
              }

              // Passwords never enter the application UI. The primary control
              // sends the visitor to Cognito's managed authorization flow.
              expect(screen.queryByLabelText(/password/i)).toBeNull();
              const primaryLabel =
                mode === 'signup' ? 'Continue to create account' : 'Continue with email';
              expect(screen.getByRole('link', { name: primaryLabel })).toHaveAttribute(
                'href',
                `/api/auth/start?intent=${mode === 'signup' ? 'signup' : 'signin'}&returnTo=%2F`,
              );
              expect(
                screen.getByText(/never receives or stores it/i),
              ).toBeInTheDocument();
            } finally {
              cleanup();
              vi.unstubAllEnvs();
            }
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});
