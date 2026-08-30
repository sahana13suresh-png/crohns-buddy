import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AuthModal, {
  AUTH_REQUEST_TIMEOUT_MS,
  EMAIL_REGISTERED_MESSAGE,
  INVALID_CREDENTIALS_MESSAGE,
  SIGNIN_UNAVAILABLE_MESSAGE,
  SIGNUP_FAILED_MESSAGE,
  type AuthModalProps,
} from './AuthModal';
import {
  PROVIDER_FAILED_MESSAGE,
  PROVIDER_NO_EMAIL_MESSAGE,
  PROVIDER_TIMED_OUT_MESSAGE,
} from './auth/GoogleSignInButton';
import type { AuthSession, GoogleSignInOutcome } from '@/lib/auth';

/**
 * The Auth_Service is the single module boundary replaced here. Everything under
 * test is this modal's own branching: which message it shows for each failure the
 * Auth_Service can report, which entered values survive that failure, and what it
 * does with each Identity_Provider outcome.
 *
 * Every message is asserted against the constant the component exports, so a
 * reworded message stays a one-line change rather than a suite-wide edit — and a
 * message that moves between requirements cannot silently keep passing.
 *
 * The two timeouts are advanced rather than waited on: 10 seconds for a signup or
 * signin request (Requirements 1.10, 2.12) and 120 seconds for an Identity_Provider
 * attempt (Requirement 3.9).
 */

const { authMocks } = vi.hoisted(() => ({
  authMocks: {
    signUp: vi.fn(),
    signIn: vi.fn(),
    signInWithGoogle: vi.fn(),
    requestPasswordReset: vi.fn(),
    getSignInThrottleState: vi.fn(),
    signInLedgerKey: vi.fn(),
  },
}));

vi.mock('@/lib/auth', () => {
  class SignInThrottledError extends Error {
    readonly code = 'auth/too-many-requests';
    constructor(readonly retryAfterSeconds: number) {
      super('Too many signin attempts.');
    }
  }

  /**
   * The real classifier folds Firebase codes into the kinds this component
   * branches on; the stub keeps that mapping so the tests drive the component
   * through a realistic code rather than through the kind directly.
   */
  const classifyAuthError = (err: unknown): string => {
    const code = typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined;
    switch (code) {
      case 'auth/email-already-in-use':
        return 'email-already-in-use';
      case 'auth/weak-password':
        return 'weak-password';
      case 'auth/invalid-email':
        return 'invalid-email';
      case 'auth/too-many-requests':
        return 'too-many-requests';
      case 'auth/wrong-password':
      case 'auth/user-not-found':
      case 'auth/invalid-credential':
        return 'invalid-credentials';
      case 'auth/not-configured':
        return 'not-configured';
      default:
        return 'unknown';
    }
  };

  return {
    SignInThrottledError,
    classifyAuthError,
    signUp: authMocks.signUp,
    signIn: authMocks.signIn,
    signInWithGoogle: authMocks.signInWithGoogle,
    requestPasswordReset: authMocks.requestPasswordReset,
    getSignInThrottleState: authMocks.getSignInThrottleState,
    signInLedgerKey: authMocks.signInLedgerKey,
  };
});

/**
 * Requirement 3.9's bound lives in `auth.ts`, so it is spelled out here and used
 * to make `signInWithGoogle` report the outcome at that instant — this suite
 * asserts what the modal does with a `timed-out` outcome, not who timed it.
 */
const PROVIDER_TIMEOUT_MS = 120_000;

const GOOGLE_CONTROL = { name: /sign (in|up) with google/i } as const;

const SESSION: AuthSession = {
  userId: 'uid-1',
  displayName: 'Ada Lovelace',
  email: 'ada@example.com',
  emailVerified: true,
  authTimeMs: 1_700_000_000_000,
  sessionStartedAtMs: 1_700_000_000_000,
};

function authError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function renderModal(overrides: Partial<AuthModalProps> = {}) {
  const props: AuthModalProps = {
    mode: 'login',
    onClose: vi.fn(),
    onSuccess: vi.fn(),
    onSwitchMode: vi.fn(),
    ...overrides,
  };
  return { ...render(<AuthModal {...props} />), props };
}

const nameField = () => screen.getByLabelText(/^name/i);
const emailField = () => screen.getByLabelText(/^email/i);
const passwordField = () => screen.getByLabelText(/^password/i);

/** Advances the faked clock and lets the resulting state updates settle. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/**
 * The timeout tests fill their fields with `userEvent` on the real clock and only
 * then switch to the faked one, because `userEvent` schedules its own timers
 * between keystrokes and would otherwise wait on a clock that only this test
 * advances. The submission itself is a single event, so `fireEvent` is enough.
 */
function submitWithFakeClock(name: 'Log In' | 'Sign Up'): void {
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole('button', { name }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_AUTH_PROVIDERS', 'google');
  authMocks.getSignInThrottleState.mockResolvedValue({
    allowed: true,
    retryAfterSeconds: 0,
    failureCount: 0,
  });
  authMocks.signInWithGoogle.mockResolvedValue({ status: 'cancelled' } satisfies GoogleSignInOutcome);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('AuthModal with no Session (Requirement 2.6)', () => {
  it('offers the signin fields and the signup switch without contacting the Auth_Service', () => {
    const { props } = renderModal();

    expect(emailField()).toBeEnabled();
    expect(passwordField()).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Log In' })).toBeEnabled();
    expect(screen.getByRole('button', GOOGLE_CONTROL)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign Up' })).toBeInTheDocument();

    // Unauthenticated until credentials are supplied: nothing is asked of the
    // Auth_Service, and no message claims anything about the visitor.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(authMocks.signIn).not.toHaveBeenCalled();
    expect(authMocks.signUp).not.toHaveBeenCalled();
    expect(props.onSuccess).not.toHaveBeenCalled();
  });
});

describe('AuthModal signup branches', () => {
  it('offers signin and keeps the name and email for an already-registered address (1.4)', async () => {
    const user = userEvent.setup();
    authMocks.signUp.mockRejectedValue(authError('auth/email-already-in-use'));
    const { props } = renderModal({ mode: 'signup' });

    await user.type(nameField(), 'Ada Lovelace');
    await user.type(emailField(), 'ada@example.com');
    await user.type(passwordField(), 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Sign Up' }));

    expect(await screen.findByText(EMAIL_REGISTERED_MESSAGE, { exact: false })).toBeInTheDocument();
    expect(nameField()).toHaveValue('Ada Lovelace');
    expect(emailField()).toHaveValue('ada@example.com');
    expect(props.onSuccess).not.toHaveBeenCalled();

    // The offer is a control, not prose: activating it switches to the signin view.
    await user.click(screen.getByRole('button', { name: /log in instead/i }));
    expect(props.onSwitchMode).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(EMAIL_REGISTERED_MESSAGE, { exact: false })).not.toBeInTheDocument();
  });

  it('reports a failure and clears only the password when creation times out (1.10)', async () => {
    const user = userEvent.setup();
    authMocks.signUp.mockReturnValue(new Promise(() => undefined));
    const { props } = renderModal({ mode: 'signup' });

    await user.type(nameField(), 'Ada Lovelace');
    await user.type(emailField(), 'ada@example.com');
    await user.type(passwordField(), 'correct horse');
    submitWithFakeClock('Sign Up');

    // A moment short of the bound the Patient is still waiting.
    await advance(AUTH_REQUEST_TIMEOUT_MS - 1);
    expect(screen.queryByText(SIGNUP_FAILED_MESSAGE)).not.toBeInTheDocument();

    await advance(1);
    expect(screen.getByText(SIGNUP_FAILED_MESSAGE)).toBeInTheDocument();
    expect(nameField()).toHaveValue('Ada Lovelace');
    expect(emailField()).toHaveValue('ada@example.com');
    expect(passwordField()).toHaveValue('');
    expect(props.onSuccess).not.toHaveBeenCalled();
  });

  it('reports the same failure for a rejection unrelated to the address (1.10)', async () => {
    const user = userEvent.setup();
    authMocks.signUp.mockRejectedValue(authError('auth/network-request-failed'));
    const { props } = renderModal({ mode: 'signup' });

    await user.type(nameField(), 'Ada Lovelace');
    await user.type(emailField(), 'ada@example.com');
    await user.type(passwordField(), 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Sign Up' }));

    expect(await screen.findByText(SIGNUP_FAILED_MESSAGE)).toBeInTheDocument();
    expect(nameField()).toHaveValue('Ada Lovelace');
    expect(emailField()).toHaveValue('ada@example.com');
    expect(passwordField()).toHaveValue('');
    expect(props.onSuccess).not.toHaveBeenCalled();
  });

  it('closes the modal with no validation message once the Session starts (1.11)', async () => {
    const user = userEvent.setup();
    authMocks.signUp.mockResolvedValue({ uid: SESSION.userId });
    const { props } = renderModal({ mode: 'signup' });

    await user.type(nameField(), '  Ada Lovelace  ');
    await user.type(emailField(), 'ada@example.com');
    await user.type(passwordField(), 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Sign Up' }));

    await vi.waitFor(() => expect(props.onSuccess).toHaveBeenCalledTimes(1));
    expect(authMocks.signUp).toHaveBeenCalledWith(
      'ada@example.com',
      'correct horse',
      'Ada Lovelace'
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('AuthModal signin transport failures (Requirement 2.12)', () => {
  it('reports signin as unavailable when no response arrives inside the bound', async () => {
    const user = userEvent.setup();
    authMocks.signIn.mockReturnValue(new Promise(() => undefined));
    const { props } = renderModal();

    await user.type(emailField(), 'ada@example.com');
    await user.type(passwordField(), 'correct horse');
    submitWithFakeClock('Log In');

    await advance(AUTH_REQUEST_TIMEOUT_MS - 1);
    expect(screen.queryByText(SIGNIN_UNAVAILABLE_MESSAGE)).not.toBeInTheDocument();

    await advance(1);
    expect(screen.getByText(SIGNIN_UNAVAILABLE_MESSAGE)).toBeInTheDocument();
    expect(emailField()).toHaveValue('ada@example.com');
    expect(passwordField()).toHaveValue('');
    expect(props.onSuccess).not.toHaveBeenCalled();

    // A transport failure says nothing about the credentials, so it must not be
    // dressed up as one — and nothing is counted against the address.
    expect(screen.queryByText(INVALID_CREDENTIALS_MESSAGE)).not.toBeInTheDocument();
    expect(authMocks.getSignInThrottleState).not.toHaveBeenCalled();
  });

  it('reports signin as unavailable for a failure unrelated to the credentials', async () => {
    const user = userEvent.setup();
    authMocks.signIn.mockRejectedValue(authError('auth/internal-error'));
    const { props } = renderModal();

    await user.type(emailField(), 'ada@example.com');
    await user.type(passwordField(), 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Log In' }));

    expect(await screen.findByText(SIGNIN_UNAVAILABLE_MESSAGE)).toBeInTheDocument();
    expect(emailField()).toHaveValue('ada@example.com');
    expect(passwordField()).toHaveValue('');
    expect(screen.queryByText(INVALID_CREDENTIALS_MESSAGE)).not.toBeInTheDocument();
    expect(props.onSuccess).not.toHaveBeenCalled();
  });
});

describe('AuthModal Identity_Provider outcomes', () => {
  it('returns to the modal with no error message when the Patient cancels (3.6)', async () => {
    const user = userEvent.setup();
    authMocks.signInWithGoogle.mockResolvedValue({ status: 'cancelled' });
    const { props } = renderModal();

    await user.type(emailField(), 'ada@example.com');
    await user.click(screen.getByRole('button', GOOGLE_CONTROL));

    await vi.waitFor(() => expect(authMocks.signInWithGoogle).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(emailField()).toHaveValue('ada@example.com');
    expect(props.onSuccess).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('explains a provider failure and leaves the email and password usable (3.7)', async () => {
    const user = userEvent.setup();
    authMocks.signInWithGoogle.mockResolvedValue({ status: 'failed', code: 'auth/internal-error' });
    const { props } = renderModal();

    await user.click(screen.getByRole('button', GOOGLE_CONTROL));

    expect(await screen.findByText(PROVIDER_FAILED_MESSAGE)).toBeInTheDocument();
    expect(props.onSuccess).not.toHaveBeenCalled();

    // Still accepting input, which is the substance of the requirement.
    expect(emailField()).toBeEnabled();
    expect(passwordField()).toBeEnabled();
    await user.type(emailField(), 'ada@example.com');
    await user.type(passwordField(), 'correct horse');
    expect(emailField()).toHaveValue('ada@example.com');
    expect(passwordField()).toHaveValue('correct horse');
  });

  it('asks for an email address when the provider returns none (3.8)', async () => {
    const user = userEvent.setup();
    authMocks.signInWithGoogle.mockResolvedValue({ status: 'no-email' });
    const { props } = renderModal();

    await user.click(screen.getByRole('button', GOOGLE_CONTROL));

    expect(await screen.findByText(PROVIDER_NO_EMAIL_MESSAGE)).toBeInTheDocument();
    expect(props.onSuccess).not.toHaveBeenCalled();
  });

  it('offers a retry once the provider attempt passes 120 seconds (3.9)', async () => {
    authMocks.signInWithGoogle.mockImplementation(
      () =>
        new Promise<GoogleSignInOutcome>((resolve) => {
          setTimeout(() => resolve({ status: 'timed-out' }), PROVIDER_TIMEOUT_MS);
        })
    );
    const { props } = renderModal();

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', GOOGLE_CONTROL));

    await advance(PROVIDER_TIMEOUT_MS - 1);
    expect(screen.queryByText(PROVIDER_TIMED_OUT_MESSAGE)).not.toBeInTheDocument();

    await advance(1);
    expect(screen.getByText(PROVIDER_TIMED_OUT_MESSAGE)).toBeInTheDocument();
    expect(props.onSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
