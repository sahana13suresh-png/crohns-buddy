import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeletePlanDialog, {
  DELETE_FAILED_MESSAGE,
  type DeletablePlan,
} from './DeletePlanDialog';
import type { ApiResult } from '@/lib/apiClient';

/**
 * Requirement 8.2 is a statement about the prompt's shape, so these tests count
 * controls and assert that nothing is sent before the confirm control is
 * activated. Requirements 8.1 and 8.5 are about what the owner of the row list is
 * told: the Meal_Plan_Id on success, and nothing at all on failure.
 */

const callApi = vi.fn<(path: string, init?: RequestInit) => Promise<ApiResult<unknown>>>();

vi.mock('@/lib/apiClient', () => ({
  callApi: (path: string, init?: RequestInit) => callApi(path, init),
}));

const PLAN: DeletablePlan = { mealPlanId: '01HZY3KTQ8V4WJ7M2N5P6R8S9T', title: 'Low-fibre week' };

const CONFIRM_CONTROL = { name: /^delete plan$/i } as const;
const CANCEL_CONTROL = { name: /^cancel$/i } as const;

function renderDialog(overrides: Partial<Parameters<typeof DeletePlanDialog>[0]> = {}) {
  const props = {
    plan: PLAN,
    onDeleted: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(<DeletePlanDialog {...props} />);
  return props;
}

describe('DeletePlanDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callApi.mockResolvedValue({ ok: true } as ApiResult<unknown>);
  });

  it('names the record by title and offers exactly one confirm and one cancel control', () => {
    renderDialog();

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName(/delete meal plan/i);
    expect(screen.getByText(new RegExp(PLAN.title))).toBeInTheDocument();

    expect(screen.getAllByRole('button', CONFIRM_CONTROL)).toHaveLength(1);
    expect(screen.getAllByRole('button', CANCEL_CONTROL)).toHaveLength(1);
    expect(screen.getAllByRole('button')).toHaveLength(2);
    // Requirement 8.2 — nothing goes out until confirm is activated.
    expect(callApi).not.toHaveBeenCalled();
  });

  it('sends nothing when the prompt is cancelled', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(screen.getByRole('button', CANCEL_CONTROL));

    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(callApi).not.toHaveBeenCalled();
    expect(props.onDeleted).not.toHaveBeenCalled();
  });

  it('deletes on confirm and reports the removed record, by keyboard', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    screen.getByRole('button', CONFIRM_CONTROL).focus();
    await user.keyboard('{Enter}');

    await waitFor(() => expect(props.onDeleted).toHaveBeenCalledTimes(1));
    expect(callApi).toHaveBeenCalledWith(
      `/api/meal-plans/${PLAN.mealPlanId}`,
      expect.objectContaining({ method: 'DELETE' })
    );
    expect(props.onDeleted).toHaveBeenCalledWith(PLAN.mealPlanId);
  });

  it.each([
    ['the store is unavailable', 'unavailable' as const],
    ['the request times out', 'timeout' as const],
  ])('keeps the record and the delete control available when %s', async (_case, kind) => {
    const user = userEvent.setup();
    callApi.mockResolvedValue({ ok: false, kind, message: 'server said no' });
    const props = renderDialog();

    await user.click(screen.getByRole('button', CONFIRM_CONTROL));

    // Requirement 8.5 — a message, no removal, and the control ready for another try.
    expect(await screen.findByRole('alert')).toHaveTextContent(DELETE_FAILED_MESSAGE);
    expect(props.onDeleted).not.toHaveBeenCalled();
    expect(screen.getByRole('button', CONFIRM_CONTROL)).toBeEnabled();

    await user.click(screen.getByRole('button', CONFIRM_CONTROL));

    expect(callApi).toHaveBeenCalledTimes(2);
  });

  it("passes through the API's wording when the record is not this Account's", async () => {
    const user = userEvent.setup();
    callApi.mockResolvedValue({
      ok: false,
      kind: 'not-found',
      message: 'That meal plan is not available to this account.',
    });
    const props = renderDialog();

    await user.click(screen.getByRole('button', CONFIRM_CONTROL));

    expect(await screen.findByRole('alert')).toHaveTextContent(/not available to this account/i);
    expect(props.onDeleted).not.toHaveBeenCalled();
  });

  it('treats a record the store no longer holds as removed', async () => {
    const user = userEvent.setup();
    // Requirement 8.3 — the Meal_Plan_API answers 204, which `callApi` reports as
    // a success with no body.
    callApi.mockResolvedValue({ ok: true } as ApiResult<unknown>);
    const props = renderDialog();

    await user.click(screen.getByRole('button', CONFIRM_CONTROL));

    await waitFor(() => expect(props.onDeleted).toHaveBeenCalledWith(PLAN.mealPlanId));
  });
});
