'use client';

/**
 * The rename prompt for one saved Meal_Plan_Record.
 *
 * Two requirements shape this component, and both are about ordering rather than
 * about the request itself:
 *
 * - **Requirement 8.6** — a title that is empty or over 100 characters after
 *   trimming is rejected *before* anything is sent. `validateRenameTitle` is the
 *   single gate, and nothing below it runs until it says `ok`, so a rejected
 *   rename reaches neither the Meal_Plan_API nor the displayed list: the stored
 *   title stays on the row untouched because `onApplyTitle` is never called.
 * - **Requirement 8.8** — a failed rename restores the previously stored title.
 *   The pre-rename title is captured into a local *before* the optimistic apply,
 *   so the value handed back to `onRestoreTitle` cannot be the optimistic one
 *   even if the list re-renders this dialog with an updated `plan` prop in
 *   between.
 *
 * The list state lives in `SavedPlansList`, not here, so the optimistic apply and
 * the restore are callbacks: this component decides *when* each happens and with
 * *what* title, and the owner of the rows decides how to render it.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { callApi } from '@/lib/apiClient';
import { MAX_TITLE_CODE_POINTS, MIN_TITLE_CODE_POINTS, validateRenameTitle } from '@/lib/mealPlanTitle';
import type { MealPlanSummary } from '@/lib/types';

// ─── Messages ──────────────────────────────────────────────────────────────────

/** Requirement 8.6 — the one message for an empty or over-long title. */
export const TITLE_BOUNDS_MESSAGE = `The title must be ${MIN_TITLE_CODE_POINTS} to ${MAX_TITLE_CODE_POINTS} characters.`;

/** Requirement 8.8 — the store was unreachable or gave no answer in 10 seconds. */
export const RENAME_FAILED_MESSAGE = 'Renaming that meal plan did not succeed. Please try again.';

// ─── Types ─────────────────────────────────────────────────────────────────────

/** Only the two fields a rename needs; a full `MealPlanSummary` satisfies it. */
export type RenamablePlan = Pick<MealPlanSummary, 'mealPlanId' | 'title'>;

/** The `PATCH /api/meal-plans/{mealPlanId}` success body. */
interface RenameResponse {
  title: string;
  updatedAt: string;
}

/** What a confirmed rename reports back to the owner of the row list. */
export interface RenameOutcome {
  mealPlanId: string;
  /** The stored title — the server's own value when it sent one. */
  title: string;
  /** The title displayed before the rename began, captured pre-apply. */
  previousTitle: string;
  updatedAt?: string;
}

export interface RenamePlanDialogProps {
  plan: RenamablePlan;
  /**
   * Applies the trimmed title to the displayed row immediately, before the
   * response arrives. Called exactly once per submitted rename, and never for a
   * rename rejected by client-side validation.
   */
  onApplyTitle?: (mealPlanId: string, title: string) => void;
  /** The rename was stored. The dialog stays mounted; the owner closes it. */
  onRenamed: (outcome: RenameOutcome) => void;
  /**
   * Requirement 8.8 — puts the captured pre-rename title back on the row. The
   * dialog remains open with its own message, so another attempt is available.
   */
  onRestoreTitle?: (mealPlanId: string, previousTitle: string) => void;
  /** The Patient dismissed the prompt. Nothing has been sent. */
  onCancel: () => void;
}

// ─── Component ─────────────────────────────────────────────────────────────────

const INPUT_CLASS =
  'field-control';

export default function RenamePlanDialog({
  plan,
  onApplyTitle,
  onRenamed,
  onRestoreTitle,
  onCancel,
}: RenamePlanDialogProps) {
  const [value, setValue] = useState(plan.title);
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const headingId = useId();
  const inputId = useId();
  const errorId = useId();

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (submitting) return;

      const validation = validateRenameTitle(value);
      if (!validation.ok) {
        // Requirement 8.6 — no request, and no optimistic apply either, so the
        // stored title is still the one on the row. The entered value is left in
        // the field: the Patient is being asked to correct what is in front of
        // them.
        setMessage(TITLE_BOUNDS_MESSAGE);
        return;
      }

      // Captured before the apply so a failure can restore it byte for byte,
      // whatever the row is showing by the time the failure arrives.
      const previousTitle = plan.title;

      setMessage(null);
      setSubmitting(true);
      onApplyTitle?.(plan.mealPlanId, validation.title);

      const result = await callApi<RenameResponse>(
        `/api/meal-plans/${encodeURIComponent(plan.mealPlanId)}`,
        { method: 'PATCH', body: JSON.stringify({ title: validation.title }) }
      );

      if (!mounted.current) return;
      setSubmitting(false);

      if (result.ok) {
        const stored = result.data as RenameResponse | undefined;
        onRenamed({
          mealPlanId: plan.mealPlanId,
          title: stored?.title ?? validation.title,
          previousTitle,
          updatedAt: stored?.updatedAt,
        });
        return;
      }

      onRestoreTitle?.(plan.mealPlanId, previousTitle);
      // A 404 means the record is not this Account's (Requirement 8.7) and a 401
      // means the Session is gone; both carry wording of their own that is more
      // useful than "did not succeed".
      setMessage(
        result.kind === 'not-found' || result.kind === 'unauthorized'
          ? result.message
          : RENAME_FAILED_MESSAGE
      );
    },
    [plan.mealPlanId, plan.title, value, submitting, onApplyTitle, onRenamed, onRestoreTitle]
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-brand-800/50 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className="w-full max-w-sm rounded-2xl border border-white/70 bg-white p-7 shadow-2xl sm:p-9"
      >
        <p className="text-xs uppercase tracking-widest text-brand-400 mb-2">Saved meal plan</p>
        <h2 id={headingId} className="text-xl mb-8">
          Rename meal plan
        </h2>

        <form onSubmit={submit} noValidate className="space-y-5">
          <div>
            <label
              htmlFor={inputId}
              className="mb-2 block text-xs font-semibold uppercase tracking-[0.16em] text-brand-800/50"
            >
              Title <span aria-hidden="true">*</span>
            </label>
            <input
              id={inputId}
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              required
              aria-required="true"
              aria-invalid={message !== null}
              aria-describedby={message === null ? undefined : errorId}
              autoFocus
              className={INPUT_CLASS}
            />
            {message !== null && (
              <p id={errorId} role="alert" className="mt-2 text-sm text-red-700/80">
                {message}
              </p>
            )}
          </div>

          <div className="flex gap-3">
            <button type="submit" disabled={submitting} className="btn-primary flex-1">
              {submitting ? 'Saving...' : 'Save title'}
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="btn-secondary flex-1"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
