/**
 * The browser half of the Account_Deletion_Flow (Requirement 11).
 *
 * Deletion is the one irreversible operation in the product, and the
 * requirements disagree about what may be left behind depending on *when* a
 * step fails: Requirement 11.9 demands that a record-removal failure leave the
 * Account, every remaining record, and the Session untouched, while
 * Requirement 11.7 accepts a residue of records once the Account is already
 * gone. Getting that right is an ordering problem, so the flow is written as an
 * explicit state machine rather than as a sequence of `await`s inside a
 * component:
 *
 * - {@link DELETION_TRANSITIONS} is the whole machine, as data. Every legal
 *   `(state, event) -> state` step is an entry in that array, so a test can
 *   assert a *negative* — that no entry leads from `reauthenticating` to
 *   `purging` — which is what Requirement 11.6 needs and what no amount of
 *   reading imperative code can establish.
 * - {@link reduceDeletion} is pure. It performs no I/O, so it can be driven over
 *   arbitrary event sequences without React, a browser, or Firebase.
 * - The four destructive effects are *states*, not statements:
 *   {@link EFFECT_FOR_STATE} maps `purging`, `removingAccount`,
 *   `clearingTracker`, and `endingSession` onto the one port each is allowed to
 *   call. {@link advanceAccountDeletion} is the only code that calls a port, and
 *   it can only call the port the current state names. The order in
 *   Requirement 11.3 is therefore a property of the transition table rather than
 *   a convention a future edit could quietly break.
 *
 * The server route this drives (`POST /api/account/purge`) removes
 * Meal_Plan_Records and **not** the Account — the Auth_Service admin surface is
 * unreachable from the server by design. So a `200` from the purge is the only
 * thing that unlocks `deleteCurrentAccount()`, and a `500` means nothing was
 * removed and the Session is still active.
 */

import type { AccountPurgeResult } from '@/app/api/account/purge/accountPurge';
import {
  classifyAuthError,
  deleteCurrentAccount,
  reauthenticate as reauthenticateAccount,
  signOutEverywhere,
} from './auth';
import { callApi, type ApiResult } from './apiClient';
import { clearAllEntries } from './trackerStorage';

// ─── Constants ─────────────────────────────────────────────────────────────────

/**
 * Requirements 11.2 and 11.8 — the confirmation field must hold exactly this,
 * compared with `===`. No trimming, no case folding: "types the exact uppercase
 * text" leaves no room for either.
 */
export const CONFIRMATION_TEXT = 'DELETE';

/** Requirement 11.5 — an authentication older than this re-prompts. */
export const REAUTH_WINDOW_MS = 5 * 60 * 1000;

/** Requirement 11.10 — the flow ends after this many consecutive failures. */
export const MAX_REAUTH_ATTEMPTS = 3;

/**
 * Bound on the purge request. Requirement 11.3 gives the whole flow 30 seconds,
 * which is the shorter of the two clocks that apply here — the route's own retry
 * budget is 60 seconds (Requirement 11.7) — so 30 seconds is what the client
 * waits. A purge that outruns it is reported as an incomplete deletion with the
 * restart control of Requirement 11.9; restarting re-issues the purge, which is
 * idempotent, so a request that in fact succeeded after the client stopped
 * waiting costs a repeat, not a wrong outcome.
 */
export const PURGE_TIMEOUT_MS = 30_000;

// ─── States ────────────────────────────────────────────────────────────────────

/**
 * `confirming` is the confirmation step of Requirement 11.2: the data categories
 * are listed and the confirm control stays disabled until the text matches.
 * `aborted` and `completed` are terminal, and `aborted` always means the
 * *Account* is still there.
 */
export const DELETION_STATES = [
  'confirming',
  'reauthenticating',
  'purging',
  'removingAccount',
  'clearingTracker',
  'endingSession',
  'completed',
  'aborted',
] as const;

export type DeletionState = (typeof DELETION_STATES)[number];

/** States from which no transition leaves. */
export const TERMINAL_DELETION_STATES: readonly DeletionState[] = ['completed', 'aborted'];

// ─── Effects ───────────────────────────────────────────────────────────────────

/**
 * The four steps of Requirement 11.3, in the order that requirement fixes.
 * Exported as an ordered list because Property 20 asserts the observed order of
 * effects against it directly.
 */
export const DESTRUCTIVE_EFFECT_ORDER = [
  'remove-records',
  'remove-account',
  'clear-tracker',
  'end-session',
] as const;

export type DeletionEffect = (typeof DESTRUCTIVE_EFFECT_ORDER)[number];

/**
 * The single port each state is permitted to call. A state absent from this map
 * performs no I/O at all, which is what makes `confirming`, `reauthenticating`,
 * and both terminal states safe to sit in indefinitely.
 */
export const EFFECT_FOR_STATE: Readonly<Partial<Record<DeletionState, DeletionEffect>>> =
  Object.freeze({
    purging: 'remove-records',
    removingAccount: 'remove-account',
    clearingTracker: 'clear-tracker',
    endingSession: 'end-session',
  });

// ─── Messages ──────────────────────────────────────────────────────────────────

/**
 * What the Patient is told, as a code rather than a string, so the flow stays
 * renderer-agnostic and the tests assert on the outcome instead of on copy.
 */
export type DeletionMessage =
  | 'confirmation-mismatch'
  | 'reauth-required'
  | 'reauth-failed'
  | 'retype-confirmation'
  | 'session-expired'
  | 'deletion-incomplete'
  | 'account-removal-incomplete'
  | 'not-deleted'
  | 'completed'
  | 'completed-pending';

/** Default copy for each message code. The account settings view may override. */
export const DELETION_MESSAGE_TEXT: Readonly<Record<DeletionMessage, string>> = Object.freeze({
  'confirmation-mismatch': `The confirmation text must match ${CONFIRMATION_TEXT} exactly.`,
  'reauth-required': 'Confirm it is you before your account is deleted.',
  'reauth-failed': 'That did not match. Try confirming it is you again.',
  'retype-confirmation': `Type ${CONFIRMATION_TEXT} again to delete your account.`,
  'session-expired': 'Your session expired, so nothing was deleted. Sign in again to continue.',
  'deletion-incomplete':
    'The deletion did not complete. Your account and your saved meal plans are unchanged.',
  'account-removal-incomplete':
    'Your saved meal plans were removed, but your account was not. Restart to finish.',
  'not-deleted': 'Your account was not deleted.',
  completed:
    'Your account, your saved meal plans, and the symptom tracker entries on this device are removed.',
  'completed-pending':
    'Your account is removed. Removal of the remaining meal plan data is still in progress.',
});

// ─── Events ────────────────────────────────────────────────────────────────────

/**
 * Events divide into two groups. `confirmation-text-changed`, `confirm-submitted`,
 * `restart`, and the three `reauth-*` events come from the Patient. The rest
 * report what a port did, and are only ever dispatched by
 * {@link advanceAccountDeletion}.
 */
export type DeletionEvent =
  | { readonly type: 'confirmation-text-changed'; readonly text: string }
  | { readonly type: 'confirm-submitted'; readonly authTimeMs: number; readonly nowMs: number }
  | { readonly type: 'reauth-succeeded' }
  | { readonly type: 'reauth-failed' }
  | { readonly type: 'reauth-cancelled' }
  | { readonly type: 'session-expired' }
  | { readonly type: 'purge-succeeded'; readonly result: AccountPurgeResult }
  | { readonly type: 'purge-failed' }
  | { readonly type: 'account-removed' }
  | { readonly type: 'account-removal-requires-recent-login' }
  | { readonly type: 'account-removal-failed' }
  | { readonly type: 'tracker-cleared' }
  | { readonly type: 'session-ended' }
  | { readonly type: 'restart' };

export type DeletionEventType = DeletionEvent['type'];

// ─── Context ───────────────────────────────────────────────────────────────────

export interface DeletionContext {
  readonly state: DeletionState;
  /** Exactly what the Patient has typed into the confirmation field. */
  readonly confirmationText: string;
  /** Consecutive re-authentication failures (Requirement 11.10). */
  readonly reauthFailures: number;
  readonly message: DeletionMessage | null;
  /** Records the purge reported removed; 0 until it reports. */
  readonly deletedCount: number;
  /** Records the purge left behind (Requirement 11.7). */
  readonly remaining: number;
  /** True once the User_Id is on the pending-deletion list. */
  readonly pendingDeletion: boolean;
  /**
   * Destructive effects that have completed, in the order they were observed.
   * Append-only, and never reset — a restart cannot un-remove anything, so this
   * stays an honest log of what happened to the Account across the whole
   * session, not a per-attempt counter.
   */
  readonly completedEffects: readonly DeletionEffect[];
}

/** A flow just opened from the account settings view (Requirement 11.1). */
export function initialDeletionContext(): DeletionContext {
  return {
    state: 'confirming',
    confirmationText: '',
    reauthFailures: 0,
    message: null,
    deletedCount: 0,
    remaining: 0,
    pendingDeletion: false,
    completedEffects: [],
  };
}

/** Requirements 11.2 and 11.8 — the exact-match predicate, and nothing else. */
export function matchesConfirmationText(text: string): boolean {
  return text === CONFIRMATION_TEXT;
}

/** Whether the confirm control is enabled (Requirement 11.2). */
export function isConfirmEnabled(context: DeletionContext): boolean {
  return context.state === 'confirming' && matchesConfirmationText(context.confirmationText);
}

/** Whether the flow has removed anything at all. */
export function hasRemovedData(context: DeletionContext): boolean {
  return context.completedEffects.length > 0;
}

function isStaleAuth(authTimeMs: number, nowMs: number): boolean {
  return nowMs - authTimeMs > REAUTH_WINDOW_MS;
}

// ─── The transition table ──────────────────────────────────────────────────────

export interface DeletionTransition {
  readonly from: DeletionState;
  readonly event: DeletionEventType;
  readonly to: DeletionState;
  /** Human-readable guard, present only on conditional entries. */
  readonly when?: string;
  readonly guard?: (context: DeletionContext, event: DeletionEvent) => boolean;
  readonly apply?: (context: DeletionContext, event: DeletionEvent) => Partial<DeletionContext>;
}

/**
 * Entries are matched in order and the first whose `from`, `event`, and `guard`
 * all hold wins, so guarded entries for a pair precede the unguarded fallback.
 * An event with no matching entry is ignored — which is the load-bearing half of
 * the safety argument: `purge-succeeded` cannot advance anything unless the
 * machine is already in `purging`, and it can only get there through the
 * confirmation and freshness gates below.
 *
 * Note what is absent. There is no entry from `reauthenticating` to `purging`.
 * Re-authentication always lands back in `confirming` with the field emptied, so
 * a Session that expires mid-flow costs the Patient the confirmation text again
 * (Requirement 11.6) and a successful re-auth can never resume a destructive
 * step on its own.
 */
export const DELETION_TRANSITIONS: readonly DeletionTransition[] = Object.freeze([
  // ── Confirmation step (11.2, 11.8) ──
  {
    from: 'confirming',
    event: 'confirmation-text-changed',
    to: 'confirming',
    apply: (_context, event) => ({
      confirmationText: (event as { text: string }).text,
      message: null,
    }),
  },
  {
    from: 'confirming',
    event: 'confirm-submitted',
    to: 'confirming',
    when: 'confirmation text is not exactly DELETE',
    guard: (context) => !matchesConfirmationText(context.confirmationText),
    // 11.8: the flow stays open with the field editable, and nothing is removed.
    apply: () => ({ message: 'confirmation-mismatch' as const }),
  },
  {
    from: 'confirming',
    event: 'confirm-submitted',
    to: 'reauthenticating',
    when: 'most recent authentication is more than 5 minutes old',
    guard: (_context, event) => {
      const { authTimeMs, nowMs } = event as { authTimeMs: number; nowMs: number };
      return isStaleAuth(authTimeMs, nowMs);
    },
    // 11.5: prompt, and remove nothing until re-authentication succeeds.
    apply: () => ({ message: 'reauth-required' as const, reauthFailures: 0 }),
  },
  {
    from: 'confirming',
    event: 'confirm-submitted',
    to: 'purging',
    when: 'confirmation text matches and the authentication is fresh',
    apply: () => ({ message: null }),
  },
  {
    from: 'confirming',
    event: 'session-expired',
    to: 'reauthenticating',
    apply: () => ({
      confirmationText: '',
      message: 'session-expired' as const,
      reauthFailures: 0,
    }),
  },

  // ── Re-authentication (11.5, 11.6, 11.10) ──
  {
    from: 'reauthenticating',
    event: 'reauth-succeeded',
    to: 'confirming',
    // 11.6: back to the confirmation step, text required again.
    apply: () => ({
      confirmationText: '',
      reauthFailures: 0,
      message: 'retype-confirmation' as const,
    }),
  },
  {
    from: 'reauthenticating',
    event: 'reauth-failed',
    to: 'aborted',
    when: 'this failure is the third consecutive one',
    guard: (context) => context.reauthFailures + 1 >= MAX_REAUTH_ATTEMPTS,
    apply: (context) => ({
      reauthFailures: context.reauthFailures + 1,
      message: 'not-deleted' as const,
    }),
  },
  {
    from: 'reauthenticating',
    event: 'reauth-failed',
    to: 'reauthenticating',
    apply: (context) => ({
      reauthFailures: context.reauthFailures + 1,
      message: 'reauth-failed' as const,
    }),
  },
  {
    from: 'reauthenticating',
    event: 'reauth-cancelled',
    to: 'aborted',
    apply: () => ({ message: 'not-deleted' as const }),
  },

  // ── Record removal (11.3, 11.7, 11.9) ──
  {
    from: 'purging',
    event: 'purge-succeeded',
    to: 'removingAccount',
    apply: (context, event) => {
      const { result } = event as { result: AccountPurgeResult };
      return {
        deletedCount: result.deletedCount,
        remaining: result.remaining,
        pendingDeletion: result.pendingDeletion,
        completedEffects: [...context.completedEffects, 'remove-records' as const],
      };
    },
  },
  {
    from: 'purging',
    event: 'purge-failed',
    to: 'aborted',
    // 11.9: the Account and every remaining record are intact and the Session is
    // still active, because the purge route cannot touch either.
    apply: () => ({ message: 'deletion-incomplete' as const }),
  },
  {
    from: 'purging',
    event: 'session-expired',
    to: 'reauthenticating',
    // 11.6: a 401 from the purge removed nothing, so this returns to the
    // confirmation step by way of the re-authentication prompt.
    apply: () => ({
      confirmationText: '',
      message: 'session-expired' as const,
      reauthFailures: 0,
    }),
  },

  // ── Account removal (11.3, 11.5) ──
  {
    from: 'removingAccount',
    event: 'account-removed',
    to: 'clearingTracker',
    apply: (context) => ({
      completedEffects: [...context.completedEffects, 'remove-account' as const],
    }),
  },
  {
    from: 'removingAccount',
    event: 'account-removal-requires-recent-login',
    to: 'reauthenticating',
    apply: () => ({
      confirmationText: '',
      message: 'reauth-required' as const,
      reauthFailures: 0,
    }),
  },
  {
    from: 'removingAccount',
    event: 'account-removal-failed',
    to: 'aborted',
    // The records are gone but the Account is not, so the message says so and
    // the restart control re-runs the flow; the purge is idempotent.
    apply: () => ({ message: 'account-removal-incomplete' as const }),
  },

  // ── Device-local cleanup and Session end (11.3, 11.4) ──
  {
    from: 'clearingTracker',
    event: 'tracker-cleared',
    to: 'endingSession',
    apply: (context) => ({
      completedEffects: [...context.completedEffects, 'clear-tracker' as const],
    }),
  },
  {
    from: 'endingSession',
    event: 'session-ended',
    to: 'completed',
    apply: (context) => ({
      completedEffects: [...context.completedEffects, 'end-session' as const],
      message: context.pendingDeletion ? ('completed-pending' as const) : ('completed' as const),
    }),
  },

  // ── Restart after an abort (11.9) ──
  {
    from: 'aborted',
    event: 'restart',
    to: 'confirming',
    apply: () => ({ confirmationText: '', reauthFailures: 0, message: null }),
  },
]);

/** The matching transition for a `(state, event)` pair, or null when ignored. */
export function findDeletionTransition(
  context: DeletionContext,
  event: DeletionEvent
): DeletionTransition | null {
  for (const transition of DELETION_TRANSITIONS) {
    if (transition.from !== context.state || transition.event !== event.type) continue;
    if (transition.guard && !transition.guard(context, event)) continue;
    return transition;
  }
  return null;
}

/**
 * Applies one event. Pure, total, and immutable: an event the current state does
 * not admit returns the same context, so no caller can skip a gate by
 * dispatching a later event early.
 */
export function reduceDeletion(context: DeletionContext, event: DeletionEvent): DeletionContext {
  const transition = findDeletionTransition(context, event);
  if (!transition) return context;
  return {
    ...context,
    ...(transition.apply?.(context, event) ?? {}),
    state: transition.to,
  };
}

// ─── Ports ─────────────────────────────────────────────────────────────────────

/** What `removeAccount` observed, mapped from the account service response. */
export type AccountRemovalOutcome = 'removed' | 'requires-recent-login' | 'failed';

export type ReauthOutcome = 'succeeded' | 'failed' | 'cancelled';

/**
 * The four destructive operations plus re-authentication, as an interface, so
 * the machine can be driven over fakes with no Cognito, no `fetch`, and no
 * localStorage. Each is called by exactly one state.
 */
export interface AccountDeletionPorts {
  /** `POST /api/account/purge`. Removes records only; never the Account. */
  purgeRecords(): Promise<ApiResult<AccountPurgeResult>>;
  /** `deleteCurrentAccount()`, classified rather than thrown. */
  removeAccount(): Promise<AccountRemovalOutcome>;
  /** Clears this device's tracker entries. Must not throw. */
  clearTrackerEntries(): void | Promise<void>;
  /** Ends the Session. Must not throw. */
  endSession(): Promise<void>;
  /** Re-authenticates, classified rather than thrown. */
  reauthenticate(password?: string): Promise<ReauthOutcome>;
}

/** The real ports: Cognito, the purge route, and localStorage. */
export function createBrowserDeletionPorts(): AccountDeletionPorts {
  return {
    purgeRecords: () =>
      callApi<AccountPurgeResult>(
        '/api/account/purge',
        { method: 'POST' },
        { timeoutMs: PURGE_TIMEOUT_MS }
      ),

    removeAccount: async () => {
      try {
        await deleteCurrentAccount();
        return 'removed';
      } catch (err) {
        return classifyAuthError(err) === 'requires-recent-login' ? 'requires-recent-login' : 'failed';
      }
    },

    clearTrackerEntries: () => {
      clearAllEntries();
    },

    endSession: () => signOutEverywhere(),

    reauthenticate: async (password) => {
      try {
        await reauthenticateAccount(password);
        return 'succeeded';
      } catch (err) {
        return classifyAuthError(err) === 'popup-cancelled' ? 'cancelled' : 'failed';
      }
    },
  };
}

// ─── The driver ────────────────────────────────────────────────────────────────

/**
 * Runs the port the current state names and reports what it did. The `switch` is
 * over {@link EFFECT_FOR_STATE}'s values rather than over states, so a state
 * that names no effect cannot reach a port at all.
 */
async function performEffect(
  effect: DeletionEffect,
  ports: AccountDeletionPorts
): Promise<DeletionEvent> {
  switch (effect) {
    case 'remove-records': {
      const result = await ports.purgeRecords();
      if (result.ok) {
        // A 200 with no body cannot happen on this route, but a defensive
        // reading keeps an absent body from being treated as a clean purge.
        return result.data
          ? { type: 'purge-succeeded', result: result.data }
          : { type: 'purge-failed' };
      }
      // A credential refusal removed nothing, and Requirement 11.6 handles it
      // differently from an outage: re-authenticate and retype, not abort.
      return result.kind === 'unauthorized' ? { type: 'session-expired' } : { type: 'purge-failed' };
    }
    case 'remove-account': {
      const outcome = await ports.removeAccount();
      if (outcome === 'removed') return { type: 'account-removed' };
      if (outcome === 'requires-recent-login') {
        return { type: 'account-removal-requires-recent-login' };
      }
      return { type: 'account-removal-failed' };
    }
    case 'clear-tracker': {
      await ports.clearTrackerEntries();
      return { type: 'tracker-cleared' };
    }
    case 'end-session': {
      await ports.endSession();
      return { type: 'session-ended' };
    }
  }
}

/**
 * Drives the machine while the current state names a destructive effect, and
 * returns as soon as it reaches a state that needs the Patient again —
 * `confirming`, `reauthenticating` — or a terminal one. Because
 * {@link reduceDeletion} ignores events a state does not admit, the loop cannot
 * run an effect out of order, and it cannot run any effect at all from
 * `confirming` or `reauthenticating`.
 */
export async function advanceAccountDeletion(
  context: DeletionContext,
  ports: AccountDeletionPorts
): Promise<DeletionContext> {
  let current = context;
  for (;;) {
    const effect = EFFECT_FOR_STATE[current.state];
    if (!effect) return current;
    current = reduceDeletion(current, await performEffect(effect, ports));
  }
}

/**
 * The confirm control (Requirement 11.3). Submits the typed text against the
 * `auth_time` freshness gate and then runs whatever the gates allowed, which is
 * nothing at all when the text does not match or the authentication is stale.
 */
export async function confirmAccountDeletion(
  context: DeletionContext,
  ports: AccountDeletionPorts,
  authTimeMs: number,
  nowMs: number = Date.now()
): Promise<DeletionContext> {
  return advanceAccountDeletion(
    reduceDeletion(context, { type: 'confirm-submitted', authTimeMs, nowMs }),
    ports
  );
}

/**
 * The re-authentication prompt (Requirements 11.5, 11.6, 11.10). Always returns
 * to `confirming` on success — never straight into a destructive step — so the
 * caller must submit the confirmation text again.
 */
export async function submitReauthentication(
  context: DeletionContext,
  ports: AccountDeletionPorts,
  password?: string
): Promise<DeletionContext> {
  if (context.state !== 'reauthenticating') return context;
  const outcome = await ports.reauthenticate(password);
  const event: DeletionEvent =
    outcome === 'succeeded'
      ? { type: 'reauth-succeeded' }
      : outcome === 'cancelled'
        ? { type: 'reauth-cancelled' }
        : { type: 'reauth-failed' };
  return reduceDeletion(context, event);
}
