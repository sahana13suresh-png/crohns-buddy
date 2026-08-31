import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AccountMenu from './AccountMenu';
import type { SessionContextValue, SessionStatus } from './SessionProvider';
import type { AuthSession } from '@/lib/auth';

// The Session state is the input to this component, so it is supplied directly
// rather than driven through Firebase. Every other behavior under test — the
// controls rendered, the signout call, the expiry message — is real.
const { mockUseSession } = vi.hoisted(() => ({ mockUseSession: vi.fn() }));

vi.mock('./SessionProvider', () => ({ useSession: mockUseSession }));

const SESSION: AuthSession = {
  userId: 'uid-1',
  displayName: 'Ada Lovelace',
  email: 'ada@example.com',
  emailVerified: true,
  authTimeMs: 1_700_000_000_000,
  sessionStartedAtMs: 1_700_000_000_000,
};

const signOut = vi.fn().mockResolvedValue(undefined);
const dismissExpiredMessage = vi.fn();

function contextFor(status: SessionStatus, overrides: Partial<SessionContextValue> = {}): SessionContextValue {
  return {
    session: status === 'authenticated' ? SESSION : null,
    status,
    expiredMessage: status === 'expired' ? 'Your session expired.' : null,
    planViewEpoch: 0,
    signOut,
    dismissExpiredMessage,
    redirectOutcome: null,
    clearRedirectOutcome: vi.fn(),
    ...overrides,
  };
}

function renderWith(status: SessionStatus, overrides?: Partial<SessionContextValue>) {
  mockUseSession.mockReturnValue(contextFor(status, overrides));
  return render(<AccountMenu />);
}

describe('AccountMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_AUTH_SELF_REGISTRATION_ENABLED', 'false');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('shows the display name and a signout control while a Session is active', () => {
    renderWith('authenticated');

    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log Out' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Log In' })).not.toBeInTheDocument();
  });

  it('falls back to the email address when the Account has no display name', () => {
    renderWith('authenticated', { session: { ...SESSION, displayName: '' } });

    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
  });

  it('ends the Session when the signout control is activated by keyboard', async () => {
    const user = userEvent.setup();
    renderWith('authenticated');

    screen.getByRole('button', { name: 'Log Out' }).focus();
    await user.keyboard('{Enter}');

    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('shows only the signin control with no Session when registration is disabled', () => {
    renderWith('unauthenticated');

    expect(screen.getByRole('button', { name: 'Log In' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign Up' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Log Out' })).not.toBeInTheDocument();
  });

  it('shows the expiry message alongside the signin control', () => {
    renderWith('expired');

    expect(screen.getByRole('status')).toHaveTextContent('Your session expired.');
    expect(screen.getByRole('button', { name: 'Log In' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign Up' })).not.toBeInTheDocument();
  });

  it('shows signup only when the deployment explicitly enables registration', () => {
    vi.stubEnv('NEXT_PUBLIC_AUTH_SELF_REGISTRATION_ENABLED', 'true');
    renderWith('unauthenticated');

    expect(screen.getByRole('button', { name: 'Sign Up' })).toBeInTheDocument();
  });

  it('renders no auth control until the first Session state is known', () => {
    renderWith('loading');

    expect(screen.getByRole('navigation', { name: 'Account' })).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('opens the account modal from the signin control and dismisses the expiry message', async () => {
    const user = userEvent.setup();
    renderWith('expired');

    await user.click(screen.getByRole('button', { name: 'Log In' }));

    expect(dismissExpiredMessage).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole('heading', { name: 'Log in with email' }),
    ).toBeInTheDocument();
  });
});
