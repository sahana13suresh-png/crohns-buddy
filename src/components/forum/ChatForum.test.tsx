import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChatForum from './ChatForum';
import type { AuthSession, GoogleSignInOutcome } from '@/lib/auth';
import type { ForumMessage } from '@/lib/types';

/**
 * The Auth_Service and Firestore are module boundaries the forum depends on, so
 * they are substituted here to drive the component through each auth outcome.
 * Every assertion is about ChatForum's own behavior: which session shape it
 * reads, and which message it shows for each `GoogleSignInOutcome` variant.
 */

const signInWithProvider =
  vi.fn<
    (
      provider:
        | 'Google'
        | 'Facebook',
    ) => Promise<GoogleSignInOutcome>
  >();
const signOut = vi.fn<() => Promise<void>>();
let emitSession: (session: AuthSession | null) => void = () => {};

vi.mock('@/lib/auth', () => ({
  signInWithProvider: (
    provider:
      | 'Google'
      | 'Facebook',
  ) => signInWithProvider(provider),
  signOut: () => signOut(),
  onAuthChange: (callback: (session: AuthSession | null) => void) => {
    emitSession = callback;
    callback(null);
    return () => {};
  },
}));

const postForumMessage =
  vi.fn<(displayName: string, content: string, removed?: boolean, notice?: string) => Promise<string>>();

vi.mock('@/lib/firebase', () => ({
  postForumMessage: (displayName: string, content: string, removed?: boolean, notice?: string) =>
    postForumMessage(displayName, content, removed, notice),
  subscribeToForumMessages: (callback: (messages: ForumMessage[]) => void) => {
    callback([]);
    return () => {};
  },
}));

/** Delivers a session change the way the Auth_Service would, inside `act`. */
function deliverSession(next: AuthSession | null): void {
  act(() => emitSession(next));
}

const SESSION: AuthSession = {
  userId: 'uid-1',
  displayName: 'Alice',
  email: 'alice@example.com',
  emailVerified: true,
  authTimeMs: 1_700_000_000_000,
  sessionStartedAtMs: 1_700_000_000_000,
};

describe('ChatForum', () => {
  beforeEach(() => {
    // The signin control mirrors the Deployment_Configuration (Requirement 3.10),
    // so the provider list has to be configured for it to render at all.
    vi.stubEnv('NEXT_PUBLIC_AUTH_PROVIDERS', 'google');
    signInWithProvider.mockReset();
    signOut.mockReset().mockResolvedValue(undefined);
    postForumMessage.mockReset().mockResolvedValue('doc-1');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ json: async () => ({ approved: true }) })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('shows the sign-in prompt with no session and the composer once a session arrives', async () => {
    render(<ChatForum />);

    expect(await screen.findByRole('button', { name: /sign in with google/i })).toBeInTheDocument();

    deliverSession(SESSION);

    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign in with google/i })).not.toBeInTheDocument();
  });

  it('omits the sign-in prompt when no Identity_Provider is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_AUTH_PROVIDERS', '');
    render(<ChatForum />);

    await waitFor(() => expect(screen.getByLabelText('Forum messages')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /sign in with google/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/sign in to join the conversation/i)).not.toBeInTheDocument();
  });

  it('stays silent when the Patient cancels the provider window', async () => {
    signInWithProvider.mockResolvedValue({ status: 'cancelled' });
    render(<ChatForum />);

    await userEvent.click(await screen.findByRole('button', { name: /sign in with google/i }));

    await waitFor(() => expect(signInWithProvider).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([
    ['timed-out', /took too long/i],
    ['no-email', /email address/i],
    ['failed', /sign-in failed/i],
  ] as const)('explains the %s outcome', async (status, expected) => {
    signInWithProvider.mockResolvedValue(
      status === 'failed' ? { status, code: 'auth/internal-error' } : { status }
    );
    render(<ChatForum />);

    await userEvent.click(await screen.findByRole('button', { name: /sign in with google/i }));

    expect(await screen.findByText(expected)).toBeInTheDocument();
  });

  it('posts under the session display name', async () => {
    render(<ChatForum />);
    deliverSession(SESSION);

    const input = await screen.findByPlaceholderText('Type your message...');
    await userEvent.type(input, 'Hello everyone');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(postForumMessage).toHaveBeenCalledTimes(1));
    expect(postForumMessage.mock.calls[0].slice(0, 3)).toEqual(['Alice', 'Hello everyone', false]);
  });
});
