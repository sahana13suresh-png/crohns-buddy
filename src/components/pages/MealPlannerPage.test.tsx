import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MealPlannerPage from './MealPlannerPage';
import type { SessionContextValue } from '@/components/auth/SessionProvider';
import type { MealPlanRecord } from '@/lib/types';

// Only the two boundaries this page cannot own are replaced: the Session state
// and the chat interface, whose sole job here is to report the plan context it
// was handed. Everything else — the state transitions, `SavePlanControl`, the
// real `callApi` — runs for real.
const { mockUseSession } = vi.hoisted(() => ({ mockUseSession: vi.fn() }));
vi.mock('@/components/auth/SessionProvider', () => ({ useSession: mockUseSession }));

vi.mock('@/components/planner/AIChatInterface', () => ({
  default: ({ currentMealPlan }: { currentMealPlan: string }) => (
    <div data-testid="chat-context">{currentMealPlan}</div>
  ),
}));

vi.mock('@/lib/auth', () => ({
  getIdTokenForRequest: vi.fn(async () => 'token-1'),
  signOutEverywhere: vi.fn(async () => undefined),
}));

const AUTHENTICATED: SessionContextValue = {
  session: null,
  status: 'authenticated',
  expiredMessage: null,
  planViewEpoch: 0,
  signOut: vi.fn(),
  dismissExpiredMessage: vi.fn(),
  redirectOutcome: null,
  clearRedirectOutcome: vi.fn(),
};

function recordFor(marker: string, mealPlanId: string): MealPlanRecord {
  return {
    userId: 'uid-1',
    mealPlanId,
    title: `Plan ${marker}`,
    createdAt: '2025-03-04T00:00:00.000Z',
    updatedAt: '2025-03-04T00:00:00.000Z',
    content: {
      meals: [{ mealName: 'Breakfast', items: [{ name: marker, portion: '1 cup' }] }],
      summary: `Summary ${marker}`,
    },
  };
}

const PLAN_A = recordFor('Oatmeal', '01HZY00000000000000000000A');
const PLAN_B = recordFor('White rice', '01HZY00000000000000000000B');

/**
 * Renders the page with a stand-in saved-plans panel: one control per record
 * that reopens it, which is exactly the surface `SavedPlansList` will drive.
 */
function renderPage() {
  mockUseSession.mockReturnValue(AUTHENTICATED);
  return render(
    <MealPlannerPage
      renderSavedPlans={(openStoredPlan) => (
        <div>
          {[PLAN_A, PLAN_B].map((record) => (
            <button key={record.mealPlanId} type="button" onClick={() => openStoredPlan(record)}>
              {record.title}
            </button>
          ))}
        </div>
      )}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('MealPlannerPage saved-plan integration', () => {
  it('supplies a reopened plan as the chat context and stops supplying the previous one (6.7)', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Plan Oatmeal' }));

    const contextA = await screen.findByTestId('chat-context');
    expect(contextA).toHaveTextContent('Oatmeal');
    expect(contextA).toHaveTextContent('Summary Oatmeal');

    await user.click(screen.getByRole('button', { name: 'Plan White rice' }));

    const contextB = screen.getByTestId('chat-context');
    expect(contextB).toHaveTextContent('White rice');
    expect(contextB).not.toHaveTextContent('Oatmeal');
  });

  it('saves a reopened plan against its own record rather than creating another (5.13)', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn(
      async (_path: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ mealPlanId: PLAN_A.mealPlanId, updatedAt: '2025-03-05T00:00:00.000Z' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );
    vi.stubGlobal('fetch', fetchSpy);
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Plan Oatmeal' }));
    await user.click(screen.getByRole('button', { name: 'Update Saved Plan' }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [path, init] = fetchSpy.mock.calls[0]!;
    expect(path).toBe(`/api/meal-plans/${PLAN_A.mealPlanId}`);
    expect(init?.method).toBe('PUT');
  });
});
