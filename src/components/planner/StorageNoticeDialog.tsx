'use client';

/**
 * The first-save storage notice (Requirements 12.3, 12.5).
 *
 * The Meal_Plan_API is the thing that actually enforces the acknowledgment: a
 * save on an Account with no recorded `storageAckAt` and no `acknowledgeStorage`
 * in the body fails the transaction's condition and comes back as the
 * `ack-required` failure kind from `src/lib/apiClient.ts`. This dialog is the
 * browser half of that exchange, and it is deliberately stateless about the
 * request:
 *
 * - **Requirement 12.3** — the notice says the data is health-related, says it
 *   is stored in the cloud under this Account, and names the region. The region
 *   wording is the same as `/privacy` (`us-east-1`, US East, Northern Virginia)
 *   so the two surfaces cannot drift, and the notice links to `/privacy` for the
 *   longer version.
 * - **Requirement 12.5** — declining, closing with the × control, and pressing
 *   Escape are one path, `onDecline`. Nothing is written because nothing is
 *   resubmitted: the caller keeps the generated Meal_Plan in view and shows
 *   `STORAGE_NOTICE_DECLINED_MESSAGE`.
 *
 * The save request itself lives in `SavePlanControl`, which owns the retry with
 * `acknowledgeStorage: true`. This component only reports which control the
 * Patient activated, which is why the acknowledgment cannot be recorded here
 * (Requirement 12.4 records it against the User_Id, server-side, in the same
 * transaction as the save).
 */

import { useEffect, useRef } from 'react';

// ─── Copy (Requirements 12.3, 12.5) ────────────────────────────────────────────

/** The AWS region identifier, matching `/privacy`. */
export const STORAGE_REGION = 'us-east-1';

/** The plain-language name of that region, matching `/privacy`. */
export const STORAGE_REGION_LABEL = 'US East, Northern Virginia';

/**
 * Requirement 12.5 — the message shown beside the retained Meal_Plan once the
 * notice is declined. Exported so `SavePlanControl` renders this exact wording
 * rather than a second phrasing of the same thing.
 */
export const STORAGE_NOTICE_DECLINED_MESSAGE =
  'Saving requires acknowledging the storage notice. Your meal plan is still here, and nothing has been saved.';

export const ACKNOWLEDGE_LABEL = 'Acknowledge and Save';
export const DECLINE_LABEL = "Don't Save";

// ─── Component ─────────────────────────────────────────────────────────────────

export interface StorageNoticeDialogProps {
  /**
   * The Patient accepted. The caller resubmits the same save with
   * `acknowledgeStorage: true`.
   */
  onAcknowledge: () => void;
  /**
   * The Patient declined, closed, or pressed Escape. The caller writes nothing
   * and keeps the generated Meal_Plan in view.
   */
  onDecline: () => void;
  /**
   * True while the acknowledged save is in flight. Both controls are disabled so
   * the same save cannot be submitted twice, and neither can be abandoned
   * mid-write.
   */
  submitting?: boolean;
}

export default function StorageNoticeDialog({
  onAcknowledge,
  onDecline,
  submitting = false,
}: StorageNoticeDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Focus lands on the panel rather than on a control, so a screen reader reads
  // the notice before either choice is reachable — the point of the notice is
  // that it is read.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  // Escape is a decline, not a neutral dismissal: Requirement 12.5 treats
  // closing the notice and declining it as the same outcome. It is ignored while
  // a save is in flight, which is the same rule the controls follow.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) {
        onDecline();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onDecline, submitting]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-brand-800/40">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="storage-notice-heading"
        aria-describedby="storage-notice-body"
        tabIndex={-1}
        className="bg-brand-50 w-full max-w-md mx-4 p-10 relative border border-brand-800/10 rounded-sm max-h-[90vh] overflow-y-auto focus:outline-none"
      >
        <button
          type="button"
          onClick={onDecline}
          disabled={submitting}
          className="absolute top-4 right-4 text-brand-800/40 hover:text-brand-800 text-lg transition-opacity duration-200 disabled:opacity-40"
          aria-label="Close"
        >
          ×
        </button>

        <p className="text-xs uppercase tracking-widest text-brand-400 mb-2">
          Before we save
        </p>
        <h2 id="storage-notice-heading" className="text-xl mb-6">
          Storing your meal plan
        </h2>

        <div id="storage-notice-body" className="space-y-4 text-sm text-brand-800/80">
          <p>
            Saving this meal plan stores it in the cloud under your account. It
            is health-related data: the plan is built from your quiz answers
            about your symptoms, medications, allergies, and flare status.
          </p>
          <p>
            Saved meal plans are stored in Amazon DynamoDB in the AWS region{' '}
            <span className="font-semibold text-brand-700">{STORAGE_REGION}</span>{' '}
            ({STORAGE_REGION_LABEL}). They are encrypted at rest and kept until
            you delete them or delete your account.
          </p>
          <p className="text-xs text-brand-800/50">
            <a
              href="/privacy"
              className="underline hover:opacity-70 transition-opacity duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 rounded-sm"
            >
              Privacy Notice
            </a>
            {' — the full detail on what we store and how to remove it.'}
          </p>
        </div>

        <div className="mt-8 space-y-3">
          <button
            type="button"
            onClick={onAcknowledge}
            disabled={submitting}
            className="w-full btn-primary"
          >
            {submitting ? 'Saving...' : ACKNOWLEDGE_LABEL}
          </button>
          <button
            type="button"
            onClick={onDecline}
            disabled={submitting}
            className="w-full px-4 py-3 text-sm text-brand-800/60 border border-brand-800/15 rounded-sm hover:text-brand-800 transition-colors duration-200 disabled:opacity-40"
          >
            {DECLINE_LABEL}
          </button>
        </div>
      </div>
    </div>
  );
}
