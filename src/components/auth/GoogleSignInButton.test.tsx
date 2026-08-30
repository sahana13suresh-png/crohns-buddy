import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import GoogleSignInButton, {
  configuredIdentityProviders,
  parseConfiguredProviders,
} from './GoogleSignInButton';
import type { GoogleSignInOutcome } from '@/lib/auth';

/**
 * The Auth_Service is the one module boundary replaced here; every assertion is
 * about this component's own behavior — which controls it renders for a given
 * Deployment_Configuration (Requirements 3.1, 3.10) and which message it shows for
 * each provider outcome (3.6 through 3.9).
 */

const signInWithProvider =
  vi.fn<
    (
      provider:
        | 'Google'
        | 'Facebook'
        | 'LoginWithAmazon'
        | 'SignInWithApple',
    ) => Promise<GoogleSignInOutcome>
  >();

vi.mock('@/lib/auth', () => ({
  signInWithProvider: (
    provider:
      | 'Google'
      | 'Facebook'
      | 'LoginWithAmazon'
      | 'SignInWithApple',
  ) => signInWithProvider(provider),
}));

const GOOGLE_CONTROL = { name: /sign in with google/i } as const;

describe('parseConfiguredProviders', () => {
  it('returns the empty list for an absent, empty, or unrecognized configuration', () => {
    expect(parseConfiguredProviders(undefined)).toEqual([]);
    expect(parseConfiguredProviders(null)).toEqual([]);
    expect(parseConfiguredProviders('')).toEqual([]);
    expect(parseConfiguredProviders('   ')).toEqual([]);
    expect(parseConfiguredProviders('linkedin, twitter')).toEqual([]);
  });

  it('keeps each recognized provider exactly once, ignoring case, spacing, and repeats', () => {
    expect(
      parseConfiguredProviders(
        ' GOOGLE , facebook , Amazon, APPLE,google,',
      ),
    ).toEqual([
      'google',
      'facebook',
      'amazon',
      'apple',
    ]);
  });

  it('reads the deployment configuration', () => {
    vi.stubEnv('NEXT_PUBLIC_AUTH_PROVIDERS', 'google');
    expect(configuredIdentityProviders()).toEqual(['google']);
    vi.unstubAllEnvs();
  });
});

describe('GoogleSignInButton', () => {
  beforeEach(() => {
    signInWithProvider.mockReset().mockResolvedValue({ status: 'cancelled' });
  });

  it('enables the configured provider and keeps all supported choices visible', async () => {
    render(<GoogleSignInButton providers="google,google" />);

    expect(screen.getAllByRole('button', GOOGLE_CONTROL)).toHaveLength(1);
    expect(screen.getByRole('button', GOOGLE_CONTROL)).toBeEnabled();
    expect(
      screen.getByRole('button', { name: /sign in with facebook/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: /sign in with amazon/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: /sign in with apple/i }),
    ).toBeDisabled();

    await userEvent.tab();
    expect(screen.getByRole('button', GOOGLE_CONTROL)).toHaveFocus();
    await userEvent.keyboard('{Enter}');

    await waitFor(() =>
      expect(signInWithProvider).toHaveBeenCalledWith('Google'),
    );
  });

  it.each([undefined, '', '  ', 'linkedin'])(
    'renders disabled provider choices for the configuration %o',
    (providers) => {
      render(<GoogleSignInButton providers={providers ?? ''} />);
      expect(screen.getAllByRole('button')).toHaveLength(4);
      for (const control of screen.getAllByRole('button')) {
        expect(control).toBeDisabled();
      }
      expect(screen.getAllByText('Soon')).toHaveLength(4);
    },
  );

  it('labels the control for the signup view', () => {
    render(<GoogleSignInButton providers="google" intent="signup" />);
    expect(screen.getByRole('button', { name: /sign up with google/i })).toBeInTheDocument();
  });

  it('shows no message when the Patient cancels the provider window', async () => {
    signInWithProvider.mockResolvedValue({ status: 'cancelled' });
    const onOutcome = vi.fn();
    render(<GoogleSignInButton providers="google" onOutcome={onOutcome} />);

    await userEvent.click(screen.getByRole('button', GOOGLE_CONTROL));

    await waitFor(() => expect(onOutcome).toHaveBeenCalledWith({ status: 'cancelled' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([
    [{ status: 'timed-out' }, /took too long/i],
    [{ status: 'no-email' }, /email address/i],
    [{ status: 'failed', code: 'auth/internal-error' }, /sign-in failed/i],
  ] as const)('explains the %o outcome', async (outcome, expected) => {
    signInWithProvider.mockResolvedValue(outcome);
    render(<GoogleSignInButton providers="google" />);

    await userEvent.click(screen.getByRole('button', GOOGLE_CONTROL));

    expect(await screen.findByRole('alert')).toHaveTextContent(expected);
  });

  it('renders a reconciled redirect outcome once and reports it handled', async () => {
    const onRedirectOutcomeHandled = vi.fn();
    render(
      <GoogleSignInButton
        providers="google"
        redirectOutcome={{ status: 'timed-out' }}
        onRedirectOutcomeHandled={onRedirectOutcomeHandled}
      />
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(/took too long/i);
    expect(onRedirectOutcomeHandled).toHaveBeenCalledTimes(1);
  });

  it('clears a stale message when a fresh attempt starts', async () => {
    signInWithProvider.mockResolvedValue({ status: 'timed-out' });
    render(<GoogleSignInButton providers="google" />);

    await userEvent.click(screen.getByRole('button', GOOGLE_CONTROL));
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    signInWithProvider.mockResolvedValue({
      status: 'signed-in',
      session: {
        userId: 'uid-1',
        displayName: 'Alice',
        email: 'alice@example.com',
        emailVerified: true,
        authTimeMs: 1_700_000_000_000,
        sessionStartedAtMs: 1_700_000_000_000,
      },
    });
    await userEvent.click(screen.getByRole('button', GOOGLE_CONTROL));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});
