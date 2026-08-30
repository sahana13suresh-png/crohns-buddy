'use client';

/**
 * The pending-verification indicator for a signed-in Account.
 *
 * **Requirement 1.7** — while a Session belongs to an Account whose email
 * address is unverified, the Auth_UI shows an indicator that the address awaits
 * verification and offers a control that resends the verification message at
 * most once per 60 seconds for that Account, showing a message that names when
 * the next resend becomes available for a request made inside that interval.
 *
 * Three things are worth stating about how that is done here.
 *
 * The 60-second rule is the shared sliding-window predicate from
 * `src/lib/throttle.ts` under `VERIFICATION_RESEND_RULE`, not a second timer.
 * The predicate is pure, so the ledger of send timestamps lives here, in
 * localStorage keyed by User_Id. Keying by User_Id rather than by email address
 * is deliberate for two reasons: the rule is stated per Account, and it keeps an
 * email address out of browser storage — the same treatment the signin failure
 * and password reset ledgers get. Persisting the ledger is what makes the rule
 * hold across a reload; component state alone would reset the interval on every
 * page load.
 *
 * The control stays operable while the interval is running. Disabling it would
 * make a request inside the interval impossible, and then the message the
 * requirement asks for could never appear. So a request made inside the interval
 * is admitted by the UI, refused by the predicate, and answered with the
 * remaining whole seconds — rendered the way `AuthModal` renders its throttle
 * countdown, as an exact whole-second ceiling that ticks down once a second.
 *
 * A send that fails discharges the recorded attempt, so the Patient can try
 * again straight away. Nothing reached the Auth_Service, so nothing was resent,
 * and holding the interval against a message that never went out would be a
 * 60-second penalty for a transport fault.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from '@/components/auth/SessionProvider';
import { classifyAuthError, sendVerificationEmail } from '@/lib/auth';
import { evaluateThrottle, recordAttempt, VERIFICATION_RESEND_RULE } from '@/lib/throttle';

// ─── Messages ──────────────────────────────────────────────────────────────────

/** Requirement 1.7 — the indicator itself. */
export const PENDING_VERIFICATION_MESSAGE =
  'Your email address awaits verification. Open the link in the message we sent to finish confirming it.';

/** Requirement 1.7 — when the next resend becomes available. */
export function nextResendMessage(secondsRemaining: number): string {
  const unit = secondsRemaining === 1 ? 'second' : 'seconds';
  return `Another verification email can be sent in ${secondsRemaining} ${unit}.`;
}

export const VERIFICATION_SENT_MESSAGE = 'Verification email sent. Check your inbox.';

export const RESEND_FAILED_MESSAGE =
  'Sending the verification email did not succeed. Please try again.';

/** The Auth_Service applies its own limit on top of the 60-second rule. */
export const RESEND_RATE_LIMITED_MESSAGE =
  'Too many verification emails have been requested. Please try again later.';

function messageForResendFailure(err: unknown): string {
  return classifyAuthError(err) === 'too-many-requests'
    ? RESEND_RATE_LIMITED_MESSAGE
    : RESEND_FAILED_MESSAGE;
}

// ─── Resend ledger (Requirement 1.7) ───────────────────────────────────────────

/** localStorage key holding recent resend timestamps, keyed by User_Id. */
export const VERIFICATION_RESENDS_KEY = 'crohnsBuddy.verificationResends';

type ResendLedger = Record<string, number[]>;

function readLedger(): ResendLedger {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(VERIFICATION_RESENDS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const ledger: ResendLedger = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        ledger[key] = value.filter(
          (at): at is number => typeof at === 'number' && Number.isFinite(at)
        );
      }
    }
    return ledger;
  } catch {
    return {};
  }
}

function writeLedger(ledger: ResendLedger): void {
  if (typeof window === 'undefined') return;
  try {
    const pruned = Object.fromEntries(
      Object.entries(ledger).filter(([, sends]) => sends.length > 0)
    );
    window.localStorage.setItem(VERIFICATION_RESENDS_KEY, JSON.stringify(pruned));
  } catch {
    // Storage denied. The gate then admits the resend, which is the safe
    // direction: the Auth_Service applies its own limit on top of this one.
  }
}

function storeAttempts(userId: string, attempts: number[]): void {
  const ledger = readLedger();
  ledger[userId] = attempts;
  writeLedger(ledger);
}

// ─── Component ─────────────────────────────────────────────────────────────────

const BUTTON_CLASS =
  'text-xs uppercase tracking-widest text-brand-800 underline underline-offset-4 hover:opacity-70 transition-opacity duration-200 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 disabled:opacity-60 disabled:cursor-not-allowed';

export default function EmailVerificationBanner() {
  const { session, status } = useSession();
  const userId = session?.userId ?? null;
  const awaitingVerification =
    status === 'authenticated' && session !== null && !session.emailVerified;

  /** When the next resend becomes available, and the countdown derived from it. */
  const [nextResendAtMs, setNextResendAtMs] = useState<number | null>(null);
  const [secondsRemaining, setSecondsRemaining] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Seeded from the stored ledger, so an interval already running survives a
  // reload instead of restarting at zero.
  useEffect(() => {
    if (!awaitingVerification || userId === null) {
      setNextResendAtMs(null);
      setSecondsRemaining(0);
      return;
    }
    const nowMs = Date.now();
    const decision = evaluateThrottle(
      readLedger()[userId] ?? [],
      nowMs,
      VERIFICATION_RESEND_RULE
    );
    setNextResendAtMs(decision.allowed ? null : nowMs + decision.retryAfterSeconds * 1000);
    setSecondsRemaining(decision.allowed ? 0 : decision.retryAfterSeconds);
  }, [awaitingVerification, userId]);

  // The countdown ticks once a second and clears itself the instant it reaches
  // zero, matching how `AuthModal` runs its throttle countdown.
  useEffect(() => {
    if (nextResendAtMs === null) return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((nextResendAtMs - Date.now()) / 1000));
      setSecondsRemaining(left);
      if (left === 0) setNextResendAtMs(null);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [nextResendAtMs]);

  const handleResend = useCallback(async () => {
    if (userId === null || sending) return;

    setNotice(null);
    setErrorMessage(null);

    const nowMs = Date.now();
    const decision = evaluateThrottle(readLedger()[userId] ?? [], nowMs, VERIFICATION_RESEND_RULE);

    if (!decision.allowed) {
      // Requirement 1.7 — a request inside the interval sends nothing and is
      // answered with when the next resend becomes available.
      storeAttempts(userId, decision.attempts);
      setSecondsRemaining(decision.retryAfterSeconds);
      setNextResendAtMs(nowMs + decision.retryAfterSeconds * 1000);
      return;
    }

    // Recorded before the request goes out, so a second activation while the
    // first is in flight is refused by the predicate rather than by a spinner.
    const recorded = recordAttempt(decision.attempts, nowMs, VERIFICATION_RESEND_RULE);
    storeAttempts(userId, recorded);
    setSecondsRemaining(VERIFICATION_RESEND_RULE.windowMs / 1000);
    setNextResendAtMs(nowMs + VERIFICATION_RESEND_RULE.windowMs);
    setSending(true);

    try {
      await sendVerificationEmail();
      if (!mounted.current) return;
      setNotice(VERIFICATION_SENT_MESSAGE);
    } catch (err) {
      // Nothing was resent, so the interval is discharged and the Patient may
      // retry immediately.
      storeAttempts(userId, decision.attempts);
      if (!mounted.current) return;
      setNextResendAtMs(null);
      setSecondsRemaining(0);
      setErrorMessage(messageForResendFailure(err));
    } finally {
      if (mounted.current) setSending(false);
    }
  }, [sending, userId]);

  if (!awaitingVerification) return null;

  const statusText = [notice, secondsRemaining > 0 ? nextResendMessage(secondsRemaining) : null]
    .filter((part): part is string => part !== null)
    .join(' ');

  return (
    <section
      aria-label="Email verification"
      className="border-b border-brand-800/10 bg-brand-400/10"
    >
      <div className="max-w-7xl mx-auto px-6 md:px-12 py-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="text-sm text-brand-800/80">{PENDING_VERIFICATION_MESSAGE}</p>

        <button type="button" onClick={() => void handleResend()} disabled={sending} className={BUTTON_CLASS}>
          {sending ? 'Sending…' : 'Resend verification email'}
        </button>

        {/* One live region for both the confirmation and the countdown, so a
            screen reader hears a single coherent update. */}
        <p role="status" className="text-sm text-brand-800/60 basis-full">
          {statusText}
        </p>

        {errorMessage !== null && (
          <p role="alert" className="text-sm text-red-700/80 basis-full">
            {errorMessage}
          </p>
        )}
      </div>
    </section>
  );
}
