'use client';

/**
 * The delete confirmation for one saved Meal_Plan_Record.
 *
 * Requirement 8.2 specifies the shape of this prompt exactly: it names the record
 * by its stored title, offers **one** confirm control and **one** cancel control,
 * and sends nothing until the confirm control is activated. So there is no close
 * affordance in the corner — a second way to dismiss would be a second cancel
 * control — and no request anywhere outside the confirm handler.
 *
 * The row itself belongs to `SavedPlansList`, so removal is a callback:
 *
 * - **Requirement 8.1** — `onDeleted` fires as soon as the successful response is
 *   in hand, in the same turn, well inside the 1 second the criterion allows. It
 *   carries only the Meal_Plan_Id, so the owner removes that one row and leaves
 *   the remaining records in their existing order.
 * - **Requirement 8.5** — a failure calls nothing. The row is still in the list
 *   because nothing asked for its removal, and the confirm control re-enables so
 *   another attempt is available.
 *
 * A delete of a record the store no longer holds answers `204` (Requirement 8.3),
 * which arrives here as a success — the row disappears, which is what the Patient
 * asked for either way.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { callApi } from '@/lib/apiClient';
import type { MealPlanSummary } from '@/lib/types';

// ─── Messages ──────────────────────────────────────────────────────────────────

/** Requirement 8.5 — the store was unreachable or gave no answer in 10 seconds. */
export const DELETE_FAILED_MESSAGE = 'Deleting that meal plan did not succeed. Please try again.';

/** Requirement 8.2 — the prompt identifies the record by its stored title. */
export function deleteConfirmationPrompt(title: string): string {
  return `Delete "${title}"? This removes it from your saved meal plans and cannot be undone.`;
}

// ─── Types ─────────────────────────────────────────────────────────────────────

/** Only the two fields a delete needs; a full `MealPlanSummary` satisfies it. */
export type DeletablePlan = Pick<MealPlanSummary, 'mealPlanId' | 'title'>;

export interface DeletePlanDialogProps {
  plan: DeletablePlan;
  /**
   * Requirement 8.1 — the record is gone from the store. The owner drops this one
   * row and leaves the rest in place. Called once, immediately on success.
   */
  onDeleted: (mealPlanId: string) => void;
  /** The Patient dismissed the prompt. Nothing has been sent. */
  onCancel: () => void;
}

// ─── Component ─────────────────────────────────────────────────────────────────

export default function DeletePlanDialog({ plan, onDeleted, onCancel }: DeletePlanDialogProps) {
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const headingId = useId();
  const promptId = useId();

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const confirm = useCallback(async () => {
    if (submitting) return;

    setMessage(null);
    setSubmitting(true);

    const result = await callApi<void>(`/api/meal-plans/${encodeURIComponent(plan.mealPlanId)}`, {
      method: 'DELETE',
    });

    if (!mounted.current) return;
    setSubmitting(false);

    if (result.ok) {
      onDeleted(plan.mealPlanId);
      return;
    }

    // Requirement 8.5 — nothing is removed and the control stays available. A 404
    // is the not-this-Account case (Requirement 8.7), which has its own wording.
    setMessage(
      result.kind === 'not-found' || result.kind === 'unauthorized'
        ? result.message
        : DELETE_FAILED_MESSAGE
    );
  }, [plan.mealPlanId, submitting, onDeleted]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-brand-800/40">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={promptId}
        className="bg-brand-50 w-full max-w-sm mx-4 p-10 border border-brand-800/10 rounded-sm"
      >
        <p className="text-xs uppercase tracking-widest text-brand-400 mb-2">Saved meal plan</p>
        <h2 id={headingId} className="text-xl mb-4">
          Delete meal plan
        </h2>

        <p id={promptId} className="text-sm text-brand-800/70 mb-8">
          {deleteConfirmationPrompt(plan.title)}
        </p>

        {message !== null && (
          <p role="alert" className="text-sm text-red-700/80 mb-5">
            {message}
          </p>
        )}

        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={submitting}
            className="btn-primary flex-1"
          >
            {submitting ? 'Deleting...' : 'Delete plan'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 px-4 py-3 text-sm text-brand-800/60 border border-brand-800/15 rounded-sm hover:text-brand-800 transition-colors duration-200"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
