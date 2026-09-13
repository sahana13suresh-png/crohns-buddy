'use client';

/**
 * The Website's single source of Session state for the browser.
 *
 * Everything that needs to know whether a Session is active reads it from here
 * rather than subscribing to `onAuthChange` itself, because three separate
 * requirements have to agree on one answer:
 *
 * - **Requirement 2.5** — a stored Session whose 30 days have not elapsed is
 *   restored on load without prompting for credentials.
 * - **Requirement 2.13** — a stored Session whose 30 days *have* elapsed makes
 *   the visitor unauthenticated, empties the Meal_Plan_Record view, and shows
 *   the expiry message beside the signin and signup controls.
 * - **Requirement 2.8** — signout empties that same view and discards the
 *   locally held Session even when the Auth_Service returns no response.
 *
 * The 30-day bound is checked on load and on every auth change, against
 * `sessionStartedAtMs` carried on the `AuthSession` (Firebase refresh tokens do
 * not expire on their own, so the bound is enforced here). This is session
 * hygiene, not a security boundary: clearing localStorage resets the clock. The
 * enforced boundary is the one-hour ID token lifetime checked server-side.
 *
 * `planViewEpoch` is the mechanism for "empties the plan view". A consumer
 * holding a fetched list of Meal_Plan_Records discards it whenever the epoch
 * changes, which covers the case a bare `session === null` check misses: a
 * signout immediately followed by a signin to the same Account. The epoch is
 * raised in the same state update that drops the Session, so the clear happens
 * in the same render pass rather than after a round trip.
 *
 * An elapsed Session and a credential refusal from the Meal_Plan_API converge
 * on one path: `onUnauthorized` from `apiClient` lands in the same `expired`
 * state with the same message, because the server's 401 body is one opaque
 * constant and there is nothing more specific to say.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  completeRedirectSignIn,
  isSessionActive,
  onAuthChange,
  signOutEverywhere,
  type AuthSession,
  type GoogleSignInOutcome,
} from '@/lib/auth';
import { onUnauthorized, SESSION_EXPIRED_MESSAGE } from '@/lib/apiClient';

// ─── Types ─────────────────────────────────────────────────────────────────────

/**
 * `loading` lasts only until the Auth_Service reports its first state, so no
 * consumer has to guess between "no Session" and "not known yet" and briefly
 * flash the signin controls at a signed-in Patient.
 *
 * `expired` is `unauthenticated` plus the Requirement 2.13 message. It is kept
 * distinct so the message appears exactly when a Session ended on its own,
 * never for a visitor who simply never signed in (Requirement 2.6).
 */
export type SessionStatus = 'loading' | 'authenticated' | 'unauthenticated' | 'expired';

export interface SessionContextValue {
  /** The active Session, or null whenever the visitor is unauthenticated. */
  session: AuthSession | null;
  status: SessionStatus;
  /** The Requirement 2.13 wording; non-null exactly while `status` is `expired`. */
  expiredMessage: string | null;
  /**
   * Raised every time the Meal_Plan_Record view must be emptied — signout, an
   * elapsed Session, or a credential refusal. Consumers holding fetched records
   * drop them when this value changes.
   */
  planViewEpoch: number;
  /** Ends the Session, clearing the plan view in the same render pass (2.8). */
  signOut: () => Promise<void>;
  /** Dismisses the expiry message without starting a Session. */
  dismissExpiredMessage: () => void;
  /**
   * The outcome of a redirect-based Identity_Provider sign-in reconciled on
   * mount, or null when this load is not a return from the provider. The
   * Identity_Provider controls render the message for it (Requirements 3.7,
   * 3.8, 3.9) and then call `clearRedirectOutcome`.
   */
  redirectOutcome: GoogleSignInOutcome | null;
  clearRedirectOutcome: () => void;
}

interface SessionState {
  session: AuthSession | null;
  status: SessionStatus;
  planViewEpoch: number;
}

const INITIAL_STATE: SessionState = { session: null, status: 'loading', planViewEpoch: 0 };

const SessionContext = createContext<SessionContextValue | undefined>(undefined);

// ─── State transitions ─────────────────────────────────────────────────────────

/**
 * Drops the Session and raises the epoch. The one exception is the ordinary
 * first load for a visitor who holds no Session: reporting a clear there would
 * tell every consumer to discard a list it never fetched. An expiry always
 * raises it, because Requirement 2.13 asks for the clear by name and an
 * already-empty view costs nothing to empty again.
 */
function endedState(prev: SessionState, status: 'unauthenticated' | 'expired'): SessionState {
  const benignFirstLoad = status === 'unauthenticated' && prev.status === 'loading';
  const alreadyEnded = prev.session === null && prev.status === status;
  const keepEpoch = benignFirstLoad || alreadyEnded;
  return {
    session: null,
    status,
    planViewEpoch: keepEpoch ? prev.planViewEpoch : prev.planViewEpoch + 1,
  };
}

// ─── Provider ──────────────────────────────────────────────────────────────────

export default function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>(INITIAL_STATE);
  const [redirectOutcome, setRedirectOutcome] = useState<GoogleSignInOutcome | null>(null);

  /**
   * Whether the Session ended on its own. Ending it calls the Auth_Service,
   * which then reports "no user" through `onAuthChange`; without this the
   * follow-up emission would overwrite `expired` with plain `unauthenticated`
   * and the expiry message would vanish as soon as it appeared.
   */
  const expiredRef = useRef(false);

  const markExpired = useCallback(() => {
    expiredRef.current = true;
    setState((prev) => endedState(prev, 'expired'));
  }, []);

  const signOut = useCallback(async () => {
    expiredRef.current = false;
    // The view is emptied and the local Session dropped before the
    // Auth_Service is asked to do anything, so Requirement 2.8 holds even when
    // that request never comes back.
    setState((prev) => endedState(prev, 'unauthenticated'));
    await signOutEverywhere();
  }, []);

  const dismissExpiredMessage = useCallback(() => {
    expiredRef.current = false;
    setState((prev) => (prev.status === 'expired' ? { ...prev, status: 'unauthenticated' } : prev));
  }, []);

  const clearRedirectOutcome = useCallback(() => setRedirectOutcome(null), []);

  // Session subscription plus the 30-day check, on load and on every change.
  useEffect(() => {
    const unsubscribe = onAuthChange((next) => {
      if (next === null) {
        setState((prev) => endedState(prev, expiredRef.current ? 'expired' : 'unauthenticated'));
        return;
      }

      if (!isSessionActive(Date.now(), next.sessionStartedAtMs)) {
        // Requirement 2.13 — unauthenticated, plan view emptied, message shown.
        markExpired();
        void signOutEverywhere();
        return;
      }

      expiredRef.current = false;
      setState((prev) => ({ ...prev, session: next, status: 'authenticated' }));
    });

    return unsubscribe;
  }, [markExpired]);

  // A credential refusal from the Meal_Plan_API takes the same path as an
  // elapsed Session. `apiClient` has already discarded the Session by the time
  // the listener runs, so there is nothing to sign out of here.
  useEffect(() => onUnauthorized(markExpired), [markExpired]);

  // Reconciles a redirect-based provider sign-in. This provider is mounted on
  // every page, so it is the one place guaranteed to be present on the load
  // that returns from the Identity_Provider.
  useEffect(() => {
    let active = true;
    void completeRedirectSignIn()
      .then((outcome) => {
        if (active && outcome !== null) {
          setRedirectOutcome(outcome);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({
      session: state.session,
      status: state.status,
      expiredMessage: state.status === 'expired' ? SESSION_EXPIRED_MESSAGE : null,
      planViewEpoch: state.planViewEpoch,
      signOut,
      dismissExpiredMessage,
      redirectOutcome,
      clearRedirectOutcome,
    }),
    [state, signOut, dismissExpiredMessage, redirectOutcome, clearRedirectOutcome]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

// ─── Consumer hook ─────────────────────────────────────────────────────────────

/**
 * The Session state for the current render. Throws outside a `SessionProvider`
 * rather than reporting a plausible-looking unauthenticated visitor, because a
 * missing provider would otherwise read as "signed out" and quietly hide a
 * signed-in Patient's saved plans.
 */
export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === undefined) {
    throw new Error('useSession must be used within a SessionProvider.');
  }
  return value;
}
