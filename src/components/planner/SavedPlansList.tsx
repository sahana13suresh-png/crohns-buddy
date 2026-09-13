'use client';

/**
 * The saved meal plans view (Requirement 6).
 *
 * This component owns the list state, and the shape of that state is what makes
 * the requirements hold rather than any single handler:
 *
 * - **Rows are only ever replaced on a successful first page** (Requirement 6.6).
 *   Every failure path writes to `listError` / `openError` and leaves `items`
 *   alone, so error state is strictly additive — a failed list, a failed read, a
 *   failed rename, and a timeout all keep whatever was on screen visible and add
 *   a message plus a retry control beside it.
 * - **A page is appended, never merged** (Requirements 6.2, 6.3). The
 *   Meal_Plan_API returns records newest-first with a Meal_Plan_Id tie-break and
 *   the cursor advances strictly, so concatenating pages in arrival order is
 *   exactly the stored order. `appendPage` is a pure function for that reason:
 *   the ordering claim is checkable without a browser.
 * - **The continuation token is the load-more control** (Requirement 6.8). It is
 *   `null` on the final page, and the control renders from that value alone, so
 *   there is no second flag that could disagree with it.
 * - **`planViewEpoch` empties the view** (Requirements 2.8, 2.13, 6.10). A
 *   signout, an elapsed Session, or a credential refusal all raise it, and the
 *   epoch is part of the load effect's dependency list, so the clear and the
 *   refetch are one decision instead of two.
 *
 * Reopening a record renders it through `MealPlanDisplay` — the same component
 * the generated plan uses — so Requirement 6.4's "same layout" is structural
 * rather than a duplicated markup tree kept in sync by hand. Progress and error
 * rendering for the read stay here, because `MealPlanDisplay`'s own loading copy
 * describes generation, and because a read failure must appear *beside* the list
 * rather than in place of it.
 *
 * Requirement 6.7 (the reopened plan becomes the AI chat context) belongs to
 * `MealPlannerPage`; this component reports the record through `onOpenPlan` and
 * holds no chat state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callApi } from '@/lib/apiClient';
import { useSession } from '@/components/auth/SessionProvider';
import MealPlanDisplay from './MealPlanDisplay';
import RenamePlanDialog, { type RenameOutcome } from './RenamePlanDialog';
import DeletePlanDialog from './DeletePlanDialog';
import type { MealPlanRecord, MealPlanSummary } from '@/lib/types';

// ─── Copy ──────────────────────────────────────────────────────────────────────

/** Requirement 6.10 — no records displayed, and this message instead. */
export const SIGNED_OUT_MESSAGE = 'Viewing saved meal plans requires signing in.';

/** Requirement 6.5 — an Account that owns nothing yet, with no list rows. */
export const EMPTY_MESSAGE = 'No saved meal plans yet. Save a plan and it will appear here.';

/**
 * Requirement 6.6 — the store is unreachable or the request passed 10 seconds.
 * One wording for both, because the Patient's next action is the same.
 */
export const UNREACHABLE_MESSAGE =
  'Saved meal plans are temporarily unreachable. Please try again.';

/**
 * Requirement 6.9 — the Meal_Plan_Deserializer refused the stored record. The
 * record is left unchanged and the list stays displayed, so this is guidance
 * rather than an error to retry.
 */
export const CANNOT_OPEN_MESSAGE =
  'This saved meal plan cannot be opened. It is stored in a form this version cannot read, and it has been left unchanged.';

export const LOADING_MESSAGE = 'Loading your saved meal plans...';
export const OPENING_MESSAGE = 'Opening your saved meal plan...';
export const LOAD_MORE_LABEL = 'Load More';
export const RETRY_LABEL = 'Try Again';

const LIST_PATH = '/api/meal-plans';

// ─── Response shapes ───────────────────────────────────────────────────────────

interface ListResponse {
  items?: unknown;
  nextCursor?: unknown;
}

interface ReadResponse {
  record?: unknown;
}

// ─── Pure list helpers ─────────────────────────────────────────────────────────
// Exported because the order-and-content claims (Property 22) are properties of
// these functions, not of the DOM.

/** A list row the view can render without inventing values for absent fields. */
export function isMealPlanSummary(value: unknown): value is MealPlanSummary {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.mealPlanId === 'string' &&
    candidate.mealPlanId.length > 0 &&
    typeof candidate.title === 'string' &&
    typeof candidate.createdAt === 'string'
  );
}

/**
 * A stored record complete enough for `MealPlanDisplay` to render. A payload
 * that fails this check is treated as the Requirement 6.9 cannot-open case
 * rather than rendered half-way and left to throw mid-tree.
 */
export function isRenderableRecord(value: unknown): value is MealPlanRecord {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (typeof record.mealPlanId !== 'string' || record.mealPlanId.length === 0) return false;
  if (typeof record.title !== 'string') return false;
  const content = record.content;
  if (content === null || typeof content !== 'object') return false;
  const { meals, summary } = content as Record<string, unknown>;
  if (typeof summary !== 'string') return false;
  if (!Array.isArray(meals) || meals.length === 0) return false;
  return meals.every((meal) => {
    if (meal === null || typeof meal !== 'object') return false;
    const { mealName, items } = meal as Record<string, unknown>;
    if (typeof mealName !== 'string') return false;
    if (!Array.isArray(items)) return false;
    return items.every(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        typeof (item as Record<string, unknown>).name === 'string' &&
        typeof (item as Record<string, unknown>).portion === 'string'
    );
  });
}

/**
 * The next page below the rows already displayed (Requirement 6.3). Appending
 * preserves both the existing order and the arrival order of the new page, and
 * an id already present is skipped so a re-requested page cannot duplicate a row.
 */
export function appendPage(
  existing: readonly MealPlanSummary[],
  page: readonly MealPlanSummary[]
): MealPlanSummary[] {
  const seen = new Set(existing.map((item) => item.mealPlanId));
  const appended = page.filter((item) => !seen.has(item.mealPlanId));
  return [...existing, ...appended];
}

/**
 * One row's title replaced in place. Used for the optimistic rename *and* for
 * the restore, so a failed rename puts back the exact captured title rather than
 * a re-derived one (Requirement 8.6). Every other row, and the order, is
 * untouched.
 */
export function applyRenamedTitle(
  items: readonly MealPlanSummary[],
  mealPlanId: string,
  title: string
): MealPlanSummary[] {
  return items.map((item) => (item.mealPlanId === mealPlanId ? { ...item, title } : item));
}

/** One row dropped, leaving the remaining order intact (Requirement 8.8). */
export function removePlanRow(
  items: readonly MealPlanSummary[],
  mealPlanId: string
): MealPlanSummary[] {
  return items.filter((item) => item.mealPlanId !== mealPlanId);
}

/**
 * The creation date as `YYYY-MM-DD` (Requirement 6.1). Stored timestamps are
 * ISO-8601 UTC, so the leading date is taken directly — parsing and reformatting
 * would reintroduce the local-timezone shift the stored form already avoids. A
 * value that is not in that form falls back to a UTC parse, and an unparseable
 * one renders nothing rather than `NaN-NaN-NaN`.
 */
export function formatCreatedDate(createdAt: string): string {
  const leadingDate = /^(\d{4}-\d{2}-\d{2})/.exec(createdAt);
  if (leadingDate !== null) return leadingDate[1];
  const ms = Date.parse(createdAt);
  if (Number.isNaN(ms)) return '';
  return new Date(ms).toISOString().slice(0, 10);
}

// ─── Component ─────────────────────────────────────────────────────────────────

export interface SavedPlansListProps {
  /**
   * A stored record was reopened. `MealPlannerPage` uses it to swap the AI chat
   * context and to retain the Meal_Plan_Id (Requirements 5.13, 6.7).
   */
  onOpenPlan?: (record: MealPlanRecord) => void;
}

type Pending = 'none' | 'first-page' | 'next-page' | 'open';

export default function SavedPlansList({ onOpenPlan }: SavedPlansListProps) {
  const { status, planViewEpoch } = useSession();
  const signedIn = status === 'authenticated';

  const [items, setItems] = useState<MealPlanSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState<Pending>('none');

  const [listError, setListError] = useState<string | null>(null);
  /** The cursor the failed request used, so the retry repeats that same page. */
  const [failedCursor, setFailedCursor] = useState<string | null>(null);

  const [openRecord, setOpenRecord] = useState<MealPlanRecord | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  /** Set only for a retryable read failure — a cannot-open record leaves it null. */
  const [retryOpenId, setRetryOpenId] = useState<string | null>(null);

  const [renameTarget, setRenameTarget] = useState<MealPlanSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MealPlanSummary | null>(null);

  /**
   * Titles captured before an optimistic rename, keyed by Meal_Plan_Id. Held in
   * a ref rather than state because it is bookkeeping for a restore, not
   * something rendered.
   */
  const capturedTitles = useRef(new Map<string, string>());

  /**
   * Raised whenever a response must be ignored — a newer request started, or the
   * plan view was emptied under it. Without this, a list response that arrives
   * after a signout would repopulate the view Requirement 2.8 just cleared.
   */
  const generation = useRef(0);

  const clearView = useCallback(() => {
    generation.current += 1;
    capturedTitles.current.clear();
    setItems([]);
    setNextCursor(null);
    setLoaded(false);
    setPending('none');
    setListError(null);
    setFailedCursor(null);
    setOpenRecord(null);
    setOpenError(null);
    setRetryOpenId(null);
    setRenameTarget(null);
    setDeleteTarget(null);
  }, []);

  const loadPage = useCallback(async (cursor: string | null) => {
    generation.current += 1;
    const requestGeneration = generation.current;

    setPending(cursor === null ? 'first-page' : 'next-page');
    setListError(null);
    setFailedCursor(null);

    const path =
      cursor === null ? LIST_PATH : `${LIST_PATH}?cursor=${encodeURIComponent(cursor)}`;
    const result = await callApi<ListResponse>(path);

    if (requestGeneration !== generation.current) return;
    setPending('none');

    if (!result.ok) {
      // Requirement 6.6 — the rows already displayed stay exactly as they are.
      setListError(
        result.kind === 'unavailable' || result.kind === 'timeout'
          ? UNREACHABLE_MESSAGE
          : result.message
      );
      setFailedCursor(cursor);
      return;
    }

    const body = result.data ?? {};
    const page = Array.isArray(body.items) ? body.items.filter(isMealPlanSummary) : [];
    setItems((prev) => (cursor === null ? [...page] : appendPage(prev, page)));
    setNextCursor(
      typeof body.nextCursor === 'string' && body.nextCursor.length > 0 ? body.nextCursor : null
    );
    setLoaded(true);
  }, []);

  const openPlan = useCallback(
    async (mealPlanId: string) => {
      generation.current += 1;
      const requestGeneration = generation.current;

      setPending('open');
      setOpenError(null);
      setRetryOpenId(null);

      const result = await callApi<ReadResponse>(
        `${LIST_PATH}/${encodeURIComponent(mealPlanId)}`
      );

      if (requestGeneration !== generation.current) return;
      setPending('none');

      if (!result.ok) {
        if (result.kind === 'validation') {
          // Requirement 6.9 — the deserializer refused it, so resubmitting the
          // same read is pointless and no retry control is offered.
          setOpenError(CANNOT_OPEN_MESSAGE);
          return;
        }
        setOpenError(
          result.kind === 'unavailable' || result.kind === 'timeout'
            ? UNREACHABLE_MESSAGE
            : result.message
        );
        setRetryOpenId(mealPlanId);
        return;
      }

      const record = result.data?.record;
      if (!isRenderableRecord(record)) {
        setOpenError(CANNOT_OPEN_MESSAGE);
        return;
      }

      setOpenRecord(record);
      onOpenPlan?.(record);
    },
    [onOpenPlan]
  );

  // The first page, refetched whenever the plan view is emptied and a Session is
  // still active. `status` covers the signed-out and expired cases in the same
  // effect, so there is no window where stale rows outlive the Session.
  useEffect(() => {
    if (!signedIn) {
      clearView();
      return;
    }
    clearView();
    void loadPage(null);
    // `clearView` bumps the generation, so the load started here is the newest.
  }, [signedIn, planViewEpoch, clearView, loadPage]);

  // ─── Rename: optimistic apply, exact restore ─────────────────────────────────

  /**
   * The optimistic apply (Requirement 8.6). The displayed title is captured
   * first, so the restore below puts back exactly what was on the row rather
   * than a value re-derived from the dialog's input.
   */
  const applyTitle = useCallback((mealPlanId: string, title: string) => {
    setItems((prev) => {
      const current = prev.find((item) => item.mealPlanId === mealPlanId);
      if (current !== undefined && !capturedTitles.current.has(mealPlanId)) {
        capturedTitles.current.set(mealPlanId, current.title);
      }
      return applyRenamedTitle(prev, mealPlanId, title);
    });
  }, []);

  /**
   * The rename failed. The dialog supplies the pre-rename title it captured; the
   * copy captured here is the fallback, so the row is restored even if the
   * dialog passes nothing. The dialog stays open for another attempt.
   */
  const restoreTitle = useCallback((mealPlanId: string, previousTitle?: string) => {
    const captured = capturedTitles.current.get(mealPlanId);
    capturedTitles.current.delete(mealPlanId);
    const restored = previousTitle ?? captured;
    if (restored === undefined) return;
    setItems((prev) => applyRenamedTitle(prev, mealPlanId, restored));
  }, []);

  /** The rename was stored. The server's own title wins, and the dialog closes. */
  const commitRename = useCallback((outcome: RenameOutcome) => {
    capturedTitles.current.delete(outcome.mealPlanId);
    setItems((prev) => applyRenamedTitle(prev, outcome.mealPlanId, outcome.title));
    setRenameTarget(null);
  }, []);

  const commitDelete = useCallback((mealPlanId: string) => {
    setItems((prev) => removePlanRow(prev, mealPlanId));
    setOpenRecord((prev) => (prev !== null && prev.mealPlanId === mealPlanId ? null : prev));
    setDeleteTarget(null);
  }, []);

  // ─── Render ──────────────────────────────────────────────────────────────────

  const inFlight = pending !== 'none';
  const showEmptyState = useMemo(
    () => signedIn && loaded && items.length === 0 && listError === null && !inFlight,
    [signedIn, loaded, items.length, listError, inFlight]
  );

  if (!signedIn) {
    // Requirement 6.10 — and Requirement 2.13's expiry message is rendered by
    // `AccountMenu`, so it is not repeated here.
    return (
      <section aria-labelledby="saved-plans-heading" className="soft-panel mb-8 space-y-3">
        <h2 id="saved-plans-heading" className="text-lg">
          Saved Meal Plans
        </h2>
        <p role="status" className="text-sm text-brand-800/60">
          {SIGNED_OUT_MESSAGE}
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="saved-plans-heading" className="surface-card mb-8 space-y-4">
      <h2 id="saved-plans-heading" className="text-lg">
        Saved Meal Plans
      </h2>

      {/* The reopened plan, rendered by the same component a generated plan uses
          (Requirement 6.4), with the list still below it (Requirement 6.9). */}
      {openRecord !== null && (
        <div className="space-y-3 rounded-2xl border border-brand-800/10 bg-brand-50/40 p-4">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-base">{openRecord.title}</h3>
            <button
              type="button"
              onClick={() => setOpenRecord(null)}
              className="text-xs text-brand-800/60 hover:text-brand-800 transition-colors duration-200"
            >
              Close
            </button>
          </div>
          <MealPlanDisplay
            mealPlan={openRecord.content}
            isLoading={false}
            error={null}
            onRetry={() => openPlan(openRecord.mealPlanId)}
          />
        </div>
      )}

      {openError !== null && (
        <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">
          <p className="text-amber-800">{openError}</p>
          {retryOpenId !== null && (
            <button
              type="button"
              onClick={() => void openPlan(retryOpenId)}
              className="mt-3 rounded-full border border-amber-300 px-3 py-1.5 text-xs font-semibold text-amber-800 transition-colors duration-200 hover:bg-amber-100"
            >
              {RETRY_LABEL}
            </button>
          )}
        </div>
      )}

      {items.length > 0 && (
        <ul
          aria-label="Saved meal plans"
          className="divide-y divide-brand-800/10 overflow-hidden rounded-xl border border-brand-800/10 bg-white"
        >
          {items.map((plan) => (
            <li
              key={plan.mealPlanId}
              className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="truncate text-sm text-brand-800">{plan.title}</p>
                <time
                  dateTime={formatCreatedDate(plan.createdAt)}
                  className="text-xs text-brand-800/50"
                >
                  {formatCreatedDate(plan.createdAt)}
                </time>
              </div>
              <div className="flex flex-wrap items-center gap-2 flex-shrink-0">
                <button
                  type="button"
                  onClick={() => void openPlan(plan.mealPlanId)}
                  aria-label={`Open ${plan.title}`}
                  className="rounded-full border border-brand-800/15 px-3 py-1.5 text-xs font-semibold transition-colors duration-200 hover:border-brand-300 hover:bg-brand-50"
                >
                  Open
                </button>
                <button
                  type="button"
                  onClick={() => setRenameTarget(plan)}
                  aria-label={`Rename ${plan.title}`}
                  className="rounded-full border border-brand-800/15 px-3 py-1.5 text-xs font-semibold transition-colors duration-200 hover:border-brand-300 hover:bg-brand-50"
                >
                  Rename
                </button>
                <button
                  type="button"
                  onClick={() => setDeleteTarget(plan)}
                  aria-label={`Delete ${plan.title}`}
                  className="rounded-full border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-700 transition-colors duration-200 hover:bg-red-50"
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Requirement 6.1 — a progress indicator while any request is in flight,
          shown beside the rows rather than in place of them. */}
      {inFlight && (
        <p role="status" aria-live="polite" className="flex items-center gap-2 text-sm text-brand-800/60">
          <span
            className="w-4 h-4 border-2 border-brand-200 border-t-brand-600 rounded-full animate-spin"
            aria-hidden="true"
          />
          {pending === 'open' ? OPENING_MESSAGE : LOADING_MESSAGE}
        </p>
      )}

      {showEmptyState && (
        <p role="status" className="text-sm text-brand-800/60">
          {EMPTY_MESSAGE}
        </p>
      )}

      {listError !== null && (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm">
          <p className="text-red-800">{listError}</p>
          <button
            type="button"
            onClick={() => void loadPage(failedCursor)}
            className="mt-3 rounded-full border border-red-300 px-3 py-1.5 text-xs font-semibold text-red-800 transition-colors duration-200 hover:bg-red-100"
          >
            {RETRY_LABEL}
          </button>
        </div>
      )}

      {/* Requirement 6.8 — the control exists exactly while a continuation token
          does. It is disabled, not removed, while its own page is in flight. */}
      {nextCursor !== null && listError === null && (
        <button
          type="button"
          onClick={() => void loadPage(nextCursor)}
          disabled={inFlight}
          className="btn-secondary px-4 py-2 disabled:opacity-40"
        >
          {LOAD_MORE_LABEL}
        </button>
      )}

      {renameTarget !== null && (
        <RenamePlanDialog
          plan={renameTarget}
          onApplyTitle={applyTitle}
          onRenamed={commitRename}
          onRestoreTitle={restoreTitle}
          onCancel={() => {
            // Nothing was sent, so there is normally nothing to put back; the
            // restore runs anyway in case an apply is still outstanding.
            restoreTitle(renameTarget.mealPlanId);
            setRenameTarget(null);
          }}
        />
      )}

      {deleteTarget !== null && (
        <DeletePlanDialog
          plan={deleteTarget}
          onDeleted={(mealPlanId: string) => commitDelete(mealPlanId)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </section>
  );
}
