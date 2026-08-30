'use client';

import GoogleSignInButton from '@/components/auth/GoogleSignInButton';
import { authStartUrl, type GoogleSignInOutcome } from '@/lib/auth';

export interface AuthModalProps {
  mode: 'login' | 'signup';
  onClose: () => void;
  onSuccess: () => void;
  onSwitchMode: () => void;
  redirectOutcome?: GoogleSignInOutcome | null;
  onRedirectOutcomeHandled?: () => void;
}

export const PASSWORD_PRIVACY_MESSAGE =
  "Your password is entered only on Amazon Cognito's secure account page. Crohn's Buddy never receives or stores it.";

export const MANAGED_ACCOUNT_MESSAGE =
  'Cognito manages account creation, email verification, password recovery, secure sessions, and social sign-in.';

export default function AuthModal({
  mode,
  onClose,
  onSwitchMode,
  redirectOutcome = null,
  onRedirectOutcomeHandled,
}: AuthModalProps) {
  const isSignup = mode === 'signup';
  const heading = isSignup ? 'Create your secure account' : 'Welcome back';
  const primaryLabel = isSignup ? 'Continue to create account' : 'Continue with email';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-brand-800/45 px-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-modal-heading"
        className="relative w-full max-w-md overflow-y-auto rounded-sm border border-brand-800/10 bg-brand-50 p-8 shadow-2xl sm:p-10"
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 rounded-sm text-xl text-brand-800/40 transition-opacity hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
          aria-label="Close"
        >
          ×
        </button>

        <p className="mb-2 text-xs uppercase tracking-widest text-brand-400">
          Secure account
        </p>
        <h2 id="auth-modal-heading" className="mb-3 text-2xl">
          {heading}
        </h2>
        <p className="mb-7 text-sm leading-6 text-brand-800/65">
          {isSignup
            ? 'Create an account to save meal plans, export your data, and keep your information available across devices.'
            : 'Sign in to access your saved meal plans and account settings.'}
        </p>

        <div className="space-y-3">
          <a
            href={authStartUrl({ intent: mode === 'login' ? 'signin' : 'signup' })}
            className="btn-primary flex w-full items-center justify-center text-center"
          >
            {primaryLabel}
          </a>

          <GoogleSignInButton
            intent={isSignup ? 'signup' : 'signin'}
            redirectOutcome={redirectOutcome}
            onRedirectOutcomeHandled={onRedirectOutcomeHandled}
            className="space-y-3 [&>button]:w-full [&>button]:justify-center"
          />
        </div>

        <div className="mt-7 space-y-3 rounded-sm border border-brand-800/10 bg-white/60 p-4">
          <p className="text-sm leading-6 text-brand-800/70">{PASSWORD_PRIVACY_MESSAGE}</p>
          <p className="text-xs leading-5 text-brand-800/50">{MANAGED_ACCOUNT_MESSAGE}</p>
        </div>

        {!isSignup && (
          <p className="mt-5 text-xs leading-5 text-brand-800/50">
            Forgot your password? Continue with email and choose{' '}
            <span className="font-medium text-brand-800/70">Forgot password</span> on the
            secure account page.
          </p>
        )}

        <p className="mt-6 text-sm text-brand-800/60">
          {isSignup ? 'Already have an account?' : 'New to Crohn’s Buddy?'}{' '}
          <button
            type="button"
            onClick={onSwitchMode}
            className="rounded-sm text-brand-400 underline underline-offset-4 transition-opacity hover:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
          >
            {isSignup ? 'Log in instead' : 'Create an account'}
          </button>
        </p>

        <p className="mt-5 text-xs text-brand-800/45">
          <a
            href="/privacy"
            className="rounded-sm underline transition-opacity hover:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
          >
            Privacy Notice
          </a>
          {' — what we store and how to remove it.'}
        </p>
      </section>
    </div>
  );
}
