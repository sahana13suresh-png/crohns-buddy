'use client';

/**
 * The save control inside the displayed Meal_Plan view (Requirements 5.1,
 * 5.10–5.13).
 *
 * The component owns one thing: the exchange with the Meal_Plan_API for the plan
 * currently on screen. It deliberately does *not* own the Meal_Plan_Id — that
 * lives in `MealPlannerPage` beside the displayed plan, because Requirement 5.13
 * ties the id to the plan rather than to this control, and the control unmounts
 * and remounts as the view changes while the plan does not.
 *
 * Four behaviors are requirement-driven rather than stylistic:
 *
 * - **A Session gates the control, not the plan** (5.1, 5.12). Signed out, the
 *   generated plan still renders; only the control is replaced by the
 *   account-required message. Nothing about generation depends on an Account.
 * - **Failure is additive** (5.11). A failed save leaves the plan exactly as it
 *   was and adds a message plus a control that resubmits *the same* request —
 *   same method, same target, same acknowledgment flag — so a retry after a
 *   `428` does not silently drop the acknowledgment.
 * - **`POST` once, `PUT` after** (5.13). With no id the save creates; with an id
 *   it replaces that record. A second activation therefore updates rather than
 *   accumulating near-duplicate records.
 * - **The storage notice is a server decision** (12.3). The `ack-required`
 *   failure kind is what opens `StorageNoticeDialog`; acknowledging resubmits the
 *   identical save with `acknowledgeStorage: true`, and declining writes nothing.
 *
 * Note the asymmetry in the two request bodies: `POST /api/meal-plans` reads the
 * plan from `mealPlan`, while `PUT /api/meal-plans/{id}` reads it from `content`.
 * That is the shape the two route handlers already implement, so it is matched
 * here rather than papered over.
 */

import { useCallback, useState } from 'react';
import { callApi } from '@/lib/apiClient';
import { useSession } from '@/components/auth/SessionProvider';
import StorageNoticeDialog, { STORAGE_NOTICE_DECLINED_MESSAGE } from './StorageNoticeDialog';
import type { MealPlanContent } from '@/lib/types';

// ─── Copy ──────────────────────────────────────────────────────────────────────

/** Requirement 5.12 — shown in place of the control while no Session is active. */
export const ACCOUNT_REQUIRED_MESSAGE =
  'Saving a meal plan requires an account. Log in or sign up to keep this plan.';

export const SAVE_LABEL = 'Save to My Account';
export const UPDATE_LABEL = 'Update Saved Plan';
export const SAVING_LABEL = 'Saving...';
export const RETRY_LABEL = 'Try Again';

/** Requirement 5.10 — the confirmation for a newly created Meal_Plan_Record. */
export const SAVED_MESSAGE = 'Saved to your account.';

/** Requirement 5.10 for the update path, where nothing new was created. */
export const UPDATED_MESSAGE = 'Your saved meal plan is up to date.';

// ─── Types ─────────────────────────────────────────────────────────────────────

/** The fields this control reads from a `201` or a `200`; both carry the id. */
interface SaveResponse {
  mealPlanId?: string;
}

export interface SavePlanControlProps {
  /** The plan currently displayed. Never null — the caller renders on a plan. */
  mealPlan: MealPlanContent;
  /**
   * The Meal_Plan_Id this plan is already stored under, or null when it has
   * never been saved. Drives `PUT` versus `POST` (Requirement 5.13).
   */
  savedMealPlanId: string | null;
  /** Reports the id the API assigned or confirmed, for the caller to retain. */
  onSaved: (mealPlanId: string) => void;
  /** An optional title; absent lets the API build the date-based default (5.5). */
  title?: string;
}

type Phase = 'idle' | 'saving' | 'saved' | 'failed' | 'declined';

// ─── Component ─────────────────────────────────────────────────────────────────

export default function SavePlanControl({
  mealPlan,
  savedMealPlanId,
  onSaved,
  title,
}: SavePlanControlProps) {
  const { status } = useSession();

  const [phase, setPhase] = useState<Phase>('idle');
  const [failureMessage, setFailureMessage] = useState<string | null>(null);
  /**
   * Captured when the response arrives, not derived at render time: a successful
   * create hands the new id up to the caller, which immediately makes
   * `savedMealPlanId` non-null, so deriving the wording from the prop would
   * report an update for the request that created the record.
   */
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [noticeOpen, setNoticeOpen] = useState(false);
  /**
   * The acknowledgment flag the last submission carried. A retry replays it, so
   * "resubmits the same save request" (5.11) stays literally true across the
   * acknowledged path too.
   */
  const [acknowledged, setAcknowledged] = useState(false);

  const submit = useCallback(
    async (withAck: boolean) => {
      setAcknowledged(withAck);
      setPhase('saving');
      setFailureMessage(null);

      const isUpdate = savedMealPlanId !== null;

      // `title` is omitted rather than sent as an empty string: an absent title
      // is what makes the API apply the date-based default (Requirement 5.5).
      const body: Record<string, unknown> = isUpdate
        ? { content: mealPlan }
        : { mealPlan };
      if (title !== undefined) body.title = title;
      if (withAck) body.acknowledgeStorage = true;

      const result = await callApi<SaveResponse>(
        isUpdate ? `/api/meal-plans/${savedMealPlanId}` : '/api/meal-plans',
        { method: isUpdate ? 'PUT' : 'POST', body: JSON.stringify(body) }
      );

      if (result.ok) {
        setNoticeOpen(false);
        setConfirmation(isUpdate ? UPDATED_MESSAGE : SAVED_MESSAGE);
        setPhase('saved');
        // A `PUT` echoes the id back, but fall back to the one already held so a
        // response that omits it cannot erase the record's identity.
        const assignedId = result.data?.mealPlanId ?? savedMealPlanId;
        if (assignedId !== null && assignedId !== undefined) {
          onSaved(assignedId);
        }
        return;
      }

      // The server has not yet recorded an acknowledgment for this Account. The
      // plan stays in view; the notice decides whether the same save is replayed.
      if (result.kind === 'ack-required') {
        setPhase('idle');
        setNoticeOpen(true);
        return;
      }

      // Every other failure — including a credential refusal, which `callApi`
      // has already turned into a signed-out Session — leaves the plan untouched
      // and offers the retry.
      setNoticeOpen(false);
      setFailureMessage(result.message);
      setPhase('failed');
    },
    [mealPlan, onSaved, savedMealPlanId, title]
  );

  const handleSave = useCallback(() => {
    void submit(false);
  }, [submit]);

  const handleRetry = useCallback(() => {
    void submit(acknowledged);
  }, [acknowledged, submit]);

  const handleAcknowledge = useCallback(() => {
    void submit(true);
  }, [submit]);

  const handleDecline = useCallback(() => {
    setNoticeOpen(false);
    setPhase('declined');
  }, []);

  // Until the Auth_Service reports its first state there is no honest answer to
  // "is a Session active", and guessing would flash the account-required message
  // at a signed-in Patient.
  if (status === 'loading') return null;

  // Requirement 5.12 — no control, and the account-required message instead.
  if (status !== 'authenticated') {
    return (
      <div className="pt-2">
        <p className="text-sm text-brand-800/60" data-testid="save-plan-account-required">
          {ACCOUNT_REQUIRED_MESSAGE}
        </p>
      </div>
    );
  }

  const saving = phase === 'saving';
  const label = saving ? SAVING_LABEL : savedMealPlanId === null ? SAVE_LABEL : UPDATE_LABEL;

  return (
    <div className="pt-2 space-y-3">
      <button
        type="button"
        onClick={handleSave}
        disabled={saving}
        aria-busy={saving}
        className="btn-primary disabled:opacity-40"
      >
        {label}
      </button>

      {phase === 'saved' && confirmation !== null && (
        <p role="status" className="text-sm text-brand-700">
          {confirmation}
        </p>
      )}

      {phase === 'declined' && (
        <p role="status" className="text-sm text-brand-800/60">
          {STORAGE_NOTICE_DECLINED_MESSAGE}
        </p>
      )}

      {phase === 'failed' && failureMessage !== null && (
        <div role="alert" className="text-sm text-red-700 space-y-2">
          <p>{failureMessage}</p>
          <button
            type="button"
            onClick={handleRetry}
            className="px-4 py-2 text-sm font-medium text-red-700 border border-red-300 rounded-sm hover:bg-red-50 transition-colors"
          >
            {RETRY_LABEL}
          </button>
        </div>
      )}

      {noticeOpen && (
        <StorageNoticeDialog
          onAcknowledge={handleAcknowledge}
          onDecline={handleDecline}
          submitting={saving}
        />
      )}
    </div>
  );
}
