/**
 * Property-based test for the saved meal plans view.
 *
 * Feature: user-auth-and-cloud-storage, Property 22.
 *
 * **Validates: Requirements 6.1, 6.4, 6.6, 6.7**
 *
 * The property has four claims, and they are asserted at the level each one
 * actually lives at:
 *
 * - The *ordering* claims are claims about `appendPage`, `applyRenamedTitle`, and
 *   `removePlanRow`, so they are asserted on those functions directly. A DOM
 *   assertion could only ever check one arrival sequence per run.
 * - The *rendering* claims — a row per record carrying the stored title and a
 *   `YYYY-MM-DD` creation date, a reopened plan showing meals, items, portions,
 *   summary, and warnings in stored order, and a failed request leaving the rows
 *   in place beside a retry control — are claims about what reaches the screen,
 *   so they are asserted against the mounted component in jsdom.
 *
 * Records come from `arbMealPlanRecord()`, so every string field is drawn from
 * `arbTrickyString` — emoji built from surrogate pairs, combining marks, RTL text
 * with bidi overrides, `\r\n`, quotes, backslashes. Rendered values are therefore
 * compared against `textContent` rather than through `getByText`, whose whitespace
 * normalization would hide exactly the mangling this property is looking for.
 *
 * The Session and `callApi` are supplied directly, because they are the
 * component's two inputs. Everything the property asserts on — the rows, the
 * dates, the reopened plan tree, the error and retry controls, the chat context
 * callback — is the real component.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SavedPlansList, {
  appendPage,
  applyRenamedTitle,
  formatCreatedDate,
  isMealPlanSummary,
  isRenderableRecord,
  LOAD_MORE_LABEL,
  LOADING_MESSAGE,
  removePlanRow,
  RETRY_LABEL,
  UNREACHABLE_MESSAGE,
} from './SavedPlansList';
import type { SessionContextValue } from '@/components/auth/SessionProvider';
import type { ApiResult } from '@/lib/apiClient';
import type { MealPlanRecord, MealPlanSummary } from '@/lib/types';
import { arbMealPlanRecord, arbTrickyString } from '@/test/arbitraries';

const { mockUseSession, mockCallApi } = vi.hoisted(() => ({
  mockUseSession: vi.fn(),
  mockCallApi: vi.fn(),
}));

vi.mock('@/components/auth/SessionProvider', () => ({ useSession: mockUseSession }));
vi.mock('@/lib/apiClient', () => ({ callApi: mockCallApi }));

// ─── Fixtures and helpers ──────────────────────────────────────────────────────

const LIST_PATH = '/api/meal-plans';

const AUTHENTICATED: SessionContextValue = {
  session: {
    userId: 'uid-1',
    displayName: 'Ada',
    email: 'ada@example.com',
    emailVerified: true,
    authTimeMs: 1_700_000_000_000,
    sessionStartedAtMs: 1_700_000_000_000,
  },
  status: 'authenticated',
  expiredMessage: null,
  planViewEpoch: 0,
  signOut: vi.fn(),
  dismissExpiredMessage: vi.fn(),
  redirectOutcome: null,
  clearRedirectOutcome: vi.fn(),
};

function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

function fail<T>(kind: 'unavailable' | 'timeout' | 'validation'): ApiResult<T> {
  return { ok: false, kind, message: 'server wording' };
}

/** The list projection of a stored record — what the Meal_Plan_API returns. */
function summaryOf(record: MealPlanRecord): MealPlanSummary {
  return {
    mealPlanId: record.mealPlanId,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * The expected `YYYY-MM-DD` creation date, derived through `Date` rather than by
 * slicing the stored string, so the expectation is not a copy of
 * `formatCreatedDate`.
 */
function expectedDate(createdAt: string): string {
  return new Date(createdAt).toISOString().slice(0, 10);
}

/**
 * `callApi` backed by the given records: the first page lists them all, and a read
 * resolves the record whose Meal_Plan_Id the path names.
 */
function serveRecords(records: readonly MealPlanRecord[]): void {
  mockCallApi.mockImplementation(async (path: string) => {
    if (path === LIST_PATH) return ok({ items: records.map(summaryOf) });
    const id = decodeURIComponent(path.slice(`${LIST_PATH}/`.length));
    const record = records.find((candidate) => candidate.mealPlanId === id);
    return record === undefined ? fail('validation') : ok({ record });
  });
}

/** The rendered list rows, in DOM order. */
function rows(): HTMLElement[] {
  const list = screen.queryByRole('list', { name: 'Saved meal plans' });
  return list === null ? [] : within(list).getAllByRole('listitem');
}

/** Each row's rendered title, in DOM order, unnormalized. */
function renderedTitles(): (string | null)[] {
  return rows().map((row) => row.querySelector('p')?.textContent ?? null);
}

/**
 * The `MealPlanDisplay` subtree of the reopened plan panel.
 *
 * Walked structurally rather than by class name: the panel holds a header row and
 * the display, and the display holds the summary block, an optional warnings
 * block, and the meals block. The caller cross-checks the summary heading text,
 * so a change to that shape fails loudly instead of silently matching nothing.
 */
function reopenedDisplay(): Element {
  const close = screen.getByText('Close');
  const panel = close.parentElement?.parentElement;
  if (panel === null || panel === undefined) throw new Error('no reopened plan panel');
  const display = panel.lastElementChild;
  if (display === null) throw new Error('reopened plan panel has no plan display');
  return display;
}

function renderList(onOpenPlan?: (record: MealPlanRecord) => void) {
  mockUseSession.mockReturnValue(AUTHENTICATED);
  return render(<SavedPlansList onOpenPlan={onOpenPlan} />);
}

/** Unmounts the tree and drops mock state, so each property run starts clean. */
function resetRun(): void {
  cleanup();
  mockCallApi.mockReset();
  mockUseSession.mockReset();
}

// ─── Generators ────────────────────────────────────────────────────────────────

/**
 * A distinct set of stored records. Kept small because each run mounts the whole
 * tree: a record may already hold 10 meals of 20 items, so a handful of records
 * is thousands of rendered nodes.
 */
function arbRecordSet(minLength: number, maxLength: number) {
  return fc.uniqueArray(arbMealPlanRecord(), {
    minLength,
    maxLength,
    selector: (record) => record.mealPlanId,
  });
}

/** Requirement 6.6's antecedent: the store is unreachable, or 10 seconds passed. */
const arbUnreachableKind = fc.constantFrom<('unavailable' | 'timeout')[]>('unavailable', 'timeout');

/** A list row, generated without a full record so the pure helpers run cheaply. */
const arbRow: fc.Arbitrary<MealPlanSummary> = fc
  .record({
    idSuffix: fc.integer({ min: 0, max: 60_466_175 }),
    title: arbTrickyString(1, 40),
    createdAtMs: fc.integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2035, 0, 1) }),
  })
  .map(({ idSuffix, title, createdAtMs }) => {
    const createdAt = new Date(createdAtMs).toISOString();
    return {
      mealPlanId: `01HZ${idSuffix.toString(36).toUpperCase().padStart(6, '0')}`,
      title,
      createdAt,
      updatedAt: createdAt,
    };
  });

const arbRowSet = (minLength: number, maxLength: number) =>
  fc.uniqueArray(arbRow, { minLength, maxLength, selector: (row) => row.mealPlanId });

// ─── Properties ────────────────────────────────────────────────────────────────

describe('SavedPlansList rendering', () => {
  beforeEach(() => {
    resetRun();
  });

  // Feature: user-auth-and-cloud-storage, Property 22: Rendered plans and lists
  // preserve stored order and content — the list claim (Requirement 6.1).
  it('renders one row per record carrying that record’s stored title and YYYY-MM-DD creation date', async () => {
    await fc.assert(
      fc.asyncProperty(arbRecordSet(1, 3), async (records) => {
        try {
          let resolveFirstPage: ((result: ApiResult<unknown>) => void) | undefined;
          serveRecords(records);
          mockCallApi.mockImplementationOnce(
            () =>
              new Promise<ApiResult<unknown>>((resolve) => {
                resolveFirstPage = resolve;
              }),
          );

          renderList();

          // A progress indicator while the first page is in flight.
          expect(screen.getByRole('status')).toHaveTextContent(LOADING_MESSAGE);
          expect(rows()).toHaveLength(0);

          resolveFirstPage?.(ok({ items: records.map(summaryOf) }));

          await waitFor(() => expect(rows()).toHaveLength(records.length));

          // One row per record, in the order the page arrived in, each showing the
          // stored title exactly and the creation date as YYYY-MM-DD.
          expect(renderedTitles()).toEqual(records.map((record) => record.title));
          rows().forEach((row, index) => {
            const time = row.querySelector('time');
            const expected = expectedDate(records[index].createdAt);
            expect(expected).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(time?.textContent).toBe(expected);
            expect(time?.getAttribute('datetime')).toBe(expected);
          });
          expect(mockCallApi).toHaveBeenCalledWith(LIST_PATH);
        } finally {
          resetRun();
        }
      }),
      { numRuns: 25 },
    );
  });

  // Feature: user-auth-and-cloud-storage, Property 22 — the reopened plan claim
  // (Requirement 6.4).
  it('renders a reopened plan’s meals, items, portions, summary, and warnings in the stored order', async () => {
    await fc.assert(
      fc.asyncProperty(arbMealPlanRecord(), async (record) => {
        try {
          serveRecords([record]);
          renderList();

          const row = (await waitFor(() => {
            const found = rows();
            expect(found).toHaveLength(1);
            return found;
          }))[0];

          fireEvent.click(within(row).getByText('Open'));

          await waitFor(() => expect(screen.getByText('Close')).toBeInTheDocument());

          const { meals, summary, warnings } = record.content;
          const display = reopenedDisplay();

          // Summary — the same block a freshly generated plan renders.
          const summaryBlock = display.firstElementChild;
          expect(summaryBlock?.querySelector('h3')?.textContent).toBe('Plan Summary');
          expect(summaryBlock?.querySelector('p')?.textContent).toBe(summary);

          // Warnings, in stored order. The block exists exactly when the stored
          // record carries a non-empty warning list.
          const storedWarnings = warnings ?? [];
          expect(display.children).toHaveLength(storedWarnings.length > 0 ? 3 : 2);
          if (storedWarnings.length > 0) {
            const rendered = Array.from(display.children[1].querySelectorAll('li')).map(
              (item) => item.textContent,
            );
            expect(rendered).toEqual(storedWarnings.map((warning) => `• ${warning}`));
          }

          // Meals, and each meal's items and portions, in stored order.
          const mealCards = Array.from(display.children[display.children.length - 1].children);
          expect(mealCards).toHaveLength(meals.length);
          mealCards.forEach((card, mealIndex) => {
            const meal = meals[mealIndex];
            expect(card.querySelector('h3')?.textContent).toBe(meal.mealName);

            const items = Array.from(card.querySelectorAll('li'));
            expect(items).toHaveLength(meal.items.length);
            items.forEach((rendered, itemIndex) => {
              const item = meal.items[itemIndex];
              const values = rendered.querySelectorAll('span');
              expect(values[0]?.textContent).toBe(item.name);
              expect(values[1]?.textContent).toBe(item.portion);
              // An absent note renders nothing rather than an empty line.
              const notes = rendered.querySelector('p');
              if (item.notes === undefined || item.notes === '') {
                expect(notes).toBeNull();
              } else {
                expect(notes?.textContent).toBe(item.notes);
              }
            });
          });

          // Requirement 6.9's neighbour claim: the list is still displayed.
          expect(renderedTitles()).toEqual([record.title]);
        } finally {
          resetRun();
        }
      }),
      { numRuns: 20 },
    );
  });

  // Feature: user-auth-and-cloud-storage, Property 22 — the additive-error claim
  // (Requirement 6.6).
  it('leaves the previously rendered rows in place beside a retry control when a page or a read fails', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbRecordSet(1, 3),
        arbUnreachableKind,
        fc.constantFrom<('next-page' | 'read')[]>('next-page', 'read'),
        fc.nat(),
        async (records, kind, failing, rowPick) => {
          try {
            const page = records.map(summaryOf);
            // The first page succeeds and reports a continuation token, so both a
            // further page and a read are reachable from the same rendered list.
            mockCallApi
              .mockResolvedValueOnce(ok({ items: page, nextCursor: 'cursor-1' }))
              .mockResolvedValue(fail(kind));

            renderList();

            await waitFor(() => expect(rows()).toHaveLength(records.length));
            const before = renderedTitles();

            if (failing === 'next-page') {
              fireEvent.click(screen.getByRole('button', { name: LOAD_MORE_LABEL }));
            } else {
              const index = rowPick % records.length;
              fireEvent.click(within(rows()[index]).getByText('Open'));
            }

            const alert = await screen.findByRole('alert');
            expect(alert).toHaveTextContent(UNREACHABLE_MESSAGE);

            // The rows already displayed are untouched — same rows, same order.
            expect(renderedTitles()).toEqual(before);
            // And a control that retries the failed request sits beside them.
            expect(within(alert).getByRole('button', { name: RETRY_LABEL })).toBeInTheDocument();
          } finally {
            resetRun();
          }
        },
      ),
      { numRuns: 25 },
    );
  });

  // Feature: user-auth-and-cloud-storage, Property 22 — the chat context claim
  // (Requirement 6.7).
  it('supplies a reopened plan as the chat context and stops supplying the previously reopened one', async () => {
    await fc.assert(
      fc.asyncProperty(arbRecordSet(2, 2), async ([first, second]) => {
        // The claim is only meaningful when the two plans differ in content.
        fc.pre(JSON.stringify(first.content) !== JSON.stringify(second.content));
        try {
          const onOpenPlan = vi.fn();
          serveRecords([first, second]);
          renderList(onOpenPlan);

          await waitFor(() => expect(rows()).toHaveLength(2));

          fireEvent.click(within(rows()[0]).getByText('Open'));
          await waitFor(() => expect(onOpenPlan).toHaveBeenCalledTimes(1));
          expect(onOpenPlan.mock.calls[0][0]).toEqual(first);

          fireEvent.click(within(rows()[1]).getByText('Open'));
          await waitFor(() => expect(onOpenPlan).toHaveBeenCalledTimes(2));

          // The context in force is the second plan's content, and the first is no
          // longer supplied — one reopened plan is displayed, not two.
          const supplied = onOpenPlan.mock.calls[1][0] as MealPlanRecord;
          expect(supplied).toEqual(second);
          expect(supplied.content).not.toEqual(first.content);
          expect(screen.getAllByText('Close')).toHaveLength(1);
          expect(reopenedDisplay().firstElementChild?.querySelector('p')?.textContent).toBe(
            second.content.summary,
          );
        } finally {
          resetRun();
        }
      }),
      { numRuns: 15 },
    );
  });
});

describe('SavedPlansList list helpers', () => {
  // Feature: user-auth-and-cloud-storage, Property 22 — the ordering claims,
  // asserted on the functions that make them true (Requirements 6.1, 6.3, 6.6).
  it('preserves stored order and content across appending, renaming, and removing rows', () => {
    fc.assert(
      fc.property(
        arbRowSet(0, 12),
        arbRowSet(0, 12),
        fc.nat(),
        arbTrickyString(1, 60),
        (existing, incoming, pick, newTitle) => {
          // Appending: the rows already displayed keep their order and content, and
          // the new page follows in arrival order, minus any id already displayed.
          const appended = appendPage(existing, incoming);
          const displayedIds = new Set(existing.map((row) => row.mealPlanId));
          const fresh = incoming.filter((row) => !displayedIds.has(row.mealPlanId));
          expect(appended).toEqual([...existing, ...fresh]);
          expect(appended.slice(0, existing.length)).toEqual([...existing]);
          // Re-requesting a page cannot duplicate a row.
          expect(new Set(appended.map((row) => row.mealPlanId)).size).toBe(appended.length);
          expect(appendPage(appended, incoming)).toEqual(appended);

          if (appended.length === 0) return;

          const target = appended[pick % appended.length];

          // Renaming: one row's title replaced, every other row and the order
          // untouched, and restoring the captured title is an exact inverse.
          const renamed = applyRenamedTitle(appended, target.mealPlanId, newTitle);
          expect(renamed.map((row) => row.mealPlanId)).toEqual(
            appended.map((row) => row.mealPlanId),
          );
          renamed.forEach((row, index) => {
            const before = appended[index];
            expect(row.title).toBe(row.mealPlanId === target.mealPlanId ? newTitle : before.title);
            expect(row.createdAt).toBe(before.createdAt);
          });
          expect(applyRenamedTitle(renamed, target.mealPlanId, target.title)).toEqual(appended);

          // Removing: the row is gone and the remaining order is intact.
          const removed = removePlanRow(appended, target.mealPlanId);
          expect(removed).toEqual(appended.filter((row) => row.mealPlanId !== target.mealPlanId));
          expect(removed).toHaveLength(appended.length - 1);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('formats every stored creation timestamp as its UTC YYYY-MM-DD date', () => {
    fc.assert(
      fc.property(arbRow, (row) => {
        const formatted = formatCreatedDate(row.createdAt);
        expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(formatted).toBe(expectedDate(row.createdAt));
      }),
      { numRuns: 300 },
    );
  });

  it('accepts every valid stored record as a renderable plan and a displayable row', () => {
    // Without this, the rendering claims above could hold vacuously: the component
    // drops rows failing `isMealPlanSummary` and refuses records failing
    // `isRenderableRecord`, so neither may reject a record the store considers valid.
    fc.assert(
      fc.property(arbMealPlanRecord(), (record) => {
        expect(isRenderableRecord(record)).toBe(true);
        expect(isMealPlanSummary(summaryOf(record))).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
