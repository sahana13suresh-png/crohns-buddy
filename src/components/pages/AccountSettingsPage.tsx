'use client';

/**
 * The account settings view: the Account_Data_Export control, the
 * Account_Deletion_Flow, and the Privacy_Notice link.
 *
 * **Export (Requirements 10.1, 10.3, 10.4, 10.9).** The document is assembled
 * in two halves — `GET /api/account/export` supplies the identity and every
 * stored Meal_Plan_Record, and `trackerStorage.getAllEntries()` supplies the
 * entries held on this device, which the server cannot see. `trackerEntries` is
 * always present, `{}` rather than omitted, for a device holding none. Nothing
 * is written until the whole payload resolves: the `Blob` is constructed after
 * the response is in hand, so a failed or timed-out request produces a message
 * and a retry control and no partial file, which is exactly what Requirement
 * 10.9 asks for. The 10-second bound is `callApi`'s default.
 *
 * The download name comes from `exportFileName`, the same function the route
 * stamps into `Content-Disposition`, so the two halves cannot drift and the name
 * carries the UTC date rather than the browser's local one (Requirement 10.4).
 *
 * **Deletion (Requirements 11.1, 11.4, 11.6, 11.10).** The ordering and the
 * gates live in `src/lib/accountDeletion.ts`; this component is only the
 * renderer. It holds a `DeletionContext` and draws whatever state the machine
 * reports, which keeps the irreversible parts in one tested place:
 *
 * - `confirming` lists the data categories, states that the removal cannot be
 *   undone, and keeps the confirm control disabled until `isConfirmEnabled`
 *   says the typed text is exactly `DELETE` (Requirement 11.2). Submitting with
 *   text that does not match is still *possible* — Enter in the field — and that
 *   path is what produces the exact-match message of Requirement 11.8, so the
 *   key is handled explicitly rather than left to implicit form submission.
 * - `reauthenticating` is the prompt of Requirements 11.5 and 11.6. A success
 *   returns to `confirming` with the field emptied, because the machine has no
 *   path from re-authentication straight into a destructive step, so the Patient
 *   types the confirmation text again.
 * - `aborted` shows the machine's message and a restart control (Requirements
 *   11.9, 11.10). Nothing has been removed on that path unless the message says
 *   otherwise.
 * - `completed` shows the confirmation of Requirement 11.4 together with the
 *   signin and signup controls, and carries the Requirement 11.7 wording when
 *   the purge left records behind and enqueued the User_Id.
 *
 * The export control stays rendered while the deletion flow is open, which is
 * the "SHALL display the Account_Data_Export control" half of Requirement 11.2 —
 * the Patient can take a copy right up until they confirm.
 *
 * **Requirement 12.2** — the Privacy_Notice link is rendered unconditionally,
 * so it is present for a signed-in Patient, for a signed-out visitor, and after
 * the Account is deleted.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AuthModal from '@/components/AuthModal';
import { useSession } from '@/components/auth/SessionProvider';
import {
  CONFIRMATION_TEXT,
  DELETION_MESSAGE_TEXT,
  confirmAccountDeletion,
  createBrowserDeletionPorts,
  initialDeletionContext,
  isConfirmEnabled,
  reduceDeletion,
  submitReauthentication,
  type AccountDeletionPorts,
  type DeletionContext,
} from '@/lib/accountDeletion';
import { exportFileName } from '@/lib/accountExportFile';
import { callApi } from '@/lib/apiClient';
import { isCognitoConfigured } from '@/lib/auth';
import { getAllEntries, type TrackerEntries } from '@/lib/trackerStorage';
// Type-only, so no module edge is created into the route's dependency graph —
// that module reaches the DynamoDB client, which has no business in a browser
// bundle. The file-naming rule it shares lives in `@/lib/accountExportFile`.
import type { AccountDataExport } from '@/app/api/account/export/accountExport';

// ─── The downloaded document ───────────────────────────────────────────────────

/**
 * What the Patient actually receives: the server document plus the device-local
 * Symptom Tracker entries (Requirement 10.2). `trackerEntries` is a collection
 * either way — `{}` for a device holding none, never an absent key
 * (Requirement 10.3).
 */
export interface AccountExportFile extends AccountDataExport {
  trackerEntries: TrackerEntries;
}

// ─── Copy ──────────────────────────────────────────────────────────────────────

export const EXPORT_LABEL = 'Download my data';
export const EXPORT_RETRY_LABEL = 'Try the export again';

/** Requirement 10.9 — the export did not complete, and no file was written. */
export const EXPORT_FAILED_MESSAGE =
  'The export did not complete, so no file was saved. Your saved meal plans and your symptom tracker entries are unchanged.';

export function exportReadyMessage(fileName: string): string {
  return `Your data downloaded as ${fileName}.`;
}

export const DELETE_ACCOUNT_LABEL = 'Delete my account';
export const CONFIRM_DELETE_LABEL = 'Delete my account permanently';
export const KEEP_ACCOUNT_LABEL = 'Keep my account';
export const RESTART_LABEL = 'Start the deletion over';
export const REAUTH_SUBMIT_LABEL = 'Confirm it is you';
export const REAUTH_CANCEL_LABEL = 'Cancel deletion';
export const REAUTH_PRIVACY_MESSAGE =
  'For your security, you will be asked to confirm your identity again before continuing.';

/** Requirement 11.2 — the categories the flow removes, listed before anything runs. */
export const DELETION_CATEGORIES: readonly string[] = [
  'Your account identity — your display name and your email address',
  'Every meal plan saved to your account',
  'The symptom tracker entries held in this browser on this device',
];

/** Requirement 11.2 — stated in the flow itself, not only in the confirmation. */
export const IRREVERSIBLE_MESSAGE = 'This removes the data for good and cannot be undone.';

export const CONFIRMATION_PROMPT = `Type ${CONFIRMATION_TEXT} to confirm`;

export const EXPORT_FIRST_MESSAGE =
  'Download a copy of your data first if you want to keep one. The export control above stays available until you confirm.';

/** Requirement 11.3 — the destructive steps are running. */
export const DELETION_IN_PROGRESS_MESSAGE = 'Removing your data…';

export const SIGNED_OUT_MESSAGE =
  'Sign in to download a copy of your data or to delete your account.';

// ─── Download ──────────────────────────────────────────────────────────────────

/**
 * Writes `json` to a file download. Called only once the full payload has
 * resolved, so there is no path on which a partial document reaches disk
 * (Requirement 10.9).
 */
function downloadJsonFile(json: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const CARD = 'bg-white border border-brand-800/10 rounded-sm p-6 space-y-4';
const SECONDARY_BUTTON =
  'px-4 py-3 text-sm text-brand-800/60 border border-brand-800/15 rounded-sm hover:text-brand-800 transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 disabled:opacity-60 disabled:cursor-not-allowed';
const INPUT_CLASS =
  'w-full px-4 py-3 bg-transparent border border-brand-800/15 rounded-sm text-sm text-brand-800 placeholder:text-brand-800/30 focus:outline-none focus:border-brand-400 transition-colors duration-200';
const LABEL_CLASS = 'block text-xs uppercase tracking-widest text-brand-800/50 mb-2';

// ─── Component ─────────────────────────────────────────────────────────────────

export interface AccountSettingsPageProps {
  /**
   * Test seam for the five destructive operations. Absent uses the real ports:
   * the purge route, the Auth_Service, and localStorage.
   */
  deletionPorts?: AccountDeletionPorts;
}

export default function AccountSettingsPage({ deletionPorts }: AccountSettingsPageProps = {}) {
  const authConfigured = isCognitoConfigured();
  const { session, status } = useSession();

  const ports = useMemo(
    () => deletionPorts ?? createBrowserDeletionPorts(),
    [deletionPorts]
  );

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  /** Null while the flow has not been started (Requirement 11.1). */
  const [deletion, setDeletion] = useState<DeletionContext | null>(null);
  const [deletionBusy, setDeletionBusy] = useState(false);
  const [modalMode, setModalMode] = useState<'login' | 'signup' | null>(null);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * Mirrors `deletionBusy` for the guard, because two activations in the same
   * tick would both read the pre-update state value and both reach the ports.
   */
  const busyRef = useRef(false);

  // ── Export (Requirements 10.1, 10.3, 10.4, 10.9) ──

  const runExport = useCallback(async () => {
    setExporting(true);
    setExportError(null);
    setExportNotice(null);

    const result = await callApi<AccountDataExport>('/api/account/export');

    if (!mounted.current) return;
    setExporting(false);

    if (!result.ok || result.data === undefined) {
      // Nothing has been serialized, so there is no partial file to clean up.
      // A credential refusal has its own wording; `callApi` has already ended
      // the Session, so the signin controls appear on the next render.
      setExportError(
        !result.ok && result.kind === 'unauthorized' ? result.message : EXPORT_FAILED_MESSAGE
      );
      return;
    }

    // The whole payload is in hand, so the file can be built. The tracker
    // entries are merged in as a collection either way (Requirement 10.3).
    const file: AccountExportFile = { ...result.data, trackerEntries: getAllEntries() };
    const fileName = exportFileName(Date.now());

    try {
      downloadJsonFile(JSON.stringify(file, null, 2), fileName);
    } catch {
      // The browser refused the download. Nothing was saved, so this is the
      // same outcome as a failed request: a message and a retry control.
      setExportError(EXPORT_FAILED_MESSAGE);
      return;
    }

    setExportNotice(exportReadyMessage(fileName));
  }, []);

  // ── Deletion (Requirements 11.1 through 11.10) ──

  const startDeletion = useCallback(() => {
    setDeletion(initialDeletionContext());
  }, []);

  const changeConfirmationText = useCallback((text: string) => {
    setDeletion((current) =>
      current === null ? current : reduceDeletion(current, { type: 'confirmation-text-changed', text })
    );
  }, []);

  /**
   * The confirm control and the Enter key in the confirmation field. Both gates
   * — the exact text and the 5-minute freshness of the last authentication —
   * are applied inside `confirmAccountDeletion`, so this handler cannot skip
   * either. With no Session the authentication time is treated as absent, which
   * is stale, so the flow prompts rather than removing anything.
   */
  const submitConfirmation = useCallback(async () => {
    if (deletion === null || busyRef.current) return;

    busyRef.current = true;
    setDeletionBusy(true);

    const next = await confirmAccountDeletion(deletion, ports, session?.authTimeMs ?? 0);

    busyRef.current = false;
    if (!mounted.current) return;
    setDeletionBusy(false);
    setDeletion(next);
  }, [deletion, ports, session?.authTimeMs]);

  /** Requirements 11.5, 11.6, 11.10 — the re-authentication prompt. */
  const submitReauth = useCallback(async () => {
    if (deletion === null || busyRef.current) return;

    busyRef.current = true;
    setDeletionBusy(true);

    const next = await submitReauthentication(deletion, ports);

    busyRef.current = false;
    if (!mounted.current) return;
    setDeletionBusy(false);
    setDeletion(next);
  }, [deletion, ports]);

  const cancelReauth = useCallback(() => {
    setDeletion((current) =>
      current === null ? current : reduceDeletion(current, { type: 'reauth-cancelled' })
    );
  }, []);

  const restartDeletion = useCallback(() => {
    setDeletion((current) =>
      current === null ? current : reduceDeletion(current, { type: 'restart' })
    );
  }, []);

  const closeDeletion = useCallback(() => {
    setDeletion(null);
  }, []);

  // ── Derived state ──

  const signedIn = status === 'authenticated' && session !== null;
  const deletionCompleted = deletion?.state === 'completed';
  const deletionMessage = deletion?.message === undefined || deletion.message === null
    ? null
    : DELETION_MESSAGE_TEXT[deletion.message];

  // ── Pieces ──

  /** Requirements 10.8 and 11.4 both ask for these controls by name. */
  const authControls = (
    <div className="flex flex-wrap gap-3">
      {authConfigured ? (
        <>
          <button type="button" onClick={() => setModalMode('login')} className="btn-primary">
            Log In
          </button>
          <button type="button" onClick={() => setModalMode('signup')} className={SECONDARY_BUTTON}>
            Sign Up
          </button>
        </>
      ) : (
        <p className="text-sm text-brand-800/60">
          Account features are not configured for this deployment.
        </p>
      )}
    </div>
  );

  /** Requirement 12.2 — present in the account settings view at all times. */
  const privacyLink = (
    <p className="text-xs text-brand-800/50">
      <a
        href="/privacy"
        className="underline hover:opacity-70 transition-opacity duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 rounded-sm"
      >
        Privacy Notice
      </a>
    </p>
  );

  const exportSection = (
    <section aria-labelledby="account-export" className="space-y-4">
      <h2 id="account-export">Your data</h2>
      <div className={CARD}>
        <p className="text-sm text-brand-800/70">
          Download a single JSON file holding your account details, every meal plan saved to your
          account, and the symptom tracker entries held in this browser.
        </p>

        <button
          type="button"
          onClick={() => void runExport()}
          disabled={exporting}
          className="btn-primary"
        >
          {exporting ? 'Preparing your file…' : EXPORT_LABEL}
        </button>

        {exportNotice !== null && (
          <p role="status" className="text-sm text-brand-800/60">
            {exportNotice}
          </p>
        )}

        {exportError !== null && (
          <div className="space-y-3">
            <p role="alert" className="text-sm text-red-700/80">
              {exportError}
            </p>
            {/* Requirement 10.9 — a control that retries the request. */}
            <button
              type="button"
              onClick={() => void runExport()}
              disabled={exporting}
              className={SECONDARY_BUTTON}
            >
              {EXPORT_RETRY_LABEL}
            </button>
          </div>
        )}
      </div>
    </section>
  );

  const deletionSection = (
    <section aria-labelledby="account-deletion" className="space-y-4">
      <h2 id="account-deletion">Delete your account</h2>
      <div className={CARD}>
        {deletion === null && (
          <>
            <p className="text-sm text-brand-800/70">
              Deleting your account removes your saved meal plans from cloud storage, removes the
              account itself, and clears the symptom tracker entries held in this browser.
            </p>
            {/* Requirement 11.1 — the control that starts the flow. */}
            <button type="button" onClick={startDeletion} className={SECONDARY_BUTTON}>
              {DELETE_ACCOUNT_LABEL}
            </button>
          </>
        )}

        {deletion !== null && deletion.state === 'confirming' && (
          <>
            {/* Requirement 11.2 — the categories, then the irreversibility. */}
            <p className="text-sm text-brand-800/70">This removes:</p>
            <ul className="list-disc list-inside space-y-2 ml-4 text-sm text-brand-800/70">
              {DELETION_CATEGORIES.map((category) => (
                <li key={category}>{category}</li>
              ))}
            </ul>
            <p className="text-sm font-semibold text-brand-800">{IRREVERSIBLE_MESSAGE}</p>
            <p className="text-sm text-brand-800/70">{EXPORT_FIRST_MESSAGE}</p>

            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submitConfirmation();
              }}
              className="space-y-4"
            >
              <div>
                <label htmlFor="deletion-confirmation" className={LABEL_CLASS}>
                  {CONFIRMATION_PROMPT}
                </label>
                <input
                  id="deletion-confirmation"
                  type="text"
                  autoComplete="off"
                  value={deletion.confirmationText}
                  onChange={(event) => changeConfirmationText(event.target.value)}
                  onKeyDown={(event) => {
                    // Requirement 11.8 is only reachable through a submission
                    // the confirm control refuses, so Enter is handled here
                    // rather than left to implicit form submission, which a
                    // disabled submit control suppresses.
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void submitConfirmation();
                    }
                  }}
                  className={INPUT_CLASS}
                  placeholder={CONFIRMATION_TEXT}
                />
              </div>

              {deletionMessage !== null && (
                <p role="alert" className="text-sm text-red-700/80">
                  {deletionMessage}
                </p>
              )}

              <div className="flex flex-wrap gap-3">
                {/* Requirement 11.2 — disabled until the text is exactly DELETE. */}
                <button
                  type="submit"
                  disabled={!isConfirmEnabled(deletion) || deletionBusy}
                  className="btn-primary"
                >
                  {CONFIRM_DELETE_LABEL}
                </button>
                <button
                  type="button"
                  onClick={closeDeletion}
                  disabled={deletionBusy}
                  className={SECONDARY_BUTTON}
                >
                  {KEEP_ACCOUNT_LABEL}
                </button>
              </div>
            </form>
          </>
        )}

        {deletion !== null && deletion.state === 'reauthenticating' && (
          <>
            <p role="alert" className="text-sm text-brand-800/80">
              {deletionMessage ?? DELETION_MESSAGE_TEXT['reauth-required']}
            </p>

            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submitReauth();
              }}
              className="space-y-4"
            >
              <p className="text-sm text-brand-800/65">{REAUTH_PRIVACY_MESSAGE}</p>

              <div className="flex flex-wrap gap-3">
                <button type="submit" disabled={deletionBusy} className="btn-primary">
                  {REAUTH_SUBMIT_LABEL}
                </button>
                {/* Requirement 11.10 — cancelling ends the flow, removing nothing. */}
                <button
                  type="button"
                  onClick={cancelReauth}
                  disabled={deletionBusy}
                  className={SECONDARY_BUTTON}
                >
                  {REAUTH_CANCEL_LABEL}
                </button>
              </div>
            </form>
          </>
        )}

        {deletion !== null && deletion.state === 'aborted' && (
          <>
            <p role="alert" className="text-sm text-red-700/80">
              {deletionMessage}
            </p>
            {/* Requirement 11.9 — a control that restarts the flow. */}
            <div className="flex flex-wrap gap-3">
              <button type="button" onClick={restartDeletion} className="btn-primary">
                {RESTART_LABEL}
              </button>
              <button type="button" onClick={closeDeletion} className={SECONDARY_BUTTON}>
                {KEEP_ACCOUNT_LABEL}
              </button>
            </div>
          </>
        )}

        {deletionBusy && (
          <p role="status" className="text-sm text-brand-800/60">
            {DELETION_IN_PROGRESS_MESSAGE}
          </p>
        )}
      </div>
    </section>
  );

  /** Requirements 11.4 and 11.7 — the confirmation, and the pending wording. */
  const completionSection = (
    <section aria-labelledby="account-deleted" className="space-y-4">
      <h2 id="account-deleted">Account deleted</h2>
      <div className={CARD}>
        <p role="status" className="text-sm text-brand-800/80">
          {deletionMessage ?? DELETION_MESSAGE_TEXT.completed}
        </p>
        {authControls}
      </div>
    </section>
  );

  const signedOutSection = (
    <section aria-labelledby="account-signed-out" className="space-y-4">
      <h2 id="account-signed-out">Account</h2>
      <div className={CARD}>
        <p className="text-sm text-brand-800/70">{SIGNED_OUT_MESSAGE}</p>
        {authControls}
      </div>
    </section>
  );

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-10">
      <h1 className="text-center mb-8">Account settings</h1>

      {deletionCompleted ? (
        completionSection
      ) : signedIn ? (
        <>
          {exportSection}
          {deletionSection}
        </>
      ) : (
        signedOutSection
      )}

      {privacyLink}

      {authConfigured && modalMode !== null && (
        <AuthModal
          mode={modalMode}
          onClose={() => setModalMode(null)}
          onSuccess={() => setModalMode(null)}
          onSwitchMode={() => setModalMode(modalMode === 'login' ? 'signup' : 'login')}
        />
      )}
    </div>
  );
}
