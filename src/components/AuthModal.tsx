'use client';

import {
  useEffect,
  useId,
  useState,
  type FormEvent,
  type MouseEvent,
} from 'react';

import GoogleSignInButton, {
  RECOGNIZED_IDENTITY_PROVIDERS,
} from '@/components/auth/GoogleSignInButton';
import {
  classifyAuthError,
  confirmPasswordReset,
  confirmSignInMfa,
  confirmSignUp,
  requestPasswordReset,
  resendSignUpCode,
  signIn,
  signUp,
  type GoogleSignInOutcome,
} from '@/lib/auth';

export interface AuthModalProps {
  mode: 'login' | 'signup';
  onClose: () => void;
  onSuccess: () => void;
  onSwitchMode: () => void;
  redirectOutcome?: GoogleSignInOutcome | null;
  onRedirectOutcomeHandled?: () => void;
}

type AuthView =
  | 'credentials'
  | 'confirm-signup'
  | 'forgot-password'
  | 'reset-password'
  | 'mfa';

const PASSWORD_GUIDANCE =
  'Use 12+ characters with uppercase, lowercase, a number, and a symbol.';

function messageForError(error: unknown): string {
  switch (classifyAuthError(error)) {
    case 'email-already-in-use':
      return 'An account may already exist for this email. Try logging in instead.';
    case 'weak-password':
      return PASSWORD_GUIDANCE;
    case 'invalid-email':
      return 'Enter a valid email address and check all required fields.';
    case 'invalid-credentials':
      return 'The email or password is incorrect.';
    case 'too-many-requests':
      return 'Too many attempts. Please wait a moment and try again.';
    case 'invalid-code':
      return 'That verification code is not valid.';
    case 'expired-code':
      return 'That verification code has expired. Request a new one.';
    case 'unverified-email':
      return 'Verify your email address to finish signing in.';
    case 'password-reset-required':
      return 'Reset your password to continue.';
    case 'not-configured':
      return 'Account features are temporarily unavailable.';
    case 'unavailable':
      return 'We could not complete that request. Please try again.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

function EyeIcon({ hidden }: { hidden: boolean }) {
  return hidden ? (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
      <path
        d="M3 3l18 18M10.6 10.7a2 2 0 002.7 2.7M9.9 4.3A10.6 10.6 0 0112 4c5.5 0 9 5.4 9 5.4a16 16 0 01-3 3.7M6.2 6.2C4.2 7.5 3 9.4 3 9.4S6.5 15 12 15c1 0 2-.2 2.8-.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
      <path
        d="M3 12s3.5-5.5 9-5.5 9 5.5 9 5.5-3.5 5.5-9 5.5S3 12 3 12z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <circle
        cx="12"
        cy="12"
        r="2.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
      />
    </svg>
  );
}

export default function AuthModal({
  mode,
  onClose,
  onSuccess,
  onSwitchMode,
  redirectOutcome = null,
  onRedirectOutcomeHandled,
}: AuthModalProps) {
  const titleId = useId();
  const emailId = useId();
  const passwordId = useId();
  const confirmPasswordId = useId();
  const nameId = useId();
  const codeId = useId();
  const isSignup = mode === 'signup';
  const socialProviders = RECOGNIZED_IDENTITY_PROVIDERS;

  const [view, setView] = useState<AuthView>('credentials');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [code, setCode] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [mfaMethod, setMfaMethod] = useState<'authenticator' | 'sms'>(
    'authenticator',
  );

  useEffect(() => {
    setView('credentials');
    setPassword('');
    setConfirmPassword('');
    setCode('');
    setError(null);
    setStatus(null);
  }, [mode]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const clearMessages = () => {
    setError(null);
    setStatus(null);
  };

  const handleBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  const handleCredentials = async (event: FormEvent) => {
    event.preventDefault();
    clearMessages();
    if (isSignup && password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setPending(true);
    try {
      if (isSignup) {
        const result = await signUp(email, password, displayName);
        setPassword('');
        setConfirmPassword('');
        if (result.step === 'confirm-signup') {
          setView('confirm-signup');
          setStatus(`We sent a verification code to ${email.trim()}.`);
          return;
        }
        setStatus('Your account is ready. Log in to continue.');
        onSwitchMode();
        return;
      }

      const result = await signIn(email, password);
      setPassword('');
      if (result.step === 'done') {
        onSuccess();
        return;
      }
      if (result.step === 'mfa') {
        setMfaMethod(result.method ?? 'authenticator');
        setView('mfa');
      }
    } catch (requestError: unknown) {
      const kind = classifyAuthError(requestError);
      if (kind === 'unverified-email') {
        setPassword('');
        setView('confirm-signup');
        setStatus(`Enter the verification code sent to ${email.trim()}.`);
      } else if (kind === 'password-reset-required') {
        setPassword('');
        setView('forgot-password');
        setStatus('Request a password reset to continue.');
      } else {
        setError(messageForError(requestError));
      }
    } finally {
      setPending(false);
    }
  };

  const handleConfirmation = async (event: FormEvent) => {
    event.preventDefault();
    clearMessages();
    setPending(true);
    try {
      await confirmSignUp(email, code);
      setCode('');
      setStatus('Email verified. Log in to continue.');
      if (isSignup) onSwitchMode();
      else setView('credentials');
    } catch (requestError: unknown) {
      setError(messageForError(requestError));
    } finally {
      setPending(false);
    }
  };

  const handleResend = async () => {
    clearMessages();
    setPending(true);
    try {
      await resendSignUpCode(email);
      setStatus(`A new verification code was sent to ${email.trim()}.`);
    } catch (requestError: unknown) {
      setError(messageForError(requestError));
    } finally {
      setPending(false);
    }
  };

  const handleForgotPassword = async (event: FormEvent) => {
    event.preventDefault();
    clearMessages();
    setPending(true);
    try {
      await requestPasswordReset(email);
      setView('reset-password');
      setStatus(
        `If an account exists for ${email.trim()}, a reset code is on its way.`,
      );
    } catch (requestError: unknown) {
      setError(messageForError(requestError));
    } finally {
      setPending(false);
    }
  };

  const handleResetPassword = async (event: FormEvent) => {
    event.preventDefault();
    clearMessages();
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setPending(true);
    try {
      await confirmPasswordReset(email, code, password);
      setPassword('');
      setConfirmPassword('');
      setCode('');
      setView('credentials');
      setStatus('Password updated. You can log in now.');
    } catch (requestError: unknown) {
      setError(messageForError(requestError));
    } finally {
      setPending(false);
    }
  };

  const handleMfa = async (event: FormEvent) => {
    event.preventDefault();
    clearMessages();
    setPending(true);
    try {
      const result = await confirmSignInMfa(code);
      setCode('');
      if (result.step === 'done') onSuccess();
    } catch (requestError: unknown) {
      setError(messageForError(requestError));
    } finally {
      setPending(false);
    }
  };

  const inputClass =
    'w-full rounded-lg border border-brand-800/20 bg-white px-4 py-3 text-[15px] text-brand-800 shadow-sm outline-none transition placeholder:text-brand-800/35 focus:border-brand-400 focus:ring-4 focus:ring-brand-400/15';
  const labelClass = 'mb-1.5 block text-sm font-semibold text-brand-800/80';
  const primaryLabel =
    view === 'confirm-signup'
      ? 'Verify email'
      : view === 'forgot-password'
        ? 'Send reset code'
        : view === 'reset-password'
          ? 'Update password'
          : view === 'mfa'
            ? 'Verify and continue'
            : isSignup
              ? 'Create account'
              : 'Log in';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-brand-900/55 px-4 py-8 backdrop-blur-[2px]"
      onMouseDown={handleBackdrop}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative max-h-[calc(100dvh-2rem)] w-full max-w-4xl overflow-y-auto rounded-2xl border border-white/70 bg-white shadow-[0_30px_90px_rgba(6,17,34,0.35)]"
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-5 top-4 z-10 rounded-full p-2 text-brand-800/45 transition hover:bg-brand-50 hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
          aria-label="Close"
        >
          <span aria-hidden="true" className="block text-2xl leading-none">
            ×
          </span>
        </button>

        <div className="grid min-h-[31rem] md:grid-cols-[0.88fr_1.12fr]">
          <aside
            className={`flex-col justify-center bg-brand-50 px-6 py-6 sm:px-10 md:flex md:border-r md:border-brand-800/10 md:py-10 ${
              socialProviders.length > 0 ? 'flex' : 'hidden'
            }`}
          >
            <div className="hidden md:block">
              <p className="mb-3 text-xs font-semibold uppercase tracking-[0.22em] text-brand-500">
                Crohn&apos;s Buddy
              </p>
              <h3 className="font-sans text-2xl font-semibold normal-case tracking-tight text-brand-800">
                Your health tools, always within reach.
              </h3>
              <p className="mt-3 text-sm leading-6 text-brand-800/60">
                Keep saved meal plans, preferences, and account settings
                available across your devices.
              </p>
            </div>

            {socialProviders.length > 0 && (
              <>
                <p className="mb-3 text-sm font-semibold text-brand-800/75 md:mt-8">
                  {isSignup ? 'Sign up quickly' : 'Quick sign in'}
                </p>
                <GoogleSignInButton
                  intent={isSignup ? 'signup' : 'signin'}
                  redirectOutcome={redirectOutcome}
                  onRedirectOutcomeHandled={onRedirectOutcomeHandled}
                  className="space-y-3 [&>button]:w-full [&>button]:justify-center [&>button]:rounded-lg [&>button]:py-3"
                />
                <div className="my-6 flex items-center gap-3 md:hidden">
                  <span className="h-px flex-1 bg-brand-800/10" />
                  <span className="text-xs font-semibold uppercase tracking-widest text-brand-800/35">
                    or
                  </span>
                  <span className="h-px flex-1 bg-brand-800/10" />
                </div>
              </>
            )}

          </aside>

          <div className="relative flex items-center px-7 py-10 sm:px-12">
            {socialProviders.length > 0 && (
              <span className="absolute -left-5 top-1/2 hidden h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-brand-800/10 bg-white text-xs font-semibold uppercase text-brand-800/45 shadow-sm md:flex">
                or
              </span>
            )}

            <div className="mx-auto w-full max-w-md">
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-brand-500">
                {view === 'forgot-password' || view === 'reset-password'
                  ? 'Account recovery'
                  : isSignup
                    ? 'Join Crohn’s Buddy'
                    : 'Welcome back'}
              </p>
              <h2
                id={titleId}
                className="font-sans text-3xl font-semibold normal-case tracking-tight text-brand-800 sm:text-4xl"
              >
                {view === 'confirm-signup'
                  ? 'Verify your email'
                  : view === 'forgot-password'
                    ? 'Reset your password'
                    : view === 'reset-password'
                      ? 'Choose a new password'
                      : view === 'mfa'
                        ? 'Confirm it’s you'
                        : isSignup
                          ? 'Create your account'
                          : 'Log in with email'}
              </h2>
              <p className="mb-7 mt-2 text-sm leading-6 text-brand-800/55">
                {view === 'confirm-signup'
                  ? 'Enter the six-digit code from your email.'
                  : view === 'forgot-password'
                    ? 'Enter your email and we’ll send password reset instructions.'
                    : view === 'reset-password'
                      ? 'Enter your code and set a strong new password.'
                      : view === 'mfa'
                        ? `Enter the code from your ${
                            mfaMethod === 'sms'
                              ? 'text message'
                              : 'authenticator app'
                          }.`
                        : isSignup
                          ? 'Save your plans and preferences securely across devices.'
                          : 'Access your saved plans and account settings.'}
              </p>

              {(error || status) && (
                <div
                  role={error ? 'alert' : 'status'}
                  className={`mb-5 rounded-lg border px-4 py-3 text-sm ${
                    error
                      ? 'border-red-200 bg-red-50 text-red-800'
                      : 'border-brand-400/25 bg-brand-50 text-brand-800/75'
                  }`}
                >
                  {error ?? status}
                </div>
              )}

              {view === 'credentials' && (
                <form onSubmit={handleCredentials} className="space-y-4">
                  {isSignup && (
                    <div>
                      <label htmlFor={nameId} className={labelClass}>
                        Display name
                      </label>
                      <input
                        id={nameId}
                        value={displayName}
                        onChange={(event) => setDisplayName(event.target.value)}
                        autoComplete="name"
                        maxLength={50}
                        required
                        className={inputClass}
                        placeholder="How should we address you?"
                      />
                    </div>
                  )}

                  <div>
                    <label htmlFor={emailId} className={labelClass}>
                      Email
                    </label>
                    <input
                      id={emailId}
                      type="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      autoComplete="email"
                      inputMode="email"
                      maxLength={254}
                      required
                      autoFocus
                      className={inputClass}
                      placeholder="you@example.com"
                    />
                  </div>

                  <div>
                    <label htmlFor={passwordId} className={labelClass}>
                      Password
                    </label>
                    <div className="relative">
                      <input
                        id={passwordId}
                        type={showPassword ? 'text' : 'password'}
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        autoComplete={
                          isSignup ? 'new-password' : 'current-password'
                        }
                        minLength={12}
                        maxLength={256}
                        required
                        className={`${inputClass} pr-12`}
                        placeholder="Enter your password"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((visible) => !visible)}
                        className="absolute inset-y-0 right-0 flex w-12 items-center justify-center rounded-r-lg text-brand-800/45 hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-400"
                        aria-label={
                          showPassword ? 'Hide password' : 'Show password'
                        }
                      >
                        <EyeIcon hidden={!showPassword} />
                      </button>
                    </div>
                    {isSignup && (
                      <p className="mt-1.5 text-xs leading-5 text-brand-800/45">
                        {PASSWORD_GUIDANCE}
                      </p>
                    )}
                  </div>

                  {isSignup && (
                    <div>
                      <label htmlFor={confirmPasswordId} className={labelClass}>
                        Confirm password
                      </label>
                      <input
                        id={confirmPasswordId}
                        type={showPassword ? 'text' : 'password'}
                        value={confirmPassword}
                        onChange={(event) =>
                          setConfirmPassword(event.target.value)
                        }
                        autoComplete="new-password"
                        minLength={12}
                        maxLength={256}
                        required
                        className={inputClass}
                        placeholder="Re-enter your password"
                      />
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={pending}
                    className="w-full rounded-lg bg-brand-800 px-6 py-3.5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-55"
                  >
                    {pending ? 'Please wait…' : primaryLabel}
                  </button>
                </form>
              )}

              {view === 'confirm-signup' && (
                <form onSubmit={handleConfirmation} className="space-y-4">
                  <div>
                    <label htmlFor={codeId} className={labelClass}>
                      Verification code
                    </label>
                    <input
                      id={codeId}
                      value={code}
                      onChange={(event) =>
                        setCode(event.target.value.replace(/\D/g, ''))
                      }
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      pattern="\d{6}"
                      maxLength={6}
                      required
                      autoFocus
                      className={`${inputClass} text-center text-xl tracking-[0.35em]`}
                      placeholder="000000"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={pending}
                    className="btn-primary w-full rounded-lg"
                  >
                    {pending ? 'Verifying…' : primaryLabel}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleResend()}
                    disabled={pending}
                    className="w-full text-sm font-medium text-brand-500 hover:text-brand-700 disabled:opacity-50"
                  >
                    Send a new code
                  </button>
                </form>
              )}

              {view === 'forgot-password' && (
                <form onSubmit={handleForgotPassword} className="space-y-4">
                  <div>
                    <label htmlFor={emailId} className={labelClass}>
                      Email
                    </label>
                    <input
                      id={emailId}
                      type="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      autoComplete="email"
                      required
                      autoFocus
                      className={inputClass}
                      placeholder="you@example.com"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={pending}
                    className="btn-primary w-full rounded-lg"
                  >
                    {pending ? 'Sending…' : primaryLabel}
                  </button>
                </form>
              )}

              {view === 'reset-password' && (
                <form onSubmit={handleResetPassword} className="space-y-4">
                  <div>
                    <label htmlFor={codeId} className={labelClass}>
                      Reset code
                    </label>
                    <input
                      id={codeId}
                      value={code}
                      onChange={(event) =>
                        setCode(event.target.value.replace(/\D/g, ''))
                      }
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      pattern="\d{6}"
                      maxLength={6}
                      required
                      className={inputClass}
                      placeholder="Six-digit code"
                    />
                  </div>
                  <div>
                    <label htmlFor={passwordId} className={labelClass}>
                      New password
                    </label>
                    <input
                      id={passwordId}
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      autoComplete="new-password"
                      minLength={12}
                      maxLength={256}
                      required
                      className={inputClass}
                    />
                    <p className="mt-1.5 text-xs leading-5 text-brand-800/45">
                      {PASSWORD_GUIDANCE}
                    </p>
                  </div>
                  <div>
                    <label
                      htmlFor={confirmPasswordId}
                      className={labelClass}
                    >
                      Confirm new password
                    </label>
                    <input
                      id={confirmPasswordId}
                      type={showPassword ? 'text' : 'password'}
                      value={confirmPassword}
                      onChange={(event) =>
                        setConfirmPassword(event.target.value)
                      }
                      autoComplete="new-password"
                      minLength={12}
                      maxLength={256}
                      required
                      className={inputClass}
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={pending}
                    className="btn-primary w-full rounded-lg"
                  >
                    {pending ? 'Updating…' : primaryLabel}
                  </button>
                </form>
              )}

              {view === 'mfa' && (
                <form onSubmit={handleMfa} className="space-y-4">
                  <div>
                    <label htmlFor={codeId} className={labelClass}>
                      Security code
                    </label>
                    <input
                      id={codeId}
                      value={code}
                      onChange={(event) =>
                        setCode(event.target.value.replace(/\D/g, ''))
                      }
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      pattern="\d{6}"
                      maxLength={6}
                      required
                      autoFocus
                      className={`${inputClass} text-center text-xl tracking-[0.35em]`}
                      placeholder="000000"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={pending}
                    className="btn-primary w-full rounded-lg"
                  >
                    {pending ? 'Verifying…' : primaryLabel}
                  </button>
                </form>
              )}

              <div className="mt-7 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 border-t border-brand-800/10 pt-5 text-sm">
                {view === 'credentials' && !isSignup && (
                  <button
                    type="button"
                    onClick={() => {
                      clearMessages();
                      setView('forgot-password');
                    }}
                    className="font-medium text-brand-500 underline decoration-brand-400/40 underline-offset-4 hover:text-brand-700"
                  >
                    Forgot password?
                  </button>
                )}

                {view !== 'credentials' && (
                  <button
                    type="button"
                    onClick={() => {
                      clearMessages();
                      setView('credentials');
                    }}
                    className="font-medium text-brand-500 underline decoration-brand-400/40 underline-offset-4 hover:text-brand-700"
                  >
                    Back to login
                  </button>
                )}

                {view === 'credentials' && (
                  <button
                    type="button"
                    onClick={onSwitchMode}
                    className="font-medium text-brand-500 underline decoration-brand-400/40 underline-offset-4 hover:text-brand-700"
                  >
                    {isSignup
                      ? 'Already have an account?'
                      : 'Create a new account'}
                  </button>
                )}
              </div>

              <p className="mt-5 text-center text-xs leading-5 text-brand-800/40">
                By continuing, you agree to our{' '}
                <a
                  href="/privacy"
                  className="font-medium underline underline-offset-3"
                >
                  Privacy Notice
                </a>
                .
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
