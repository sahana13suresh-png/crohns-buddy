import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Home from './page';

const sessionState = {
  session: null,
  status: 'unauthenticated' as const,
  expiredMessage: null,
  planViewEpoch: 0,
  signOut: vi.fn(),
  dismissExpiredMessage: vi.fn(),
  redirectOutcome: null,
  clearRedirectOutcome: vi.fn(),
};

vi.mock('@/components/auth/SessionProvider', () => ({
  useSession: () => sessionState,
}));

describe('Home application shell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mounts the saved-plan view inside the meal planner', async () => {
    const user = userEvent.setup();
    render(<Home />);

    await user.click(screen.getByRole('tab', { name: 'AI Meal Planner' }));

    expect(screen.getByRole('heading', { name: 'AI Meal Planner' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Saved Meal Plans' })).toBeInTheDocument();
    expect(
      screen.getByText('Viewing saved meal plans requires signing in.')
    ).toBeInTheDocument();
  });

  it('makes account settings reachable from the main navigation', async () => {
    const user = userEvent.setup();
    render(<Home />);

    await user.click(screen.getByRole('tab', { name: 'Account' }));

    expect(screen.getByRole('heading', { name: 'Account settings' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Privacy Notice' })).toHaveAttribute(
      'href',
      '/privacy'
    );
  });
});
