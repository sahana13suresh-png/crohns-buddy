/**
 * The single Auth_Service module for Crohn's Buddy.
 *
 * Every interaction with Firebase Authentication goes through here: email and
 * password signup and signin, Google as an Identity_Provider, email
 * verification, password reset, re-authentication, and account removal. The
 * FirebaseApp and its configuration live in `firebaseClient.ts`.
 *
 * Two conventions are load-bearing:
 *
 * - Google sign-in returns a `GoogleSignInOutcome` discriminated union instead
 *   of throwing, because Requirements 3.6, 3.7, 3.8, and 3.9 each prescribe a
 *   different Auth_UI outcome and a thrown error cannot separate them reliably.
 * - Errors are classified by `err.code` on `FirebaseError`, never by
 *   substring-matching `err.message`.
 */

import { FirebaseError } from 'firebase/app';
import {
  getAuth,
  Auth,
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  deleteUser,
  EmailAuthProvider,
  getAdditionalUserInfo,
  getRedirectResult,
  GoogleAuthProvider,
  onAuthStateChanged,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  sendEmailVerification,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut as firebaseSignOut,
  updateProfile,
  UserCredential,
  User,
  Unsubscribe,
} from 'firebase/auth';
import { getFirebaseApp, isFirebaseConfigured } from './firebaseClient';
import { evaluateThrottle, recordAttempt, SIGNIN_FAILURE_RULE, ThrottleDecision } from './throttle';

// ─── Types ─────────────────────────────────────────────────────────────────────

/** The Website's view of an active Session. */
export interface AuthSession {
  /** Firebase uid — the User_Id. */
  userId: string;
  displayName: string;
  email: string;
  emailVerified: boolean;
  /** Most recent successful authentication, in epoch milliseconds. */
  authTimeMs: number;
  /**
   * When the current Session began, in epoch milliseconds. Firebase refresh
   * tokens do not expire on their own, so the 30-day bound in Requirement 2.7
   * is enforced by the application against this value.
   */
  sessionStartedAtMs: number;
}

/**
 * The result of a Google sign-in attempt. Each variant maps to exactly one
 * Auth_UI behavior: `cancelled` shows no message (3.6), `failed` shows a
 * provider-failure message (3.7), `no-email` shows the email-required message
 * (3.8), and `timed-out` shows the retryable timeout message (3.9).
 */
export type GoogleSignInOutcome =
  | { status: 'signed-in'; session: AuthSession }
  | { status: 'cancelled' }
  | { status: 'timed-out' }
  | { status: 'no-email' }
  | { status: 'failed'; code: string };

/**
 * The Auth_Service failure categories the Auth_UI distinguishes. Mapping
 * happens here so the UI never inspects Firebase error codes itself.
 */
/**
 * Thrown by `signIn` while the signin failure ledger blocks further attempts
 * (Requirement 2.3). It carries the countdown the Auth_UI displays, which is
 * why the throttle gate cannot be expressed as a Firebase error code: Firebase's
 * own `auth/too-many-requests` exposes no remaining time.
 */
export class SignInThrottledError extends Error {
  readonly code = 'auth/too-many-requests';

  constructor(readonly retryAfterSeconds: number) {
    super(`Signin attempts are blocked for another ${retryAfterSeconds} seconds.`);
    this.name = 'SignInThrottledError';
  }
}

export type AuthErrorKind =
  | 'email-already-in-use'
  | 'weak-password'
  | 'invalid-email'
  | 'invalid-credentials'
  | 'too-many-requests'
  | 'unavailable'
  | 'popup-cancelled'
  | 'popup-blocked'
  | 'account-exists-with-different-credential'
  | 'requires-recent-login'
  | 'not-configured'
  | 'unknown';

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Requirement 3.9 — the Identity_Provider timeout, enforced here, not in the UI. */
export const PROVIDER_TIMEOUT_MS = 120_000;

/**
 * localStorage key holding `sessionStartedAtMs`. Exported so the session-age
 * helpers read and write the same key this module writes on authentication.
 */
export const SESSION_STARTED_AT_KEY = 'crohnsBuddy.sessionStartedAtMs';

/**
 * localStorage key holding the signin failure ledger: a map from a hash of the
 * email address to that address's recent failure timestamps.
 */
export const SIGNIN_FAILURES_KEY = 'crohnsBuddy.signinFailures';

/** Requirement 2.7 — a Session stays valid for 30 days from authentication. */
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Requirements 1.1, 3.3, and 3.5 — display names cap at 50 characters. */
export const DISPLAY_NAME_MAX_LENGTH = 50;

/**
 * Used only when neither a profile name nor an email local part supplies a
 * single character. An email address that reaches this module has already
 * passed the format check in Requirement 1.2 (non-empty local part) or came
 * from an Identity_Provider response that Requirement 3.8 requires to carry an
 * address, so this is a guard against an empty display name rather than an
 * expected path.
 */
const DEFAULT_DISPLAY_NAME = 'Patient';

const NOT_CONFIGURED_CODE = 'auth/not-configured';

// ─── Initialization ────────────────────────────────────────────────────────────

let auth: Auth | undefined;
let persistenceReady: Promise<unknown> | undefined;

export function getFirebaseAuth(): Auth {
  if (!auth) {
    if (!isFirebaseConfigured()) {
      throw new Error('Firebase is not configured. Please add your Firebase credentials to .env.local');
    }
    auth = getAuth(getFirebaseApp());
    if (typeof window !== 'undefined') {
      // browserLocalPersistence keeps the Session across reloads (Req 2.5).
      // A rejection here is not fatal: Firebase falls back to in-memory
      // persistence and the Session simply lasts for the tab.
      persistenceReady = setPersistence(auth, browserLocalPersistence).catch(() => undefined);
    }
  }
  return auth;
}

/** `getFirebaseAuth()` with the persistence mode settled before any sign-in. */
async function authWithLocalPersistence(): Promise<Auth> {
  const instance = getFirebaseAuth();
  if (persistenceReady) {
    await persistenceReady;
  }
  return instance;
}

function buildGoogleProvider(): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  provider.addScope('email');
  return provider;
}

// ─── Error classification ──────────────────────────────────────────────────────

/** The `auth/...` code of a Firebase error, or null for anything else. */
export function getAuthErrorCode(err: unknown): string | null {
  if (err instanceof FirebaseError) {
    return err.code;
  }
  return null;
}

/**
 * Maps a thrown Auth_Service error onto the category the Auth_UI acts on.
 * Note the deliberate collapse of `invalid-credential`, `wrong-password`, and
 * `user-not-found` onto one category: Requirement 2.2 forbids revealing which
 * value was wrong or whether the address is registered.
 */
export function classifyAuthError(err: unknown): AuthErrorKind {
  if (err instanceof SignInThrottledError) {
    return 'too-many-requests';
  }
  const code = getAuthErrorCode(err);
  switch (code) {
    case 'auth/email-already-in-use':
      return 'email-already-in-use';
    case 'auth/weak-password':
      return 'weak-password';
    case 'auth/invalid-email':
      return 'invalid-email';
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
    case 'auth/invalid-login-credentials':
      return 'invalid-credentials';
    case 'auth/too-many-requests':
      return 'too-many-requests';
    case 'auth/network-request-failed':
    case 'auth/timeout':
    case 'auth/internal-error':
      return 'unavailable';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
    case 'auth/user-cancelled':
      return 'popup-cancelled';
    case 'auth/popup-blocked':
    case 'auth/operation-not-supported-in-this-environment':
      return 'popup-blocked';
    case 'auth/account-exists-with-different-credential':
      return 'account-exists-with-different-credential';
    case 'auth/requires-recent-login':
      return 'requires-recent-login';
    case NOT_CONFIGURED_CODE:
    case 'auth/invalid-api-key':
      return 'not-configured';
    default:
      if (code === null && err instanceof Error && err.message.includes('not configured')) {
        return 'not-configured';
      }
      return 'unknown';
  }
}

// ─── Session bookkeeping ───────────────────────────────────────────────────────

/** The stored `sessionStartedAtMs`, or null when none is stored or readable. */
export function readSessionStartedAt(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(SESSION_STARTED_AT_KEY);
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Records when the current Session began. */
export function writeSessionStartedAt(atMs: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SESSION_STARTED_AT_KEY, String(atMs));
  } catch {
    // Storage denied (private browsing). The Session still works for this tab.
  }
}

/** Forgets the Session start, so a later load reports no Session age. */
export function clearSessionStartedAt(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(SESSION_STARTED_AT_KEY);
  } catch {
    // Nothing to do.
  }
}

/**
 * Whether a Session that began at `startedAtMs` is still active at `nowMs`:
 * active exactly while the elapsed time is under 30 days (Requirements 2.5,
 * 2.7, 2.13). With `startedAtMs` omitted the stored value is used, and an
 * absent stored value reports inactive — there is no Session to restore.
 *
 * This is session hygiene, not a security boundary: clearing localStorage
 * resets the clock. The enforced boundary is the one-hour ID token lifetime
 * checked server-side.
 */
export function isSessionActive(
  nowMs: number = Date.now(),
  startedAtMs: number | null = readSessionStartedAt()
): boolean {
  if (startedAtMs === null || !Number.isFinite(startedAtMs)) return false;
  return nowMs - startedAtMs < SESSION_MAX_AGE_MS;
}

/**
 * Truncates to `limit` code points, so a surrogate pair is never split and an
 * astral-plane character is never counted twice. Same unit as the server-side
 * derivation in `joseAuthTokenVerifier`, and the same reading the design applies
 * to the 100-character title in Open Technical Decision 2.
 */
function firstCodePoints(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join('');
}

/**
 * The Account display name for a profile name and an email address: the first
 * 50 characters of the trimmed profile name when that trimmed value holds at
 * least one character, otherwise the first 50 characters of the email local
 * part (Requirements 3.3 and 3.5). The result is never empty and never longer
 * than 50 characters, counted in Unicode code points.
 */
export function deriveDisplayName(
  profileName: string | null | undefined,
  email: string | null | undefined
): string {
  const trimmedName = (profileName ?? '').trim();
  if (trimmedName.length > 0) {
    return firstCodePoints(trimmedName, DISPLAY_NAME_MAX_LENGTH);
  }

  const localPart = (email ?? '').trim().split('@')[0]?.trim() ?? '';
  if (localPart.length > 0) {
    return firstCodePoints(localPart, DISPLAY_NAME_MAX_LENGTH);
  }

  return DEFAULT_DISPLAY_NAME;
}

/**
 * Requirement 2.7 measures the 30 days from the most recent successful
 * authentication, so every successful authentication restarts the clock.
 */
function markAuthenticated(atMs: number = Date.now()): void {
  writeSessionStartedAt(atMs);
}

// ─── Signin failure ledger (Requirement 2.3) ───────────────────────────────────

/**
 * The ledger records failure timestamps per email address so the Auth_UI can
 * show the countdown Requirement 2.3 asks for; Firebase's own rate limiting is
 * real but exposes no remaining time. Two limitations are worth stating rather
 * than hiding: the ledger is per browser, and clearing storage discards it. It
 * is a UX affordance, not a security control — the server-side protection is
 * Firebase Authentication's built-in rate limiting.
 *
 * Entries are keyed by a SHA-256 hash of the lowercased address, so the stored
 * data never contains an email address.
 */
export interface SignInThrottleState {
  /** True when the next signin attempt may reach the Auth_Service. */
  allowed: boolean;
  /** Whole seconds until an attempt is accepted; 0 while allowed. */
  retryAfterSeconds: number;
  /** Recorded consecutive failures still inside the 5-minute window. */
  failureCount: number;
}

type FailureLedger = Record<string, number[]>;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * FNV-1a, used only where Web Crypto is unavailable (an insecure context, so
 * neither Firebase nor this ledger is running in a supported configuration).
 * It is a weaker hash, but it still never stores the address itself, which is
 * the property that matters here.
 */
function fallbackHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a-${hash.toString(16).padStart(8, '0')}`;
}

/** The ledger key for an email address: a hash, never the address. */
export async function signInLedgerKey(email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    return fallbackHash(normalized);
  }
  try {
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(normalized));
    return toHex(new Uint8Array(digest));
  } catch {
    return fallbackHash(normalized);
  }
}

function readFailureLedger(): FailureLedger {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(SIGNIN_FAILURES_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const ledger: FailureLedger = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        ledger[key] = value.filter((at): at is number => typeof at === 'number' && Number.isFinite(at));
      }
    }
    return ledger;
  } catch {
    return {};
  }
}

function writeFailureLedger(ledger: FailureLedger): void {
  if (typeof window === 'undefined') return;
  try {
    const pruned = Object.fromEntries(
      Object.entries(ledger).filter(([, attempts]) => attempts.length > 0)
    );
    if (Object.keys(pruned).length === 0) {
      window.localStorage.removeItem(SIGNIN_FAILURES_KEY);
      return;
    }
    window.localStorage.setItem(SIGNIN_FAILURES_KEY, JSON.stringify(pruned));
  } catch {
    // Storage denied. The gate then admits every attempt, which is the safe
    // direction: Firebase's own rate limiting still applies.
  }
}

function toThrottleState(decision: ThrottleDecision): SignInThrottleState {
  return {
    allowed: decision.allowed,
    retryAfterSeconds: decision.retryAfterSeconds,
    failureCount: decision.attempts.length,
  };
}

/**
 * Whether a signin attempt for `email` is admitted at `nowMs`. Reading also
 * persists the pruned ledger, so aged-out failures and a discharged cooldown do
 * not linger in storage.
 */
export async function getSignInThrottleState(
  email: string,
  nowMs: number = Date.now()
): Promise<SignInThrottleState> {
  const key = await signInLedgerKey(email);
  const ledger = readFailureLedger();
  const decision = evaluateThrottle(ledger[key] ?? [], nowMs, SIGNIN_FAILURE_RULE);
  ledger[key] = decision.attempts;
  writeFailureLedger(ledger);
  return toThrottleState(decision);
}

/**
 * Records one credential rejection for `email`. Only credential rejections
 * reach here: Requirement 2.11 excludes client-side validation failures and
 * Requirement 2.12 excludes transport failures, so `signIn` records a failure
 * only for the `invalid-credentials` category.
 */
export async function recordSignInFailure(
  email: string,
  nowMs: number = Date.now()
): Promise<SignInThrottleState> {
  const key = await signInLedgerKey(email);
  const ledger = readFailureLedger();
  ledger[key] = recordAttempt(ledger[key] ?? [], nowMs, SIGNIN_FAILURE_RULE);
  writeFailureLedger(ledger);
  return toThrottleState(evaluateThrottle(ledger[key], nowMs, SIGNIN_FAILURE_RULE));
}

/** Requirement 2.1 — a successful signin resets the failure count to zero. */
export async function resetSignInFailures(email: string): Promise<void> {
  const key = await signInLedgerKey(email);
  const ledger = readFailureLedger();
  if (!(key in ledger)) return;
  delete ledger[key];
  writeFailureLedger(ledger);
}

/**
 * The Session start for a restored Session: the stored value when one exists,
 * otherwise the token's `auth_time`, so a Session restored in a browser with no
 * stored marker is not treated as brand new.
 */
function resolveSessionStart(authTimeMs: number): number {
  const stored = readSessionStartedAt();
  if (stored !== null) return stored;
  writeSessionStartedAt(authTimeMs);
  return authTimeMs;
}

async function readAuthTimeMs(user: User): Promise<number> {
  try {
    const result = await user.getIdTokenResult();
    const parsed = Date.parse(result.authTime);
    if (Number.isFinite(parsed)) return parsed;
  } catch {
    // Fall through to the wall clock below.
  }
  return Date.now();
}

async function toAuthSession(user: User): Promise<AuthSession> {
  const authTimeMs = await readAuthTimeMs(user);
  return {
    userId: user.uid,
    displayName: deriveDisplayName(user.displayName, user.email),
    email: user.email ?? '',
    emailVerified: user.emailVerified,
    authTimeMs,
    sessionStartedAtMs: resolveSessionStart(authTimeMs),
  };
}

// ─── Email and password ────────────────────────────────────────────────────────

export async function signUp(email: string, password: string, displayName: string): Promise<User> {
  const instance = await authWithLocalPersistence();
  const userCredential = await createUserWithEmailAndPassword(instance, email, password);
  await updateProfile(userCredential.user, { displayName });
  markAuthenticated();
  // Requirement 1.6 — verification message on Account creation. A failure here
  // must not report the Account as uncreated, since it exists; the Auth_UI
  // offers a resend control instead (1.7).
  try {
    await sendEmailVerification(userCredential.user);
  } catch {
    // Resend remains available from the verification banner.
  }
  return userCredential.user;
}

/**
 * Signs in with email and password, gated by the signin failure ledger: while
 * the ledger blocks the address, no request reaches the Auth_Service and a
 * `SignInThrottledError` carries the countdown (Requirement 2.3). A success
 * resets the failure count (2.1); only a credential rejection increments it,
 * leaving validation failures (2.11) and transport failures (2.12) uncounted.
 */
export async function signIn(email: string, password: string): Promise<User> {
  const throttle = await getSignInThrottleState(email);
  if (!throttle.allowed) {
    throw new SignInThrottledError(throttle.retryAfterSeconds);
  }

  const instance = await authWithLocalPersistence();
  let userCredential: UserCredential;
  try {
    userCredential = await signInWithEmailAndPassword(instance, email, password);
  } catch (err) {
    if (classifyAuthError(err) === 'invalid-credentials') {
      await recordSignInFailure(email);
    }
    throw err;
  }

  markAuthenticated();
  await resetSignInFailures(email);
  return userCredential.user;
}

/**
 * Ends the Session. The locally held Session is discarded first so it is gone
 * even when the Auth_Service returns no response (Requirement 2.8).
 */
export async function signOutEverywhere(): Promise<void> {
  clearSessionStartedAt();
  try {
    await firebaseSignOut(getFirebaseAuth());
  } catch {
    // The local Session is already discarded, which is what 2.8 requires.
  }
}

/** Retained name for `signOutEverywhere` so existing callers are unaffected. */
export async function signOut(): Promise<void> {
  await signOutEverywhere();
}

/** Requirements 1.6 and 1.7 — send or resend the verification message. */
export async function sendVerificationEmail(): Promise<void> {
  const user = getFirebaseAuth().currentUser;
  if (!user) {
    throw new Error('No active session to send a verification email for.');
  }
  await sendEmailVerification(user);
}

/**
 * Requirements 2.9 and 2.10 — a registered and an unregistered address produce
 * the identical outcome, so `user-not-found` is swallowed rather than surfaced.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  try {
    await sendPasswordResetEmail(getFirebaseAuth(), email);
  } catch (err) {
    if (getAuthErrorCode(err) === 'auth/user-not-found') {
      return;
    }
    throw err;
  }
}

/**
 * Requirement 11.5 — re-authentication before a destructive account operation.
 * Password accounts need the password; a Google-only account re-authenticates
 * through the provider.
 */
export async function reauthenticate(password?: string): Promise<void> {
  const instance = await authWithLocalPersistence();
  const user = instance.currentUser;
  if (!user) {
    throw new Error('No active session to re-authenticate.');
  }

  const providerIds = user.providerData.map((profile) => profile.providerId);
  if (password !== undefined && user.email) {
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
  } else if (providerIds.includes(GoogleAuthProvider.PROVIDER_ID)) {
    await reauthenticateWithPopup(user, buildGoogleProvider());
  } else {
    throw new Error('Re-authentication requires the account password.');
  }
  markAuthenticated();
}

/**
 * Removes the Account from the Auth_Service. `auth/requires-recent-login`
 * propagates as a `FirebaseError` so the deletion flow can gate on it (11.5).
 */
export async function deleteCurrentAccount(): Promise<void> {
  const user = getFirebaseAuth().currentUser;
  if (!user) {
    throw new Error('No active session to delete.');
  }
  await deleteUser(user);
  clearSessionStartedAt();
}

/** The Auth_Token for a Meal_Plan_API request, or null with no Session. */
export async function getIdTokenForRequest(): Promise<string | null> {
  if (!isFirebaseConfigured()) return null;
  const user = getFirebaseAuth().currentUser;
  if (!user) return null;
  try {
    return await user.getIdToken();
  } catch {
    return null;
  }
}

// ─── Google as an Identity_Provider ────────────────────────────────────────────

const PROVIDER_TIMED_OUT = Symbol('provider-timed-out');

/**
 * Races the provider promise against the 120-second bound in Requirement 3.9.
 * The abandoned promise's later rejection is swallowed so it never surfaces as
 * an unhandled rejection after the timeout has already been reported.
 */
async function withProviderTimeout(
  attempt: Promise<UserCredential>
): Promise<UserCredential | typeof PROVIDER_TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof PROVIDER_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(PROVIDER_TIMED_OUT), PROVIDER_TIMEOUT_MS);
  });

  try {
    const settled = await Promise.race([attempt, timeout]);
    if (settled === PROVIDER_TIMED_OUT) {
      attempt.catch(() => undefined);
    }
    return settled;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Requirement 3.8 — no Account and no Session when the Identity_Provider
 * returns no email address. A just-created Account is removed; an existing one
 * is left alone and only the Session is discarded.
 */
async function rejectEmaillessCredential(credential: UserCredential): Promise<void> {
  const isNewUser = getAdditionalUserInfo(credential)?.isNewUser === true;
  if (isNewUser) {
    try {
      await deleteUser(credential.user);
      clearSessionStartedAt();
      return;
    } catch {
      // Fall through to signing out.
    }
  }
  await signOutEverywhere();
}

async function outcomeForCredential(credential: UserCredential): Promise<GoogleSignInOutcome> {
  const email = credential.user.email ?? '';
  if (email.trim().length === 0) {
    await rejectEmaillessCredential(credential);
    return { status: 'no-email' };
  }
  markAuthenticated();
  return { status: 'signed-in', session: await toAuthSession(credential.user) };
}

function outcomeForProviderError(err: unknown): GoogleSignInOutcome {
  const kind = classifyAuthError(err);
  if (kind === 'popup-cancelled') {
    return { status: 'cancelled' };
  }
  return { status: 'failed', code: getAuthErrorCode(err) ?? 'auth/unknown' };
}

/**
 * Authenticates with Google. Popup first, because it keeps the account modal
 * and its retained field values mounted and rejects distinguishably on
 * cancellation (Decision 1). A blocked or unsupported popup falls back to a
 * redirect, reconciled on the next mount by `completeRedirectSignIn()`.
 */
export async function signInWithGoogle(): Promise<GoogleSignInOutcome> {
  let instance: Auth;
  try {
    instance = await authWithLocalPersistence();
  } catch {
    return { status: 'failed', code: NOT_CONFIGURED_CODE };
  }

  try {
    const settled = await withProviderTimeout(signInWithPopup(instance, buildGoogleProvider()));
    if (settled === PROVIDER_TIMED_OUT) {
      return { status: 'timed-out' };
    }
    return await outcomeForCredential(settled);
  } catch (err) {
    if (classifyAuthError(err) === 'popup-blocked') {
      return await startRedirectSignIn(instance);
    }
    return outcomeForProviderError(err);
  }
}

async function startRedirectSignIn(instance: Auth): Promise<GoogleSignInOutcome> {
  try {
    await signInWithRedirect(instance, buildGoogleProvider());
    // The page normally unloads before this resolves. If it does resolve, the
    // attempt is still in flight, so report the outcome that shows no message
    // and let `completeRedirectSignIn()` deliver the real result on mount.
    return { status: 'cancelled' };
  } catch (err) {
    return outcomeForProviderError(err);
  }
}

/**
 * Reconciles a redirect-based provider sign-in. Call once on mount. Returns
 * null when the load is not a return from the Identity_Provider.
 */
export async function completeRedirectSignIn(): Promise<GoogleSignInOutcome | null> {
  if (!isFirebaseConfigured()) return null;
  try {
    const credential = await getRedirectResult(await authWithLocalPersistence());
    if (!credential) return null;
    return await outcomeForCredential(credential);
  } catch (err) {
    return outcomeForProviderError(err);
  }
}

// ─── Session subscription ──────────────────────────────────────────────────────

/**
 * Subscribes to Session changes. Emits `null` when no Session is active, so an
 * unconfigured Firebase project reports an unauthenticated visitor rather than
 * throwing (Requirement 2.6).
 */
export function onAuthChange(callback: (session: AuthSession | null) => void): Unsubscribe {
  if (!isFirebaseConfigured()) {
    callback(null);
    return () => {};
  }

  // Session construction is async (the token's auth_time), so a generation
  // counter drops results from a superseded auth state.
  let generation = 0;

  return onAuthStateChanged(getFirebaseAuth(), (user) => {
    const current = ++generation;
    if (!user) {
      clearSessionStartedAt();
      callback(null);
      return;
    }
    void toAuthSession(user).then((session) => {
      if (current === generation) {
        callback(session);
      }
    });
  });
}

export type { User };
