'use client';

/**
 * The header account controls, mounted once in the root layout so they appear
 * on every page of the Website.
 *
 * - **Requirement 2.4** — while a Session is active, the header carries the
 *   display name of the signed-in Account and a signout control.
 * - **Requirement 2.6** — with no Session the header carries the signin and
 *   signup controls instead, and the visitor is treated as unauthenticated.
 * - **Requirement 2.8** — activating signout ends the Session and returns the
 *   header to the signin and signup controls. The plan view is emptied by
 *   `SessionProvider.signOut`, which drops the Session locally before the
 *   Auth_Service is asked for anything, so this holds even with no response.
 * - **Requirement 2.13** — when a Session ended on its own, the expiry message
 *   is shown beside those controls. `SessionProvider` owns that state; this
 *   component is where the controls live, so it is where the message renders.
 *
 * Session state is read from `useSession()` rather than from a second
 * `onAuthChange` subscription, so the header and every other consumer cannot
 * disagree about whether a Session is active.
 *
 * While `status` is `loading` no auth controls render at all. Showing the signin
 * controls for the moment before the Auth_Service reports its first state would
 * flash "Log In" at a Patient who is already signed in, and Requirement 2.5
 * asks for the signed-in header on a reload without a credential prompt.
 */

import { useEffect, useState } from 'react';
import AuthModal from '@/components/AuthModal';
import { messageForProviderOutcome } from '@/components/auth/GoogleSignInButton';
import { useSession } from '@/components/auth/SessionProvider';
import {
  isCognitoConfigured,
  isSelfRegistrationEnabled,
} from '@/lib/auth';

type AuthModalMode = 'login' | 'signup';

const CONTROL_CLASS =
  'text-xs uppercase tracking-widest text-brand-800/60 hover:text-brand-800 transition-opacity duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 rounded-sm';

export default function AccountMenu() {
  const authConfigured = isCognitoConfigured();
  const selfRegistrationEnabled = isSelfRegistrationEnabled();
  const {
    session,
    status,
    expiredMessage,
    signOut,
    dismissExpiredMessage,
    redirectOutcome,
    clearRedirectOutcome,
  } = useSession();
  const [modalMode, setModalMode] = useState<AuthModalMode | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  const openModal = (mode: AuthModalMode) => {
    // The Patient is acting on the expiry notice, so it has served its purpose.
    dismissExpiredMessage();
    setModalMode(mode);
  };

  // A redirect-based provider attempt returns to a page with the modal closed,
  // so an outcome that has something to say (Requirements 3.7, 3.8, 3.9) reopens
  // it — otherwise the message would have nowhere to render and the outcome
  // would never be acknowledged. A cancellation and a success both say nothing,
  // and neither reopens anything.
  useEffect(() => {
    if (redirectOutcome === null) return;
    if (messageForProviderOutcome(redirectOutcome) === null) {
      clearRedirectOutcome();
      return;
    }
    setModalMode((current) => current ?? 'login');
  }, [redirectOutcome, clearRedirectOutcome]);

  const handleSignOut = async () => {
    // Guards against a second activation while the first is in flight; the
    // Session is already gone locally by the time this resolves (2.8).
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <div className="border-b border-brand-800/10">
      <nav
        aria-label="Account"
        className="max-w-7xl mx-auto px-6 md:px-12 py-3 flex items-center justify-end gap-4 min-h-[2.75rem]"
      >
        {expiredMessage && (
          <p role="status" className="text-xs text-brand-800/60 mr-auto">
            {expiredMessage}
          </p>
        )}

        {status === 'authenticated' && session && (
          <>
            <span className="text-xs uppercase tracking-widest text-brand-800/60 hidden sm:inline">
              {session.displayName || session.email}
            </span>
            <button type="button" onClick={handleSignOut} disabled={signingOut} className={CONTROL_CLASS}>
              {signingOut ? 'Logging out…' : 'Log Out'}
            </button>
          </>
        )}

        {(status === 'unauthenticated' || status === 'expired') && authConfigured && (
          <button type="button" onClick={() => openModal('login')} className={CONTROL_CLASS}>
            Log In / Sign Up
          </button>
        )}

        {(status === 'unauthenticated' || status === 'expired') && !authConfigured && (
          <span className="text-xs text-brand-800/60">
            Account features are not configured.
          </span>
        )}
      </nav>

      {authConfigured && modalMode && (
        <AuthModal
          mode={modalMode}
          onClose={() => setModalMode(null)}
          onSuccess={() => setModalMode(null)}
          onSwitchMode={() => setModalMode(modalMode === 'login' ? 'signup' : 'login')}
          allowSignup={selfRegistrationEnabled}
          redirectOutcome={redirectOutcome}
          onRedirectOutcomeHandled={clearRedirectOutcome}
        />
      )}
    </div>
  );
}
