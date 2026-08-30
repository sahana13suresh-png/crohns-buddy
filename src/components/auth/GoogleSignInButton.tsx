'use client';

/**
 * The Website's social signin controls.
 *
 * Requirement 3.10 makes the rendered set of controls a function of the
 * Deployment_Configuration rather than of the component: `NEXT_PUBLIC_AUTH_PROVIDERS`
 * is a comma-separated list (e.g. `google`), and an empty or absent value renders
 * zero controls while the Cognito email flow remains available. Requirement
 * 3.1 asks for *exactly one* control per configured Identity_Provider on both the
 * signin and the signup view, operable by pointer and by keyboard — so the control
 * is a plain `<button type="button">` with its label as visible text, and the
 * configured list is de-duplicated before rendering.
 *
 * The four provider outcomes each map to one message, taken straight from the
 * `GoogleSignInOutcome` union `signInWithGoogle` returns:
 *
 * - `cancelled` (3.6) — no message at all, since the Patient chose to stop.
 * - `failed` (3.7) — provider signin did not succeed; the Cognito email flow remains usable.
 * - `no-email` (3.8) — an address is required to continue.
 * - `timed-out` (3.9) — the attempt can be retried.
 *
 * The 120-second bound in 3.9 is enforced inside `auth.ts`, not here, so this
 * component holds no timer: it renders whichever outcome it is handed.
 *
 * A redirect-based attempt (the fallback for a blocked popup) unloads the page, so
 * its outcome is reconciled by `SessionProvider` and passed back in through
 * `redirectOutcome`. It arrives as a prop rather than being read from the Session
 * context so this component stays usable outside a `SessionProvider` — the forum's
 * signin prompt is one such place.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { signInWithGoogle, type GoogleSignInOutcome } from '@/lib/auth';

// ─── Configured providers ──────────────────────────────────────────────────────

/** Identity_Providers this build knows how to authenticate with. */
export const RECOGNIZED_IDENTITY_PROVIDERS = ['google'] as const;

export type IdentityProviderId = (typeof RECOGNIZED_IDENTITY_PROVIDERS)[number];

function isRecognizedProvider(name: string): name is IdentityProviderId {
  return (RECOGNIZED_IDENTITY_PROVIDERS as readonly string[]).includes(name);
}

/**
 * The recognized Identity_Providers named by a raw configuration value, in
 * configuration order and without repeats. Unrecognized names are dropped rather
 * than rendered as a dead control, and an absent, empty, or whitespace-only value
 * yields the empty list (Requirement 3.10).
 */
export function parseConfiguredProviders(raw: string | null | undefined): IdentityProviderId[] {
  if (typeof raw !== 'string') return [];

  const ordered: IdentityProviderId[] = [];
  for (const entry of raw.split(',')) {
    const name = entry.trim().toLowerCase();
    if (isRecognizedProvider(name) && !ordered.includes(name)) {
      ordered.push(name);
    }
  }
  return ordered;
}

/** The configured Identity_Providers for this deployment. */
export function configuredIdentityProviders(): IdentityProviderId[] {
  return parseConfiguredProviders(process.env.NEXT_PUBLIC_AUTH_PROVIDERS);
}

// ─── Outcome messages ──────────────────────────────────────────────────────────

/** Requirement 3.9 — timed out, and retryable. */
export const PROVIDER_TIMED_OUT_MESSAGE = 'Google sign-in took too long. Please try again.';

/** Requirement 3.8 — authentication completed but returned no email address. */
export const PROVIDER_NO_EMAIL_MESSAGE =
  'Google did not share an email address, which is required to continue.';

/** Requirement 3.7 — the provider reported a failure. */
export const PROVIDER_FAILED_MESSAGE =
  'Google sign-in failed. Please try again, or continue with email.';

/**
 * The message for an outcome, or null when there is nothing to say: a signed-in
 * Patient needs no message, and a cancellation must produce none (Requirement 3.6).
 */
export function messageForProviderOutcome(outcome: GoogleSignInOutcome): string | null {
  switch (outcome.status) {
    case 'signed-in':
    case 'cancelled':
      return null;
    case 'timed-out':
      return PROVIDER_TIMED_OUT_MESSAGE;
    case 'no-email':
      return PROVIDER_NO_EMAIL_MESSAGE;
    default:
      return PROVIDER_FAILED_MESSAGE;
  }
}

// ─── Provider presentation ─────────────────────────────────────────────────────

const PROVIDER_NAMES: Record<IdentityProviderId, string> = { google: 'Google' };

/** Google's mark, decorative: the button's visible text carries the label. */
function GoogleMark(): ReactElement {
  return (
    <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}

const PROVIDER_MARKS: Record<IdentityProviderId, () => ReactElement> = { google: GoogleMark };

/** The authentication call for a provider. One entry per recognized provider. */
const PROVIDER_SIGN_IN: Record<IdentityProviderId, () => Promise<GoogleSignInOutcome>> = {
  google: signInWithGoogle,
};

// ─── Component ─────────────────────────────────────────────────────────────────

export interface GoogleSignInButtonProps {
  /**
   * Raw provider configuration. Defaults to `NEXT_PUBLIC_AUTH_PROVIDERS`; passing
   * it explicitly lets a caller — or a test — drive the rendered set directly.
   */
  providers?: string | null;
  /** Wording only: `Sign in with Google` versus `Sign up with Google` (3.1). */
  intent?: 'signin' | 'signup';
  /**
   * The outcome of a redirect-based attempt reconciled on mount, or null when this
   * load is not a return from the provider. Its message is rendered here and
   * `onRedirectOutcomeHandled` is called so the outcome is reported only once.
   */
  redirectOutcome?: GoogleSignInOutcome | null;
  onRedirectOutcomeHandled?: () => void;
  /**
   * Every outcome, after its message is rendered, so a host can close its modal on
   * `signed-in` or keep its own fields enabled on `failed`.
   */
  onOutcome?: (outcome: GoogleSignInOutcome) => void;
  className?: string;
}

export default function GoogleSignInButton({
  providers,
  intent = 'signin',
  redirectOutcome = null,
  onRedirectOutcomeHandled,
  onOutcome,
  className,
}: GoogleSignInButtonProps) {
  const configured = useMemo(
    () =>
      parseConfiguredProviders(
        providers === undefined ? process.env.NEXT_PUBLIC_AUTH_PROVIDERS : providers
      ),
    [providers]
  );

  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<IdentityProviderId | null>(null);

  // A `signed-in` outcome usually unmounts this control along with its host modal,
  // so the post-await state updates are skipped once unmounted.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The redirect fallback's outcome, reported once and then cleared upstream.
  useEffect(() => {
    if (redirectOutcome === null) return;
    setMessage(messageForProviderOutcome(redirectOutcome));
    onRedirectOutcomeHandled?.();
  }, [redirectOutcome, onRedirectOutcomeHandled]);

  const startSignIn = useCallback(
    async (provider: IdentityProviderId) => {
      setMessage(null);
      setPending(provider);
      let outcome: GoogleSignInOutcome;
      try {
        outcome = await PROVIDER_SIGN_IN[provider]();
      } catch {
        // `signInWithGoogle` reports failures as outcomes, so a throw here is an
        // unexpected fault; it still must not leave the control stuck pending.
        outcome = { status: 'failed', code: 'auth/unknown' };
      }
      if (!mounted.current) return;
      setPending(null);
      setMessage(messageForProviderOutcome(outcome));
      onOutcome?.(outcome);
    },
    [onOutcome]
  );

  // Requirement 3.10 — zero configured providers means zero controls. The email
  // and password fields live in `AuthModal` and are unaffected.
  if (configured.length === 0) return null;

  const verb = intent === 'signup' ? 'Sign up' : 'Sign in';

  return (
    <div className={className ?? 'space-y-3'}>
      {configured.map((provider) => {
        const Mark = PROVIDER_MARKS[provider];
        return (
          <button
            key={provider}
            type="button"
            onClick={() => void startSignIn(provider)}
            disabled={pending !== null}
            aria-busy={pending === provider}
            className="flex items-center gap-3 px-4 py-2.5 rounded-lg border border-gray-300 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 transition-colors shadow-sm disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <Mark />
            {`${verb} with ${PROVIDER_NAMES[provider]}`}
          </button>
        );
      })}

      {message !== null && (
        <p className="text-sm text-red-600" role="alert">
          {message}
        </p>
      )}
    </div>
  );
}
