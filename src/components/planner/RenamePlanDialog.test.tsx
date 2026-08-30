import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RenamePlanDialog, {
  RENAME_FAILED_MESSAGE,
  TITLE_BOUNDS_MESSAGE,
  type RenamablePlan,
} from './RenamePlanDialog';
import type { ApiResult } from '@/lib/apiClient';

/**
 * The Meal_Plan_API is the only boundary replaced here. What is under test is the
 * ordering this component owns: validation before any request (Requirement 8.6),
 * the optimistic apply, and the restore of the captured pre-rename title on
 * failure (Requirement 8.8).
 */

const callApi = vi.fn<(path: string, init?: RequestInit) => Promise<ApiResult<unknown>>>();

vi.mock('@/lib/apiClient', () => ({
  callApi: (path: string, init?: RequestInit) => callApi(path, init),
}));

const PLAN: RenamablePlan = { mealPlanId: '01HZY3KTQ8V4WJ7M2N5P6R8S9T', title: 'Low-fibre week' };

const SAVE_CONTROL = { name: /save title/i } as const;

function renderDialog(overrides: Partial<Parameters<typeof RenamePlanDialog>[0]> = {}) {
  const props = {
    plan: PLAN,
    onApplyTitle: vi.fn(),
    onRenamed: vi.fn(),
    onRestoreTitle: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(<RenamePlanDialog {...props} />);
  return props;
}

function titleField(): HTMLInputElement {
  return screen.getByLabelText(/title/i) as HTMLInputElement;
}

describe('RenamePlanDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callApi.mockResolvedValue({
      ok: true,
      data: { title: 'Renamed', updatedAt: '2025-03-01T10:00:00.000Z' },
    });
  });

  it('opens as a labelled modal seeded with the stored title', () => {
    renderDialog();

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName(/rename meal plan/i);
    expect(titleField()).toHaveValue(PLAN.title);
  });

  it.each([
    ['an empty title', ''],
    ['a whitespace-only title', '   '],
    ['a title of 101 characters after trimming', `  ${'a'.repeat(101)}  `],
  ])('rejects %s with no request sent and the row left alone', async (_case, entered) => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.clear(titleField());
    if (entered.length > 0) await user.type(titleField(), entered);
    await user.click(screen.getByRole('button', SAVE_CONTROL));

    expect(await screen.findByRole('alert')).toHaveTextContent(TITLE_BOUNDS_MESSAGE);
    // Requirement 8.6 — nothing reaches the Meal_Plan_API and the stored title is
    // still the one on the row, because no optimistic apply happened.
    expect(callApi).not.toHaveBeenCalled();
    expect(props.onApplyTitle).not.toHaveBeenCalled();
    expect(props.onRenamed).not.toHaveBeenCalled();
  });

  it('sends the trimmed title, applies it optimistically, and reports the stored value', async () => {
    const user = userEvent.setup();
    callApi.mockResolvedValue({
      ok: true,
      data: { title: 'Winter plan', updatedAt: '2025-03-01T10:00:00.000Z' },
    });
    const props = renderDialog();

    await user.clear(titleField());
    await user.type(titleField(), '  Winter plan  ');
    await user.click(screen.getByRole('button', SAVE_CONTROL));

    await waitFor(() => expect(props.onRenamed).toHaveBeenCalledTimes(1));
    expect(callApi).toHaveBeenCalledWith(
      `/api/meal-plans/${PLAN.mealPlanId}`,
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ title: 'Winter plan' }) })
    );
    expect(props.onApplyTitle).toHaveBeenCalledWith(PLAN.mealPlanId, 'Winter plan');
    expect(props.onRenamed).toHaveBeenCalledWith({
      mealPlanId: PLAN.mealPlanId,
      title: 'Winter plan',
      previousTitle: PLAN.title,
      updatedAt: '2025-03-01T10:00:00.000Z',
    });
    expect(props.onRestoreTitle).not.toHaveBeenCalled();
  });

  it('accepts a title of exactly 100 characters', async () => {
    const user = userEvent.setup();
    const atBound = 'b'.repeat(100);
    callApi.mockResolvedValue({ ok: true, data: { title: atBound, updatedAt: 'x' } });
    const props = renderDialog();

    await user.clear(titleField());
    await user.type(titleField(), atBound);
    await user.click(screen.getByRole('button', SAVE_CONTROL));

    await waitFor(() => expect(props.onRenamed).toHaveBeenCalledTimes(1));
    expect(callApi).toHaveBeenCalledTimes(1);
  });

  it('restores the captured pre-rename title exactly when the store is unreachable', async () => {
    const user = userEvent.setup();
    callApi.mockResolvedValue({ ok: false, kind: 'unavailable', message: 'down' });
    const props = renderDialog();

    await user.clear(titleField());
    await user.type(titleField(), 'Attempted title');
    await user.click(screen.getByRole('button', SAVE_CONTROL));

    // Requirement 8.8 — a message, and the previously stored title back on the row.
    expect(await screen.findByRole('alert')).toHaveTextContent(RENAME_FAILED_MESSAGE);
    expect(props.onApplyTitle).toHaveBeenCalledWith(PLAN.mealPlanId, 'Attempted title');
    expect(props.onRestoreTitle).toHaveBeenCalledWith(PLAN.mealPlanId, PLAN.title);
    expect(props.onRenamed).not.toHaveBeenCalled();
    // Another attempt is available.
    expect(screen.getByRole('button', SAVE_CONTROL)).toBeEnabled();
  });

  it('restores the title and reports a timeout the same way', async () => {
    const user = userEvent.setup();
    callApi.mockResolvedValue({ ok: false, kind: 'timeout', message: 'took too long' });
    const props = renderDialog();

    await user.click(screen.getByRole('button', SAVE_CONTROL));

    expect(await screen.findByRole('alert')).toHaveTextContent(RENAME_FAILED_MESSAGE);
    expect(props.onRestoreTitle).toHaveBeenCalledWith(PLAN.mealPlanId, PLAN.title);
  });

  it("passes through the API's wording when the record is not this Account's", async () => {
    const user = userEvent.setup();
    callApi.mockResolvedValue({
      ok: false,
      kind: 'not-found',
      message: 'That meal plan is not available to this account.',
    });
    const props = renderDialog();

    await user.click(screen.getByRole('button', SAVE_CONTROL));

    expect(await screen.findByRole('alert')).toHaveTextContent(/not available to this account/i);
    expect(props.onRestoreTitle).toHaveBeenCalledWith(PLAN.mealPlanId, PLAN.title);
  });

  it('cancels without sending anything', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(callApi).not.toHaveBeenCalled();
  });
});
