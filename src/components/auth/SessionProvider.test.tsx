import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SessionProvider, { useSession } from './SessionProvider';
import type { AuthSession } from '@/lib/auth';
import { callApi, clearUnauthorizedListeners, SESSION_EXPIRED_MESSAGE } from '@/lib/apiClient';

// The 30-day check itself stays real — `isSessionActive` and SESSION_MAX_AGE_MS
// are the behavior under test. Only the Auth_Service boundary is replaced.
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    onAuthChange: vi.fn(),
    signOutEverywhere: vi.fn(async () => undefined),
    completeRedirectSignIn: vi.fn(async () => null),
  };
});

const auth = await import('@/lib/auth');
const onAuthChange = vi.mocked(auth.onAuthChange);
const signOutEverywhere = vi.mocked(auth.signOutEverywhere);
const completeRedirectSignIn = vi.mocked(auth.completeRedirectSignIn);

const DAY_MS = 24 * 60 * 60 * 1000;

function sessionStartedAt(startedAtMs: number): AuthSession {
  return {
    userId: 'uid-1',
    displayName: 'Riley',
    email: 'riley@example.com',
    emailVerified: true,
    authTimeMs: startedAtMs,
    sessionStartedAtMs: startedAtMs,
  };
}

/** Emits the callback `onAuthChange` was given, the way Firebase would. */
let emit: (session: AuthSession | null) => void;

function Probe() {
  const { session, status, expiredMessage, planViewEpoch, signOut } = useSession();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="name">{session?.displayName ?? 'none'}</span>
      <span data-testid="epoch">{planViewEpoch}</span>
      <span data-testid="message">{expiredMessage ?? 'no-message'}</span>
      <button onClick={() => void signOut()}>Log Out</button>
    </div>
  );
}

function renderProvider() {
  return render(
    <SessionProvider>
      <Probe />
    </SessionProvider>
  );
}

beforeEach(() => {
  clearUnauthorizedListeners();
  onAuthChange.mockReset();
  signOutEverywhere.mockReset();
  signOutEverywhere.mockResolvedValue(undefined);
  completeRedirectSignIn.mockReset();
  completeRedirectSignIn.mockResolvedValue(null);
  onAuthChange.mockImplementation((callback) => {
    emit = callback;
    return () => {};
  });
});

afterEach(() => {
  clearUnauthorizedListeners();
});

describe('SessionProvider', () => {
  it('restores a Session whose 30 days have not elapsed (Req 2.5)', async () => {
    renderProvider();
    await act(async () => emit(sessionStartedAt(Date.now() - 29 * DAY_MS)));

    expect(screen.getByTestId('status')).toHaveTextContent('authenticated');
    expect(screen.getByTestId('name')).toHaveTextContent('Riley');
    expect(screen.getByTestId('message')).toHaveTextContent('no-message');
    expect(signOutEverywhere).not.toHaveBeenCalled();
  });

  it('treats a browser holding no Session as unauthenticated with no expiry message (Req 2.6)', async () => {
    renderProvider();
    await act(async () => emit(null));

    expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated');
    expect(screen.getByTestId('message')).toHaveTextContent('no-message');
    // Nothing was displayed, so nothing was cleared.
    expect(screen.getByTestId('epoch')).toHaveTextContent('0');
  });

  it('expires a Session past 30 days, clearing the plan view and showing the message (Req 2.13)', async () => {
    renderProvider();
    await act(async () => emit(sessionStartedAt(Date.now() - 31 * DAY_MS)));

    expect(screen.getByTestId('status')).toHaveTextContent('expired');
    expect(screen.getByTestId('name')).toHaveTextContent('none');
    expect(screen.getByTestId('message')).toHaveTextContent(SESSION_EXPIRED_MESSAGE);
    expect(screen.getByTestId('epoch')).toHaveTextContent('1');
    expect(signOutEverywhere).toHaveBeenCalledTimes(1);
  });

  it('keeps the expiry message when the Auth_Service then reports no user', async () => {
    renderProvider();
    await act(async () => emit(sessionStartedAt(Date.now() - 31 * DAY_MS)));
    await act(async () => emit(null));

    expect(screen.getByTestId('status')).toHaveTextContent('expired');
    expect(screen.getByTestId('message')).toHaveTextContent(SESSION_EXPIRED_MESSAGE);
  });

  it('clears the plan view on signout even when the Auth_Service never responds (Req 2.8)', async () => {
    // A signout request that never settles: the local Session must still go.
    signOutEverywhere.mockImplementation(() => new Promise<void>(() => {}));
    renderProvider();
    await act(async () => emit(sessionStartedAt(Date.now() - DAY_MS)));
    expect(screen.getByTestId('status')).toHaveTextContent('authenticated');

    await userEvent.click(screen.getByRole('button', { name: 'Log Out' }));

    expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated');
    expect(screen.getByTestId('name')).toHaveTextContent('none');
    expect(screen.getByTestId('epoch')).toHaveTextContent('1');
    // Signout is not an expiry, so no expiry message.
    expect(screen.getByTestId('message')).toHaveTextContent('no-message');
  });

  it('takes a credential refusal down the same path as an elapsed Session (Req 2.13)', async () => {
    renderProvider();
    await act(async () => emit(sessionStartedAt(Date.now() - DAY_MS)));
    expect(screen.getByTestId('status')).toHaveTextContent('authenticated');

    // A real 401 through `callApi`, which is what notifies the provider.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    await act(async () => {
      await callApi('/api/meal-plans');
    });
    vi.unstubAllGlobals();

    expect(screen.getByTestId('status')).toHaveTextContent('expired');
    expect(screen.getByTestId('message')).toHaveTextContent(SESSION_EXPIRED_MESSAGE);
    expect(screen.getByTestId('epoch')).toHaveTextContent('1');
  });

  it('reconciles a redirect-based provider sign-in on mount', async () => {
    completeRedirectSignIn.mockResolvedValue({ status: 'no-email' });
    function OutcomeProbe() {
      const { redirectOutcome } = useSession();
      return <span data-testid="outcome">{redirectOutcome?.status ?? 'none'}</span>;
    }
    await act(async () => {
      render(
        <SessionProvider>
          <OutcomeProbe />
        </SessionProvider>
      );
    });

    expect(completeRedirectSignIn).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('outcome')).toHaveTextContent('no-email');
  });

  it('throws when used outside a provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/within a SessionProvider/);
    spy.mockRestore();
  });
});
