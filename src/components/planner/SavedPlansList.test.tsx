import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SavedPlansList, {
  appendPage,
  applyRenamedTitle,
  CANNOT_OPEN_MESSAGE,
  EMPTY_MESSAGE,
  formatCreatedDate,
  isRenderableRecord,
  LOAD_MORE_LABEL,
  removePlanRow,
  RETRY_LABEL,
  SIGNED_OUT_MESSAGE,
  UNREACHABLE_MESSAGE,
} from './SavedPlansList';
import type { SessionContextValue, SessionStatus } from '@/components/auth/SessionProvider';
import type { ApiResult } from '@/lib/apiClient';
import type { MealPlanRecord, MealPlanSummary } from '@/lib/types';

// The Session and the API are this component's two inputs, so both are supplied
// directly. Everything else under test — the rows, the ordering, the progress
// indicator, the error and empty states, the load-more control — is real.
const { mockUseSession, mockCallApi } = vi.hoisted(() => ({
  mockUseSession: vi.fn(),
  mockCallApi: vi.fn(),
}));

vi.mock('@/components/auth/SessionProvider', () => ({ useSession: mockUseSession }));
vi.mock('@/lib/apiClient', () => ({ callApi: mockCallApi }));

// Task 10.14 owns these dialogs. They are stubbed to the prop contract this
// component calls them with, so the list's own rename/delete state is exercised
// without depending on their internals.
vi.mock('./RenamePlanDialog', () => ({
  default: ({
    plan,
    onApplyTitle,
    onRenamed,
    onRestoreTitle,
    onCancel,
  }: {
    plan: MealPlanSummary;
    onApplyTitle?: (mealPlanId: string, title: string) => void;
    onRenamed: (outcome: { mealPlanId: string; title: string; previousTitle: string }) => void;
    onRestoreTitle?: (mealPlanId: string, previousTitle: string) => void;
    onCancel: () => void;
  }) => (
    <div role="dialog" aria-label={`Rename ${plan.title}`}>
      <button type="button" onClick={() => onApplyTitle?.(plan.mealPlanId, 'Renamed plan')}>
        apply-rename
      </button>
      <button
        type="button"
        onClick={() =>
          onRenamed({
            mealPlanId: plan.mealPlanId,
            title: 'Renamed plan',
            previousTitle: plan.title,
          })
        }
      >
        confirm-rename
      </button>
      <button
        type="button"
        onClick={() => onRestoreTitle?.(plan.mealPlanId, 'Low-residue week')}
      >
        restore-rename
      </button>
      <button type="button" onClick={onCancel}>
        cancel-rename
      </button>
    </div>
  ),
}));

vi.mock('./DeletePlanDialog', () => ({
  default: ({
    plan,
    onDeleted,
    onCancel,
  }: {
    plan: MealPlanSummary;
    onDeleted: (mealPlanId: string) => void;
    onCancel: () => void;
  }) => (
    <div role="dialog" aria-label={`Delete ${plan.title}`}>
      <button type="button" onClick={() => onDeleted(plan.mealPlanId)}>
        confirm-delete
      </button>
      <button type="button" onClick={onCancel}>
        cancel-delete
      </button>
    </div>
  ),
}));

// ─── Fixtures ──────────────────────────────────────────────────────────────────

function summary(id: string, title: string, createdAt: string): MealPlanSummary {
  return { mealPlanId: id, title, createdAt, updatedAt: createdAt };
}

const PAGE_ONE = [
  summary('01HZ0000000000000000000001', 'Low-residue week', '2025-03-14T09:30:00.000Z'),
  summary('01HZ0000000000000000000002', 'Flare-friendly plan', '2025-02-01T18:05:12.250Z'),
];

const PAGE_TWO = [
  summary('01HZ0000000000000000000003', 'Reintroduction plan', '2025-01-09T07:00:00.000Z'),
];

const RECORD: MealPlanRecord = {
  userId: 'uid-1',
  mealPlanId: PAGE_ONE[0].mealPlanId,
  title: PAGE_ONE[0].title,
  createdAt: PAGE_ONE[0].createdAt,
  updatedAt: PAGE_ONE[0].createdAt,
  content: {
    meals: [
      {
        mealName: 'Breakfast',
        items: [{ name: 'Oatmeal', portion: '1 cup', notes: 'Cook until very soft' }],
      },
      {
        mealName: 'Lunch',
        items: [{ name: 'Poached chicken', portion: '120 g' }],
      },
    ],
    summary: 'A gentle week of low-residue meals.',
    warnings: ['Introduce one new food at a time.'],
  },
};

function sessionValue(status: SessionStatus, planViewEpoch = 0): SessionContextValue {
  return {
    session:
      status === 'authenticated'
        ? {
            userId: 'uid-1',
            displayName: 'Ada',
            email: 'ada@example.com',
            emailVerified: true,
            authTimeMs: 1_700_000_000_000,
            sessionStartedAtMs: 1_700_000_000_000,
          }
        : null,
    status,
    expiredMessage: null,
    planViewEpoch,
    signOut: vi.fn(),
    dismissExpiredMessage: vi.fn(),
    redirectOutcome: null,
    clearRedirectOutcome: vi.fn(),
  };
}

function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

function fail<T>(kind: 'unavailable' | 'timeout' | 'validation'): ApiResult<T> {
  return { ok: false, kind, message: 'server wording' };
}

function renderList(status: SessionStatus = 'authenticated', onOpenPlan?: (r: MealPlanRecord) => void) {
  mockUseSession.mockReturnValue(sessionValue(status));
  return render(<SavedPlansList onOpenPlan={onOpenPlan} />);
}

/** The visible list rows, in DOM order. */
function rowTitles(): string[] {
  const list = screen.queryByRole('list', { name: 'Saved meal plans' });
  if (list === null) return [];
  return within(list)
    .getAllByRole('listitem')
    .map((row) => row.querySelector('p')?.textContent ?? '');
}

describe('SavedPlansList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the signin-required message and no records with no Session', () => {
    renderList('unauthenticated');

    expect(screen.getByRole('status')).toHaveTextContent(SIGNED_OUT_MESSAGE);
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(mockCallApi).not.toHaveBeenCalled();
  });

  it('shows a progress indicator while the first page is in flight, then a row per record with its YYYY-MM-DD creation date', async () => {
    let resolvePage: ((value: ApiResult<unknown>) => void) | undefined;
    mockCallApi.mockReturnValueOnce(
      new Promise<ApiResult<unknown>>((resolve) => {
        resolvePage = resolve;
      })
    );

    renderList();

    expect(screen.getByRole('status')).toHaveTextContent(/loading/i);

    resolvePage?.(ok({ items: PAGE_ONE }));

    await waitFor(() =>
      expect(screen.getByRole('list', { name: 'Saved meal plans' })).toBeInTheDocument()
    );
    expect(rowTitles()).toEqual(['Low-residue week', 'Flare-friendly plan']);
    expect(screen.getByText('2025-03-14')).toBeInTheDocument();
    expect(screen.getByText('2025-02-01')).toBeInTheDocument();
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
    expect(mockCallApi).toHaveBeenCalledWith('/api/meal-plans');
  });

  it('shows the empty-state message and no rows when the Account owns none', async () => {
    mockCallApi.mockResolvedValueOnce(ok({ items: [] }));

    renderList();

    expect(await screen.findByText(EMPTY_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('appends the next page below the existing rows and removes the control on the final page', async () => {
    const user = userEvent.setup();
    mockCallApi
      .mockResolvedValueOnce(ok({ items: PAGE_ONE, nextCursor: 'cursor-1' }))
      .mockResolvedValueOnce(ok({ items: PAGE_TWO }));

    renderList();

    const loadMore = await screen.findByRole('button', { name: LOAD_MORE_LABEL });
    await user.click(loadMore);

    await waitFor(() => expect(rowTitles()).toHaveLength(3));
    expect(rowTitles()).toEqual(['Low-residue week', 'Flare-friendly plan', 'Reintroduction plan']);
    expect(mockCallApi).toHaveBeenLastCalledWith('/api/meal-plans?cursor=cursor-1');
    expect(screen.queryByRole('button', { name: LOAD_MORE_LABEL })).not.toBeInTheDocument();
  });

  it('keeps the displayed rows and offers a retry of the same page when a list request fails', async () => {
    const user = userEvent.setup();
    mockCallApi
      .mockResolvedValueOnce(ok({ items: PAGE_ONE, nextCursor: 'cursor-1' }))
      .mockResolvedValueOnce(fail('unavailable'))
      .mockResolvedValueOnce(ok({ items: PAGE_TWO }));

    renderList();

    await user.click(await screen.findByRole('button', { name: LOAD_MORE_LABEL }));

    expect(await screen.findByRole('alert')).toHaveTextContent(UNREACHABLE_MESSAGE);
    expect(rowTitles()).toEqual(['Low-residue week', 'Flare-friendly plan']);

    await user.click(screen.getByRole('button', { name: RETRY_LABEL }));

    await waitFor(() => expect(rowTitles()).toHaveLength(3));
    expect(mockCallApi).toHaveBeenLastCalledWith('/api/meal-plans?cursor=cursor-1');
  });

  it('reopens a record through the shared plan layout, preserving stored order', async () => {
    const user = userEvent.setup();
    const onOpenPlan = vi.fn();
    mockCallApi
      .mockResolvedValueOnce(ok({ items: PAGE_ONE }))
      .mockResolvedValueOnce(ok({ record: RECORD }));

    renderList('authenticated', onOpenPlan);

    await user.click(await screen.findByRole('button', { name: 'Open Low-residue week' }));

    expect(await screen.findByText('A gentle week of low-residue meals.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Breakfast' })).toBeInTheDocument();
    expect(screen.getByText('Oatmeal')).toBeInTheDocument();
    expect(screen.getByText('1 cup')).toBeInTheDocument();
    expect(screen.getByText(/Introduce one new food/)).toBeInTheDocument();
    // The list is still displayed alongside the reopened plan.
    expect(rowTitles()).toEqual(['Low-residue week', 'Flare-friendly plan']);
    expect(onOpenPlan).toHaveBeenCalledWith(RECORD);
    expect(mockCallApi).toHaveBeenLastCalledWith(
      `/api/meal-plans/${PAGE_ONE[0].mealPlanId}`
    );
  });

  it('shows the cannot-open message with the list still displayed when the deserializer refuses a record', async () => {
    const user = userEvent.setup();
    mockCallApi
      .mockResolvedValueOnce(ok({ items: PAGE_ONE }))
      .mockResolvedValueOnce(fail('validation'));

    renderList();

    await user.click(await screen.findByRole('button', { name: 'Open Low-residue week' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(CANNOT_OPEN_MESSAGE);
    expect(rowTitles()).toEqual(['Low-residue week', 'Flare-friendly plan']);
    // Retrying the same read cannot succeed, so no retry control is offered.
    expect(screen.queryByRole('button', { name: RETRY_LABEL })).not.toBeInTheDocument();
  });

  it('applies a rename optimistically, restores the exact previous title on failure, then removes a deleted row', async () => {
    const user = userEvent.setup();
    mockCallApi.mockResolvedValueOnce(ok({ items: PAGE_ONE }));

    renderList();

    await user.click(await screen.findByRole('button', { name: 'Rename Low-residue week' }));

    await user.click(screen.getByRole('button', { name: 'apply-rename' }));
    await waitFor(() => expect(rowTitles()).toEqual(['Renamed plan', 'Flare-friendly plan']));

    await user.click(screen.getByRole('button', { name: 'restore-rename' }));
    await waitFor(() => expect(rowTitles()).toEqual(['Low-residue week', 'Flare-friendly plan']));

    await user.click(screen.getByRole('button', { name: 'confirm-rename' }));
    await waitFor(() => expect(rowTitles()).toEqual(['Renamed plan', 'Flare-friendly plan']));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Delete Renamed plan' }));
    await user.click(screen.getByRole('button', { name: 'confirm-delete' }));

    await waitFor(() => expect(rowTitles()).toEqual(['Flare-friendly plan']));
  });
});

describe('SavedPlansList list helpers', () => {
  it('formats a stored UTC timestamp as YYYY-MM-DD without shifting the day', () => {
    expect(formatCreatedDate('2025-03-14T23:59:59.999Z')).toBe('2025-03-14');
    expect(formatCreatedDate('not a date')).toBe('');
  });

  it('appends a page after the existing rows and skips ids already displayed', () => {
    expect(appendPage(PAGE_ONE, PAGE_TWO).map((p) => p.mealPlanId)).toEqual([
      PAGE_ONE[0].mealPlanId,
      PAGE_ONE[1].mealPlanId,
      PAGE_TWO[0].mealPlanId,
    ]);
    expect(appendPage(PAGE_ONE, [PAGE_ONE[1]])).toHaveLength(2);
  });

  it('renames exactly one row and restores the captured title exactly', () => {
    const renamed = applyRenamedTitle(PAGE_ONE, PAGE_ONE[0].mealPlanId, 'New title');
    expect(renamed.map((p) => p.title)).toEqual(['New title', PAGE_ONE[1].title]);
    expect(
      applyRenamedTitle(renamed, PAGE_ONE[0].mealPlanId, PAGE_ONE[0].title)
    ).toEqual([...PAGE_ONE]);
  });

  it('removes one row and preserves the order of the rest', () => {
    const all = [...PAGE_ONE, ...PAGE_TWO];
    expect(removePlanRow(all, PAGE_ONE[1].mealPlanId).map((p) => p.mealPlanId)).toEqual([
      PAGE_ONE[0].mealPlanId,
      PAGE_TWO[0].mealPlanId,
    ]);
  });

  it('refuses a record that could not render as a plan', () => {
    expect(isRenderableRecord(RECORD)).toBe(true);
    expect(isRenderableRecord({ ...RECORD, content: { ...RECORD.content, meals: [] } })).toBe(false);
    expect(isRenderableRecord(null)).toBe(false);
  });
});
