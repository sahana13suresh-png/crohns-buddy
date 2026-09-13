import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SavePlanControl, {
  ACCOUNT_REQUIRED_MESSAGE,
  RETRY_LABEL,
  SAVED_MESSAGE,
  SAVE_LABEL,
  UPDATED_MESSAGE,
  UPDATE_LABEL,
} from './SavePlanControl';
import { STORAGE_NOTICE_DECLINED_MESSAGE } from './StorageNoticeDialog';
import type { SessionContextValue, SessionStatus } from '@/components/auth/SessionProvider';
import type { MealPlanContent } from '@/lib/types';

// The Session state is an input to this control, so it is supplied directly.
const { mockUseSession } = vi.hoisted(() => ({ mockUseSession: vi.fn() }));
vi.mock('@/components/auth/SessionProvider', () => ({ useSession: mockUseSession }));

// `callApi` is exercised for real — only its two `auth.ts` touchpoints are
// replaced, which is what keeps the Firebase SDK out of this test.
vi.mock('@/lib/auth', () => ({
  getIdTokenForRequest: vi.fn(async () => 'token-1'),
  signOutEverywhere: vi.fn(async () => undefined),
}));

const PLAN: MealPlanContent = {
  meals: [{ mealName: 'Breakfast', items: [{ name: 'Oatmeal', portion: '1 cup' }] }],
  summary: 'A gentle start to the day.',
};

function sessionValue(status: SessionStatus): SessionContextValue {
  return {
    session: null,
    status,
    expiredMessage: null,
    planViewEpoch: 0,
    signOut: vi.fn(),
    dismissExpiredMessage: vi.fn(),
    redirectOutcome: null,
    clearRedirectOutcome: vi.fn(),
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Queues one response per call, so a retry can differ from the first attempt. */
function stubFetch(...responses: Array<() => Response>) {
  const spy = vi.fn(async (_path: string, _init?: RequestInit) => {
    const next = responses.length > 1 ? responses.shift()! : responses[0];
    return next();
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

/** The path and parsed body of the nth request the control sent. */
function requestOf(spy: ReturnType<typeof stubFetch>, index = 0) {
  const call = spy.mock.calls[index];
  if (call === undefined) throw new Error(`No request at index ${index}.`);
  const [path, init] = call;
  return {
    path,
    method: init?.method,
    body: JSON.parse(String(init?.body)) as Record<string, unknown>,
  };
}

function renderControl(
  status: SessionStatus,
  props: Partial<React.ComponentProps<typeof SavePlanControl>> = {}
) {
  mockUseSession.mockReturnValue(sessionValue(status));
  const onSaved = props.onSaved ?? vi.fn();
  const view = render(
    <SavePlanControl
      mealPlan={PLAN}
      savedMealPlanId={props.savedMealPlanId ?? null}
      onSaved={onSaved}
      {...(props.title === undefined ? {} : { title: props.title })}
    />
  );
  return { ...view, onSaved };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('SavePlanControl', () => {
  it('shows the save control while a Session is active (5.1)', () => {
    renderControl('authenticated');

    expect(screen.getByRole('button', { name: SAVE_LABEL })).toBeInTheDocument();
    expect(screen.queryByText(ACCOUNT_REQUIRED_MESSAGE)).not.toBeInTheDocument();
  });

  it('shows the account-required message and no control with no Session (5.12)', () => {
    renderControl('unauthenticated');

    expect(screen.getByText(ACCOUNT_REQUIRED_MESSAGE)).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('creates the record with POST and confirms the save (5.2, 5.10)', async () => {
    const user = userEvent.setup();
    const spy = stubFetch(() =>
      jsonResponse(201, {
        mealPlanId: '01HZY000000000000000000000',
        title: 'Meal plan — 2025-03-04',
        createdAt: '2025-03-04T00:00:00.000Z',
        updatedAt: '2025-03-04T00:00:00.000Z',
      })
    );
    const { onSaved } = renderControl('authenticated');

    await user.click(screen.getByRole('button', { name: SAVE_LABEL }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(SAVED_MESSAGE));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(requestOf(spy)).toEqual({
      path: '/api/meal-plans',
      method: 'POST',
      body: { mealPlan: PLAN },
    });
    expect(onSaved).toHaveBeenCalledWith('01HZY000000000000000000000');
  });

  it('updates the same record with PUT once an id is held (5.13)', async () => {
    const user = userEvent.setup();
    const spy = stubFetch(() =>
      jsonResponse(200, { mealPlanId: 'id-1', updatedAt: '2025-03-05T00:00:00.000Z' })
    );
    renderControl('authenticated', { savedMealPlanId: 'id-1' });

    await user.click(screen.getByRole('button', { name: UPDATE_LABEL }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(UPDATED_MESSAGE));
    expect(requestOf(spy)).toEqual({
      path: '/api/meal-plans/id-1',
      method: 'PUT',
      body: { content: PLAN },
    });
  });

  it('reports a failure with a control that resubmits the same request (5.11)', async () => {
    const user = userEvent.setup();
    const spy = stubFetch(
      () => jsonResponse(503, { message: 'Saved meal plans are temporarily unreachable.' }),
      () => jsonResponse(201, { mealPlanId: 'id-2' })
    );
    const { onSaved } = renderControl('authenticated');

    await user.click(screen.getByRole('button', { name: SAVE_LABEL }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Saved meal plans are temporarily unreachable.'
      )
    );
    // The save control is still there — the failure added a message, it did not
    // replace the view.
    expect(screen.getByRole('button', { name: SAVE_LABEL })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: RETRY_LABEL }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('id-2'));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(requestOf(spy, 1)).toEqual(requestOf(spy, 0));
  });

  it('opens the storage notice on ack-required and resubmits acknowledged (12.3)', async () => {
    const user = userEvent.setup();
    const spy = stubFetch(
      () => jsonResponse(428, { message: 'Acknowledge the storage notice.' }),
      () => jsonResponse(201, { mealPlanId: 'id-3' })
    );
    const { onSaved } = renderControl('authenticated');

    await user.click(screen.getByRole('button', { name: SAVE_LABEL }));

    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Acknowledge and Save' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('id-3'));
    expect(requestOf(spy, 1).body).toEqual({ mealPlan: PLAN, acknowledgeStorage: true });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('writes nothing when the storage notice is declined (12.5)', async () => {
    const user = userEvent.setup();
    const spy = stubFetch(() => jsonResponse(428, { message: 'Acknowledge the storage notice.' }));
    const { onSaved } = renderControl('authenticated');

    await user.click(screen.getByRole('button', { name: SAVE_LABEL }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: "Don't Save" }));

    expect(screen.getByRole('status')).toHaveTextContent(STORAGE_NOTICE_DECLINED_MESSAGE);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: SAVE_LABEL })).toBeInTheDocument();
  });

  it('renders nothing until the first Session state is known', () => {
    const { container } = renderControl('loading');

    expect(container).toBeEmptyDOMElement();
  });
});
