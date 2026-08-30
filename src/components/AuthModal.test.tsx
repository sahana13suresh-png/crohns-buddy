import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AuthModal, { type AuthModalProps } from './AuthModal';

const authMocks = vi.hoisted(() => ({
  signIn: vi.fn(),
  signUp: vi.fn(),
  confirmSignUp: vi.fn(),
  resendSignUpCode: vi.fn(),
  requestPasswordReset: vi.fn(),
  confirmPasswordReset: vi.fn(),
  confirmSignInMfa: vi.fn(),
  signInWithProvider: vi.fn(async () => ({ status: 'cancelled' as const })),
}));

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, ...authMocks };
});

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

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_AUTH_PROVIDERS', 'google');
  authMocks.signIn.mockResolvedValue({ step: 'done' });
  authMocks.signUp.mockResolvedValue({ step: 'confirm-signup' });
  authMocks.confirmSignUp.mockResolvedValue({ step: 'sign-in' });
  authMocks.resendSignUpCode.mockResolvedValue({ step: 'confirm-signup' });
  authMocks.requestPasswordReset.mockResolvedValue({ step: 'reset-password' });
  authMocks.confirmPasswordReset.mockResolvedValue({ step: 'sign-in' });
  authMocks.confirmSignInMfa.mockResolvedValue({ step: 'done' });
});

describe('account modal', () => {
  it('renders the branded email login form without infrastructure terminology', () => {
    renderModal();

    expect(
      screen.getByRole('heading', { name: 'Log in with email' }),
    ).toBeVisible();
    expect(screen.getByLabelText('Email')).toHaveAttribute(
      'autocomplete',
      'email',
    );
    expect(screen.getByLabelText('Password')).toHaveAttribute(
      'autocomplete',
      'current-password',
    );
    expect(screen.getByRole('button', { name: 'Log in' })).toBeEnabled();
    expect(screen.queryByText(/cognito|amazon/i)).not.toBeInTheDocument();
  });

  it('submits email credentials and closes after successful login', async () => {
    const user = userEvent.setup();
    const { props } = renderModal();

    await user.type(screen.getByLabelText('Email'), 'patient@example.com');
    await user.type(screen.getByLabelText('Password'), 'Strong!Password1');
    await user.click(screen.getByRole('button', { name: 'Log in' }));

    await waitFor(() =>
      expect(authMocks.signIn).toHaveBeenCalledWith(
        'patient@example.com',
        'Strong!Password1',
      ),
    );
    expect(props.onSuccess).toHaveBeenCalledTimes(1);
  });

  it('creates an account and advances to email verification', async () => {
    const user = userEvent.setup();
    renderModal({ mode: 'signup' });

    await user.type(screen.getByLabelText('Display name'), 'Avery');
    await user.type(screen.getByLabelText('Email'), 'avery@example.com');
    await user.type(screen.getByLabelText('Password'), 'Strong!Password1');
    await user.type(
      screen.getByLabelText('Confirm password'),
      'Strong!Password1',
    );
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() =>
      expect(authMocks.signUp).toHaveBeenCalledWith(
        'avery@example.com',
        'Strong!Password1',
        'Avery',
      ),
    );
    expect(
      screen.getByRole('heading', { name: 'Verify your email' }),
    ).toBeVisible();
    expect(screen.getByLabelText('Verification code')).toHaveAttribute(
      'autocomplete',
      'one-time-code',
    );
  });

  it('does not submit mismatched signup passwords', async () => {
    const user = userEvent.setup();
    renderModal({ mode: 'signup' });

    await user.type(screen.getByLabelText('Display name'), 'Avery');
    await user.type(screen.getByLabelText('Email'), 'avery@example.com');
    await user.type(screen.getByLabelText('Password'), 'Strong!Password1');
    await user.type(
      screen.getByLabelText('Confirm password'),
      'Different!Password2',
    );
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Passwords do not match.',
    );
    expect(authMocks.signUp).not.toHaveBeenCalled();
  });

  it('provides an inline password recovery flow', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole('button', { name: 'Forgot password?' }));
    expect(
      screen.getByRole('heading', { name: 'Reset your password' }),
    ).toBeVisible();

    await user.type(screen.getByLabelText('Email'), 'patient@example.com');
    await user.click(screen.getByRole('button', { name: 'Send reset code' }));

    await waitFor(() =>
      expect(authMocks.requestPasswordReset).toHaveBeenCalledWith(
        'patient@example.com',
      ),
    );
    expect(
      screen.getByRole('heading', { name: 'Choose a new password' }),
    ).toBeVisible();
  });

  it('offers all social choices and keeps configured providers keyboard-operable', async () => {
    const user = userEvent.setup();
    renderModal();

    const google = screen.getByRole('button', { name: 'Sign in with Google' });
    expect(google).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'Sign in with Facebook' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Sign in with LinkedIn' }),
    ).toBeDisabled();
    expect(screen.queryByText('Private by design')).not.toBeInTheDocument();
    google.focus();
    await user.keyboard('{Enter}');

    expect(authMocks.signInWithProvider).toHaveBeenCalledWith('Google');
  });

  it('switches modes, closes with Escape, and links to the privacy notice', async () => {
    const user = userEvent.setup();
    const { props } = renderModal();

    expect(screen.getByRole('link', { name: 'Privacy Notice' })).toHaveAttribute(
      'href',
      '/privacy',
    );
    await user.click(
      screen.getByRole('button', { name: 'Create a new account' }),
    );
    expect(props.onSwitchMode).toHaveBeenCalledTimes(1);

    await user.keyboard('{Escape}');
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
