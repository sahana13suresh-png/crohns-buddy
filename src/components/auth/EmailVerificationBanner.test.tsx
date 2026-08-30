import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EmailVerificationBanner, {
  PENDING_VERIFICATION_MESSAGE,
  RESEND_FAILED_MESSAGE,
  RESEND_RATE_LIMITED_MESSAGE,
  VERIFICATION_RESENDS_KEY,
  VERIFICATION_SENT_MESSAGE,
} from './EmailVerificationBanner';
import type { SessionContextValue, SessionStatus } from './SessionProvider';
import type { AuthSession } from '@/lib/auth';

/**
 * The Session state and the Auth_Service call are the two boundaries replaced
 * here. Everything under test is this component's own behavior: whether the
 * indicator renders (Requirement 1.7), and whether the shared 60-second throttle
 * gates the resend and names when the next one becomes available.
 */

const { mockUseSession } = vi.hoisted(() => ({ mockUseSession: vi.fn() }));
const sendVerificationEmail = vi.fn<() => Promise<void>>();
const classifyAuthError = vi.fn<(err: unknown) => string>();

vi.mock('./SessionProvider', () => ({ useSession: mockUseSession }));

vi.mock('@/lib/auth', () => ({
  sendVerificationEmail: () => sendVerificationEmail(),
  classifyAuthError: (err: unknown) => classifyAuthError(err),
}));

const SESSION: AuthSession = {
  userId: 'uid-1',
  displayName: 'Ada Lovelace',
  email: 'ada@example.com',
  emailVerified: false,
  authTimeMs: 1_700_000_000_000,
  sessionStartedAtMs: 1_700_000_000_000,
};

const RESEND_CONTROL = { name: /resend verification email/i } as const;
const NEXT_RESEND_PATTERN = /another verification email can be sent in \d+ seconds?\./i;

function contextFor(
  status: SessionStatus,
  session: AuthSession | null = SESSION
): SessionContextValue {
  return {
    session: status === 'authenticated' ? session : null,
    status,
    expiredMessage: null,
    planViewEpoch: 0,
    signOut: vi.fn(),
    dismissExpiredMessage: vi.fn(),
    redirectOutcome: null,
    clearRedirectOutcome: vi.fn(),
  };
}

function renderWith(status: SessionStatus, session?: AuthSession | null) {
  mockUseSession.mockReturnValue(contextFor(status, session));
  return render(<EmailVerificationBanner />);
}

function storedAttempts(): number[] {
  const raw = window.localStorage.getItem(VERIFICATION_RESENDS_KEY);
  if (raw === null) return [];
  return (JSON.parse(raw) as Record<string, number[]>)[SESSION.userId] ?? [];
}

describe('EmailVerificationBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    sendVerificationEmail.mockResolvedValue(undefined);
    classifyAuthError.mockReturnValue('unknown');
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('shows the pending-verification indicator and a resend control while the address is unverified', () => {
    renderWith('authenticated');

    expect(screen.getByText(PENDING_VERIFICATION_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole('button', RESEND_CONTROL)).toBeInTheDocument();
  });

  it.each([
    ['a verified address', 'authenticated' as SessionStatus, { ...SESSION, emailVerified: true }],
    ['no Session', 'unauthenticated' as SessionStatus, null],
    ['an unknown Session state', 'loading' as SessionStatus, null],
  ])('renders nothing for %s', (_case, status, session) => {
    const { container } = renderWith(status, session);

    expect(container).toBeEmptyDOMElement();
  });

  it('resends the verification message and confirms it, by keyboard', async () => {
    const user = userEvent.setup();
    renderWith('authenticated');

    screen.getByRole('button', RESEND_CONTROL).focus();
    await user.keyboard('{Enter}');

    await waitFor(() => expect(sendVerificationEmail).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(new RegExp(VERIFICATION_SENT_MESSAGE, 'i'))).toBeInTheDocument();
    expect(storedAttempts()).toHaveLength(1);
  });

  it('sends nothing for a second request inside the 60 second interval and names when the next resend becomes available', async () => {
    const user = userEvent.setup();
    renderWith('authenticated');

    await user.click(screen.getByRole('button', RESEND_CONTROL));
    await waitFor(() => expect(sendVerificationEmail).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', RESEND_CONTROL));

    expect(await screen.findByText(NEXT_RESEND_PATTERN)).toBeInTheDocument();
    expect(sendVerificationEmail).toHaveBeenCalledTimes(1);
  });

  it('holds the interval across a reload, naming the seconds still remaining', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      VERIFICATION_RESENDS_KEY,
      JSON.stringify({ [SESSION.userId]: [Date.now() - 30_000] })
    );

    renderWith('authenticated');

    expect(await screen.findByText(NEXT_RESEND_PATTERN)).toBeInTheDocument();

    await user.click(screen.getByRole('button', RESEND_CONTROL));

    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });

  it('admits a resend once the interval has elapsed', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      VERIFICATION_RESENDS_KEY,
      JSON.stringify({ [SESSION.userId]: [Date.now() - 61_000] })
    );

    renderWith('authenticated');

    await user.click(screen.getByRole('button', RESEND_CONTROL));

    await waitFor(() => expect(sendVerificationEmail).toHaveBeenCalledTimes(1));
  });

  it('discharges the interval when the send fails, so another attempt is admitted at once', async () => {
    const user = userEvent.setup();
    sendVerificationEmail.mockRejectedValueOnce(new Error('network down'));
    renderWith('authenticated');

    await user.click(screen.getByRole('button', RESEND_CONTROL));

    expect(await screen.findByRole('alert')).toHaveTextContent(RESEND_FAILED_MESSAGE);
    expect(storedAttempts()).toHaveLength(0);

    await user.click(screen.getByRole('button', RESEND_CONTROL));

    await waitFor(() => expect(sendVerificationEmail).toHaveBeenCalledTimes(2));
  });

  it("reports the Auth_Service's own rate limit distinctly", async () => {
    const user = userEvent.setup();
    sendVerificationEmail.mockRejectedValueOnce(new Error('too many'));
    classifyAuthError.mockReturnValue('too-many-requests');
    renderWith('authenticated');

    await user.click(screen.getByRole('button', RESEND_CONTROL));

    expect(await screen.findByRole('alert')).toHaveTextContent(RESEND_RATE_LIMITED_MESSAGE);
  });
});
