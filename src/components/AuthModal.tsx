'use client';

/**
 * The account modal — the Website's signup, signin, and password reset surface.
 *
 * The behavior here is prescribed field by field, so the interesting parts of
 * this component are the ones that decide *what not to say*:
 *
 * - **Requirement 1.5** — a validation message appears for each submitted value
 *   that fails and for no other, which is why validation returns a per-field map
 *   rather than a single string.
 * - **Requirement 2.2** — a wrong email address and a wrong password collapse to
 *   one message that reveals neither which value was wrong nor whether the
 *   address is registered. `classifyAuthError` already folds three Firebase
 *   codes into `invalid-credentials`; this component must not un-fold them.
 * - **Requirements 2.9 and 2.10** — the password reset confirmation is byte-for-byte
 *   identical for a registered and an unregistered address, so it is one exported
 *   constant with no branch behind it.
 * - **Requirement 2.11** — a client-side validation failure sends no request at
 *   all, so every check runs before `signIn` is called and no failure is counted
 *   against the address.
 *
 * Field retention is equally deliberate. The entered display name and email are
 * kept on every failure; the password is cleared exactly where a requirement says
 * so (1.10, 2.2) and left alone for a validation message, where the Patient is
 * being asked to correct the value in front of them.
 *
 * Errors are classified by `err.code` through `classifyAuthError`, never by
 * substring-matching `err.message` as this component used to.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import GoogleSignInButton from '@/components/auth/GoogleSignInButton';
import {
  classifyAuthError,
  getSignInThrottleState,
  requestPasswordReset,
  signIn,
  signInLedgerKey,
  SignInThrottledError,
  signUp,
  type GoogleSignInOutcome,
} from '@/lib/auth';
import { evaluateThrottle, PASSWORD_RESET_RULE, recordAttempt } from '@/lib/throttle';

// ─── Field bounds (Requirement 1.1) ────────────────────────────────────────────

export const DISPLAY_NAME_MAX_LENGTH = 50;
export const EMAIL_MAX_LENGTH = 254;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/** Requirements 1.2, 1.10, 2.12 — the Auth_Service gets 10 seconds to answer. */
export const AUTH_REQUEST_TIMEOUT_MS = 10_000;

// ─── Messages ──────────────────────────────────────────────────────────────────

/** Requirement 1.5 — the only message when the display name alone fails. */
export const DISPLAY_NAME_MESSAGE = 'A display name of 1 to 50 characters is required.';

/** Requirements 1.9, 2.11 — the email address is absent or malformed. */
export const EMAIL_MESSAGE = 'A valid email address is required.';

/** Requirement 1.3 — the password is outside 8 to 128 characters. */
export const PASSWORD_MESSAGE = 'A password of 8 to 128 characters is required.';

/** Requirement 2.11 — the signin password field was left empty. */
export const PASSWORD_REQUIRED_MESSAGE = 'A password is required.';

/** Requirement 1.4 — already registered, with a signin offer beside it. */
export const EMAIL_REGISTERED_MESSAGE = 'That email address is already registered.';

/** Requirement 1.10 — creation timed out or failed for any other reason. */
export const SIGNUP_FAILED_MESSAGE =
  'Creating your account did not succeed. Please try again.';

/**
 * Requirement 2.2 — one message for a wrong address and a wrong password alike.
 * It names neither value and says nothing about whether the address is known.
 */
export const INVALID_CREDENTIALS_MESSAGE = 'The email address or password is incorrect.';

/** Requirement 2.12 — no response inside 10 seconds, or an unrelated failure. */
export const SIGNIN_UNAVAILABLE_MESSAGE =
  'Signing in is temporarily unavailable. Please try again in a moment.';

/** The deployment has no Auth_Service credentials, so no request can succeed. */
export const NOT_CONFIGURED_MESSAGE = 'Accounts are not available yet. Please try again later.';

/**
 * Requirements 2.9 and 2.10 — the identical confirmation for a registered and an
 * unregistered address. One constant, no branch, so the two cases cannot drift.
 */
export const PASSWORD_RESET_CONFIRMATION =
  'If an account exists for that email address, a password reset message is on its way.';

/** Requirement 2.3 — blocked, with the whole seconds remaining. */
export function signInBlockedMessage(secondsRemaining: number): string {
  const unit = secondsRemaining === 1 ? 'second' : 'seconds';
  return `Too many signin attempts. Try again in ${secondsRemaining} ${unit}.`;
}

/** The fallback block length when the Auth_Service reports no remaining time. */
const DEFAULT_BLOCK_SECONDS = 60;

// ─── Validation ────────────────────────────────────────────────────────────────

/**
 * The email address format check from Requirement 1.2, and nothing beyond it: at
 * most 254 characters, exactly one `@`, a non-empty local part, and a domain part
 * containing at least one `.`. Deliberately no stricter — a value the criterion
 * calls valid has to reach the Auth_Service, so extra rules here would contradict
 * the requirement rather than tighten it.
 */
export function isValidEmailAddress(value: string): boolean {
  if (value.length === 0 || value.length > EMAIL_MAX_LENGTH) return false;
  const at = value.indexOf('@');
  if (at <= 0) return false;
  if (value.indexOf('@', at + 1) !== -1) return false;
  return value.slice(at + 1).includes('.');
}

/** A message per failing field. An absent key means that field is fine. */
export interface FieldMessages {
  displayName?: string;
  email?: string;
  password?: string;
}

/** Requirements 1.3, 1.5, 1.9 — every signup bound, checked before any request. */
export function validateSignupFields(input: {
  displayName: string;
  email: string;
  password: string;
}): FieldMessages {
  const messages: FieldMessages = {};

  const trimmedName = input.displayName.trim();
  if (trimmedName.length === 0 || trimmedName.length > DISPLAY_NAME_MAX_LENGTH) {
    messages.displayName = DISPLAY_NAME_MESSAGE;
  }
  if (!isValidEmailAddress(input.email)) {
    messages.email = EMAIL_MESSAGE;
  }
  if (
    input.password.length < PASSWORD_MIN_LENGTH ||
    input.password.length > PASSWORD_MAX_LENGTH
  ) {
    messages.password = PASSWORD_MESSAGE;
  }

  return messages;
}

/**
 * Requirement 2.11 — an empty email field, an empty password field, or a
 * malformed address is a field-level message and no request. The password length
 * bounds are not applied on signin: an existing Account's password is whatever it
 * is, and checking it here would leak nothing useful and reject a valid attempt.
 */
export function validateSignInFields(input: { email: string; password: string }): FieldMessages {
  const messages: FieldMessages = {};
  if (!isValidEmailAddress(input.email)) {
    messages.email = EMAIL_MESSAGE;
  }
  if (input.password.length === 0) {
    messages.password = PASSWORD_REQUIRED_MESSAGE;
  }
  return messages;
}

// ─── Request timeout ───────────────────────────────────────────────────────────

const TIMED_OUT = Symbol('auth-request-timed-out');

/**
 * Races an Auth_Service call against the 10-second bound in Requirements 1.2 and
 * 2.12. The abandoned promise's later rejection is swallowed so it cannot surface
 * as an unhandled rejection after the timeout has been reported.
 */
async function withRequestTimeout<T>(work: Promise<T>): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), AUTH_REQUEST_TIMEOUT_MS);
  });
  try {
    const settled = await Promise.race([work, timeout]);
    if (settled === TIMED_OUT) {
      work.catch(() => undefined);
    }
    return settled;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ─── Password reset send ledger (Requirement 2.9) ──────────────────────────────

/**
 * localStorage key holding recent reset-send timestamps, keyed by a hash of the
 * address so the stored data never contains an email address — the same treatment
 * the signin failure ledger gets.
 */
export const PASSWORD_RESET_SENDS_KEY = 'crohnsBuddy.passwordResetSends';

type SendLedger = Record<string, number[]>;

function readSendLedger(): SendLedger {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(PASSWORD_RESET_SENDS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const ledger: SendLedger = {};
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

function writeSendLedger(ledger: SendLedger): void {
  if (typeof window === 'undefined') return;
  try {
    const pruned = Object.fromEntries(
      Object.entries(ledger).filter(([, sends]) => sends.length > 0)
    );
    window.localStorage.setItem(PASSWORD_RESET_SENDS_KEY, JSON.stringify(pruned));
  } catch {
    // Storage denied. The gate then admits the send, which is the safe
    // direction: Firebase applies its own limit on top of this one.
  }
}

/**
 * Whether a reset message may be sent for `email` now, recording the send when it
 * may. Past 3 sends inside 60 minutes nothing goes out — and the Patient still
 * sees the same confirmation, because a message that changed once the limit was
 * reached would be a channel for telling a stranger that an address is in use.
 */
async function admitResetSend(email: string, nowMs: number = Date.now()): Promise<boolean> {
  const key = await signInLedgerKey(email);
  const ledger = readSendLedger();
  const decision = evaluateThrottle(ledger[key] ?? [], nowMs, PASSWORD_RESET_RULE);
  if (!decision.allowed) {
    ledger[key] = decision.attempts;
    writeSendLedger(ledger);
    return false;
  }
  ledger[key] = recordAttempt(decision.attempts, nowMs, PASSWORD_RESET_RULE);
  writeSendLedger(ledger);
  return true;
}

// ─── Component ─────────────────────────────────────────────────────────────────

export interface AuthModalProps {
  mode: 'login' | 'signup';
  onClose: () => void;
  onSuccess: () => void;
  onSwitchMode: () => void;
  /**
   * The outcome of a redirect-based Identity_Provider sign-in reconciled by
   * `SessionProvider`, passed through to the social controls. It arrives as a
   * prop rather than being read from the Session context so this modal stays
   * usable outside a `SessionProvider`.
   */
  redirectOutcome?: GoogleSignInOutcome | null;
  onRedirectOutcomeHandled?: () => void;
}

const INPUT_CLASS =
  'w-full px-4 py-3 bg-transparent border border-brand-800/15 rounded-sm text-sm text-brand-800 placeholder:text-brand-800/30 focus:outline-none focus:border-brand-400 transition-colors duration-200';

const LABEL_CLASS = 'block text-xs uppercase tracking-widest text-brand-800/50 mb-2';

export default function AuthModal({
  mode,
  onClose,
  onSuccess,
  onSwitchMode,
  redirectOutcome = null,
  onRedirectOutcomeHandled,
}: AuthModalProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');

  const [fieldMessages, setFieldMessages] = useState<FieldMessages>({});
  const [formMessage, setFormMessage] = useState<string | null>(null);
  /** Requirement 1.4 — the message carries a signin offer, so it is its own state. */
  const [emailRegistered, setEmailRegistered] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resetView, setResetView] = useState(false);

  /** Requirement 2.3 — when the block lifts, and the countdown derived from it. */
  const [blockedUntilMs, setBlockedUntilMs] = useState<number | null>(null);
  const [secondsRemaining, setSecondsRemaining] = useState(0);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The countdown ticks once a second and clears itself the instant it reaches
  // zero, so the submit control re-enables without another submission.
  useEffect(() => {
    if (blockedUntilMs === null) return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((blockedUntilMs - Date.now()) / 1000));
      setSecondsRemaining(left);
      if (left === 0) setBlockedUntilMs(null);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [blockedUntilMs]);

  const blockFor = useCallback((seconds: number) => {
    const clamped = seconds > 0 ? seconds : DEFAULT_BLOCK_SECONDS;
    setSecondsRemaining(clamped);
    setBlockedUntilMs(Date.now() + clamped * 1000);
  }, []);

  const clearMessages = useCallback(() => {
    setFieldMessages({});
    setFormMessage(null);
    setEmailRegistered(false);
    setNotice(null);
  }, []);

  // ─── Signup (Requirement 1) ──────────────────────────────────────────────────

  const submitSignup = useCallback(async () => {
    const messages = validateSignupFields({ displayName, email, password });
    if (Object.keys(messages).length > 0) {
      // No Account is created and every entered value stays as it is: the
      // Patient is being asked to correct what is in front of them.
      setFieldMessages(messages);
      return;
    }

    setSubmitting(true);
    try {
      const settled = await withRequestTimeout(signUp(email, password, displayName.trim()));
      if (!mounted.current) return;
      if (settled === TIMED_OUT) {
        // Requirement 1.10 — name and email retained, password cleared.
        setFormMessage(SIGNUP_FAILED_MESSAGE);
        setPassword('');
        return;
      }
      // Requirement 1.11 — the modal closes with no validation message.
      onSuccess();
    } catch (err) {
      if (!mounted.current) return;
      switch (classifyAuthError(err)) {
        case 'email-already-in-use':
          // Requirement 1.4 — name and email retained, signin offered.
          setEmailRegistered(true);
          break;
        case 'weak-password':
          // Requirement 1.3 — name and email retained.
          setFieldMessages({ password: PASSWORD_MESSAGE });
          break;
        case 'invalid-email':
          // Requirement 1.9 — display name retained.
          setFieldMessages({ email: EMAIL_MESSAGE });
          break;
        case 'not-configured':
          setFormMessage(NOT_CONFIGURED_MESSAGE);
          setPassword('');
          break;
        default:
          // Requirement 1.10 — name and email retained, password cleared.
          setFormMessage(SIGNUP_FAILED_MESSAGE);
          setPassword('');
      }
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  }, [displayName, email, password, onSuccess]);

  // ─── Signin (Requirement 2) ──────────────────────────────────────────────────

  const submitSignIn = useCallback(async () => {
    const messages = validateSignInFields({ email, password });
    if (Object.keys(messages).length > 0) {
      // Requirement 2.11 — no request reaches the Auth_Service and no failure is
      // counted against the address.
      setFieldMessages(messages);
      return;
    }

    setSubmitting(true);
    try {
      const settled = await withRequestTimeout(signIn(email, password));
      if (!mounted.current) return;
      if (settled === TIMED_OUT) {
        // Requirement 2.12 — email retained, still unauthenticated, nothing counted.
        setFormMessage(SIGNIN_UNAVAILABLE_MESSAGE);
        setPassword('');
        return;
      }
      onSuccess();
    } catch (err) {
      if (!mounted.current) return;
      const kind = classifyAuthError(err);

      if (kind === 'too-many-requests') {
        // Requirement 2.3 — blocked, with the seconds remaining.
        const seconds =
          err instanceof SignInThrottledError
            ? err.retryAfterSeconds
            : (await getSignInThrottleState(email)).retryAfterSeconds;
        if (!mounted.current) return;
        blockFor(seconds);
        setPassword('');
        return;
      }

      if (kind === 'invalid-credentials') {
        // Requirement 2.2 — one message, email retained, password cleared.
        setFormMessage(INVALID_CREDENTIALS_MESSAGE);
        setPassword('');
        // That rejection may have been the one that reached the limit, in which
        // case the countdown belongs on screen now rather than on the next try.
        const state = await getSignInThrottleState(email);
        if (mounted.current && !state.allowed) {
          blockFor(state.retryAfterSeconds);
        }
        return;
      }

      if (kind === 'not-configured') {
        setFormMessage(NOT_CONFIGURED_MESSAGE);
        setPassword('');
        return;
      }

      // Requirement 2.12 — unrelated to the submitted credentials.
      setFormMessage(SIGNIN_UNAVAILABLE_MESSAGE);
      setPassword('');
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  }, [email, password, onSuccess, blockFor]);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting || blockedUntilMs !== null) return;
    clearMessages();
    void (mode === 'signup' ? submitSignup() : submitSignIn());
  };

  // ─── Password reset (Requirements 2.9, 2.10) ─────────────────────────────────

  const submitPasswordReset = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (submitting) return;
      clearMessages();

      if (!isValidEmailAddress(email)) {
        setFieldMessages({ email: EMAIL_MESSAGE });
        return;
      }

      setSubmitting(true);
      try {
        if (await admitResetSend(email)) {
          await withRequestTimeout(requestPasswordReset(email));
        }
        if (!mounted.current) return;
        // `requestPasswordReset` swallows `user-not-found`, so a registered and
        // an unregistered address arrive here identically.
        setNotice(PASSWORD_RESET_CONFIRMATION);
      } catch (err) {
        if (!mounted.current) return;
        switch (classifyAuthError(err)) {
          case 'invalid-email':
            setFieldMessages({ email: EMAIL_MESSAGE });
            break;
          case 'not-configured':
            setFormMessage(NOT_CONFIGURED_MESSAGE);
            break;
          default:
            setFormMessage(SIGNIN_UNAVAILABLE_MESSAGE);
        }
      } finally {
        if (mounted.current) setSubmitting(false);
      }
    },
    [email, submitting, clearMessages]
  );

  // ─── Identity_Provider outcomes (Requirement 3) ──────────────────────────────

  const handleProviderOutcome = useCallback(
    (outcome: GoogleSignInOutcome) => {
      if (outcome.status === 'signed-in') {
        onSuccess();
        return;
      }
      // Every other outcome renders its own message inside the control, and the
      // email and password fields stay enabled (Requirement 3.7).
      clearMessages();
    },
    [onSuccess, clearMessages]
  );

  // ─── Rendering ───────────────────────────────────────────────────────────────

  const isSignup = mode === 'signup';
  const blocked = blockedUntilMs !== null;
  const heading = resetView ? 'Reset Password' : isSignup ? 'Create Account' : 'Log In';

  /**
   * Requirements 1.8 and 12.2 — the Privacy_Notice link sits inside the form
   * itself, unconditionally, so it is present on the initial view and still
   * present after any validation message. `/privacy` is readable with no Session.
   */
  const privacyLink = (
    <p className="text-xs text-brand-800/50">
      <a
        href="/privacy"
        className="underline hover:opacity-70 transition-opacity duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 rounded-sm"
      >
        Privacy Notice
      </a>
      {' — what we store and how to remove it.'}
    </p>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-brand-800/40">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-modal-heading"
        className="bg-brand-50 w-full max-w-sm mx-4 p-10 relative border border-brand-800/10 rounded-sm max-h-[90vh] overflow-y-auto"
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 text-brand-800/40 hover:text-brand-800 text-lg transition-opacity duration-200"
          aria-label="Close"
        >
          ×
        </button>

        <p className="text-xs uppercase tracking-widest text-brand-400 mb-2">
          {resetView ? 'Password help' : isSignup ? 'Get started' : 'Welcome back'}
        </p>
        <h2 id="auth-modal-heading" className="text-xl mb-8">
          {heading}
        </h2>

        {resetView ? (
          <form onSubmit={submitPasswordReset} noValidate className="space-y-5">
            <div>
              <label htmlFor="auth-reset-email" className={LABEL_CLASS}>
                Email <span aria-hidden="true">*</span>
              </label>
              <input
                id="auth-reset-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                aria-required="true"
                maxLength={EMAIL_MAX_LENGTH}
                aria-invalid={fieldMessages.email !== undefined}
                aria-describedby={fieldMessages.email ? 'auth-reset-email-error' : undefined}
                className={INPUT_CLASS}
              />
              {fieldMessages.email && (
                <p id="auth-reset-email-error" role="alert" className="mt-2 text-sm text-red-700/80">
                  {fieldMessages.email}
                </p>
              )}
            </div>

            {formMessage && (
              <p role="alert" className="text-sm text-red-700/80">
                {formMessage}
              </p>
            )}
            {notice && (
              <p role="status" className="text-sm text-brand-800/70">
                {notice}
              </p>
            )}

            <button type="submit" disabled={submitting} className="w-full btn-primary mt-2">
              {submitting ? 'Please wait...' : 'Send Reset Link'}
            </button>

            {privacyLink}

            <p className="text-xs text-brand-800/40">
              <button
                type="button"
                onClick={() => {
                  clearMessages();
                  setResetView(false);
                }}
                className="text-brand-400 hover:opacity-70 transition-opacity duration-200"
              >
                Back to log in
              </button>
            </p>
          </form>
        ) : (
          <>
            <form onSubmit={handleSubmit} noValidate className="space-y-5">
              {isSignup && (
                <div>
                  <label htmlFor="auth-name" className={LABEL_CLASS}>
                    Name <span aria-hidden="true">*</span>
                  </label>
                  <input
                    id="auth-name"
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Your name"
                    required
                    aria-required="true"
                    maxLength={DISPLAY_NAME_MAX_LENGTH}
                    aria-invalid={fieldMessages.displayName !== undefined}
                    aria-describedby={
                      fieldMessages.displayName ? 'auth-name-error' : undefined
                    }
                    className={INPUT_CLASS}
                  />
                  {fieldMessages.displayName && (
                    <p id="auth-name-error" role="alert" className="mt-2 text-sm text-red-700/80">
                      {fieldMessages.displayName}
                    </p>
                  )}
                </div>
              )}

              <div>
                <label htmlFor="auth-email" className={LABEL_CLASS}>
                  Email <span aria-hidden="true">*</span>
                </label>
                <input
                  id="auth-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                  aria-required="true"
                  maxLength={EMAIL_MAX_LENGTH}
                  aria-invalid={fieldMessages.email !== undefined || emailRegistered}
                  aria-describedby={
                    fieldMessages.email
                      ? 'auth-email-error'
                      : emailRegistered
                        ? 'auth-email-registered'
                        : undefined
                  }
                  className={INPUT_CLASS}
                />
                {fieldMessages.email && (
                  <p id="auth-email-error" role="alert" className="mt-2 text-sm text-red-700/80">
                    {fieldMessages.email}
                  </p>
                )}
                {emailRegistered && (
                  <p
                    id="auth-email-registered"
                    role="alert"
                    className="mt-2 text-sm text-red-700/80"
                  >
                    {EMAIL_REGISTERED_MESSAGE}{' '}
                    <button
                      type="button"
                      onClick={() => {
                        // The entered name and email survive the switch: this
                        // component stays mounted and only `mode` changes.
                        clearMessages();
                        onSwitchMode();
                      }}
                      className="text-brand-400 underline hover:opacity-70 transition-opacity duration-200"
                    >
                      Log in instead
                    </button>
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="auth-password" className={LABEL_CLASS}>
                  Password <span aria-hidden="true">*</span>
                </label>
                <input
                  id="auth-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={isSignup ? 'At least 8 characters' : 'Your password'}
                  required
                  aria-required="true"
                  maxLength={PASSWORD_MAX_LENGTH}
                  aria-invalid={fieldMessages.password !== undefined}
                  aria-describedby={
                    fieldMessages.password ? 'auth-password-error' : undefined
                  }
                  className={INPUT_CLASS}
                />
                {fieldMessages.password && (
                  <p id="auth-password-error" role="alert" className="mt-2 text-sm text-red-700/80">
                    {fieldMessages.password}
                  </p>
                )}
              </div>

              {formMessage && (
                <p role="alert" className="text-sm text-red-700/80">
                  {formMessage}
                </p>
              )}

              {blocked && (
                <p role="alert" className="text-sm text-red-700/80">
                  {signInBlockedMessage(secondsRemaining)}
                </p>
              )}

              <button
                type="submit"
                disabled={submitting || blocked}
                className="w-full btn-primary mt-2"
              >
                {submitting ? 'Please wait...' : isSignup ? 'Sign Up' : 'Log In'}
              </button>

              {privacyLink}
            </form>

            {!isSignup && (
              <p className="text-xs text-brand-800/40 mt-4">
                <button
                  type="button"
                  onClick={() => {
                    clearMessages();
                    setResetView(true);
                  }}
                  className="text-brand-400 hover:opacity-70 transition-opacity duration-200"
                >
                  Forgot your password?
                </button>
              </p>
            )}

            {/* Requirement 3.1 — the provider controls appear on both views. */}
            <GoogleSignInButton
              intent={isSignup ? 'signup' : 'signin'}
              redirectOutcome={redirectOutcome}
              onRedirectOutcomeHandled={onRedirectOutcomeHandled}
              onOutcome={handleProviderOutcome}
              className="mt-6 space-y-3"
            />

            <p className="text-xs text-brand-800/40 mt-6">
              {isSignup ? 'Already have an account? ' : "Don't have an account? "}
              <button
                type="button"
                onClick={() => {
                  clearMessages();
                  onSwitchMode();
                }}
                className="text-brand-400 hover:opacity-70 transition-opacity duration-200"
              >
                {isSignup ? 'Log In' : 'Sign Up'}
              </button>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
