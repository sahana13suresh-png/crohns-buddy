import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AuthModal, {
  MANAGED_ACCOUNT_MESSAGE,
  PASSWORD_PRIVACY_MESSAGE,
  type AuthModalProps,
} from './AuthModal';

const { signInWithGoogle } = vi.hoisted(() => ({
  signInWithGoogle: vi.fn(async () => ({ status: 'cancelled' as const })),
}));

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, signInWithGoogle };
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
});

describe('Cognito account modal', () => {
  it('sends email sign-in to the server-side authorization-code flow', () => {
    renderModal();

    const link = screen.getByRole('link', { name: 'Continue with email' });
    expect(link).toHaveAttribute(
      'href',
      '/api/auth/start?intent=signin&returnTo=%2F',
    );
  });

  it('opens the account-creation flow without collecting a password', () => {
    renderModal({ mode: 'signup' });

    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Continue to create account' }),
    ).toHaveAttribute('href', '/api/auth/start?intent=signup&returnTo=%2F');
    expect(screen.getByText(PASSWORD_PRIVACY_MESSAGE)).toBeVisible();
    expect(screen.getByText(MANAGED_ACCOUNT_MESSAGE)).toBeVisible();
  });

  it('offers the configured Google provider and keeps it keyboard-operable', async () => {
    const user = userEvent.setup();
    renderModal();

    const google = screen.getByRole('button', { name: 'Sign in with Google' });
    google.focus();
    await user.keyboard('{Enter}');

    expect(signInWithGoogle).toHaveBeenCalledTimes(1);
  });

  it('switches between sign-in and account creation', async () => {
    const user = userEvent.setup();
    const { props } = renderModal();

    await user.click(screen.getByRole('button', { name: 'Create an account' }));
    expect(props.onSwitchMode).toHaveBeenCalledTimes(1);
  });

  it('closes with an explicit control and keeps the Privacy Notice available', async () => {
    const user = userEvent.setup();
    const { props } = renderModal();

    expect(screen.getByRole('link', { name: 'Privacy Notice' })).toHaveAttribute(
      'href',
      '/privacy',
    );
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
