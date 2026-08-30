/**
 * Browser authentication facade.
 *
 * Passwords are submitted over HTTPS for a single account operation, are never
 * persisted by the application, and are never included in browser storage.
 * Session tokens remain inaccessible to browser JavaScript in Secure, HttpOnly
 * cookies.
 */

import {
  evaluateThrottle,
  recordAttempt,
  SIGNIN_FAILURE_RULE,
  type ThrottleDecision,
} from './throttle';

export interface AuthSession {
  userId: string;
  displayName: string;
  email: string;
  emailVerified: boolean;
  authTimeMs: number;
  sessionStartedAtMs: number;
}

export type GoogleSignInOutcome =
  | { status: 'signed-in'; session: AuthSession }
  | { status: 'cancelled' }
  | { status: 'timed-out' }
  | { status: 'no-email' }
  | { status: 'failed'; code: string };

export type SocialProviderName =
  | 'Google'
  | 'Facebook'
  | 'LoginWithAmazon'
  | 'SignInWithApple';

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
  | 'invalid-code'
  | 'expired-code'
  | 'unverified-email'
  | 'password-reset-required'
  | 'not-configured'
  | 'unknown';

export type PasswordAuthStep =
  | 'done'
  | 'confirm-signup'
  | 'sign-in'
  | 'mfa'
  | 'reset-password';

export interface PasswordAuthResult {
  step: PasswordAuthStep;
  method?: 'authenticator' | 'sms';
}

export class AuthOperationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AuthOperationError';
  }
}

export class SignInThrottledError extends Error {
  readonly code = 'auth/too-many-requests';

  constructor(readonly retryAfterSeconds: number) {
    super(`Signin attempts are blocked for another ${retryAfterSeconds} seconds.`);
    this.name = 'SignInThrottledError';
  }
}

export const PROVIDER_TIMEOUT_MS = 120_000;
export const SESSION_STARTED_AT_KEY = 'crohnsBuddy.sessionStartedAtMs';
export const SIGNIN_FAILURES_KEY = 'crohnsBuddy.signinFailures';
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
export const DISPLAY_NAME_MAX_LENGTH = 50;

const DEFAULT_DISPLAY_NAME = 'Patient';
const AUTH_SESSION_EVENT = 'crohns-buddy:auth-session-changed';

export function isCognitoConfigured(): boolean {
  return process.env.NEXT_PUBLIC_AUTH_ENABLED === 'true';
}

export function getAuthErrorCode(error: unknown): string | null {
  if (error === null || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

export function classifyAuthError(error: unknown): AuthErrorKind {
  if (error instanceof SignInThrottledError) return 'too-many-requests';
  switch (getAuthErrorCode(error)) {
    case 'auth/email-already-in-use':
    case 'UsernameExistsException':
      return 'email-already-in-use';
    case 'auth/weak-password':
    case 'InvalidPasswordException':
      return 'weak-password';
    case 'auth/invalid-email':
    case 'InvalidParameterException':
      return 'invalid-email';
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
    case 'auth/invalid-login-credentials':
    case 'NotAuthorizedException':
    case 'UserNotFoundException':
      return 'invalid-credentials';
    case 'auth/too-many-requests':
    case 'TooManyRequestsException':
    case 'LimitExceededException':
      return 'too-many-requests';
    case 'auth/network-request-failed':
    case 'auth/timeout':
    case 'auth/internal-error':
      return 'unavailable';
    case 'auth/requires-recent-login':
      return 'requires-recent-login';
    case 'auth/invalid-code':
      return 'invalid-code';
    case 'auth/expired-code':
      return 'expired-code';
    case 'auth/unverified-email':
      return 'unverified-email';
    case 'auth/password-reset-required':
      return 'password-reset-required';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
    case 'auth/user-cancelled':
      return 'popup-cancelled';
    case 'auth/popup-blocked':
    case 'auth/operation-not-supported-in-this-environment':
      return 'popup-blocked';
    case 'auth/account-exists-with-different-credential':
      return 'account-exists-with-different-credential';
    case 'auth/not-configured':
    case 'auth/invalid-api-key':
      return 'not-configured';
    case 'auth/unavailable':
      return 'unavailable';
    default: {
      const message = error instanceof Error ? error.message.toLowerCase() : '';
      return message.includes('not configured') ? 'not-configured' : 'unknown';
    }
  }
}

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

export function writeSessionStartedAt(atMs: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SESSION_STARTED_AT_KEY, String(atMs));
  } catch {
    // The HttpOnly Cognito session remains valid when local storage is denied.
  }
}

export function clearSessionStartedAt(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(SESSION_STARTED_AT_KEY);
  } catch {
    // Nothing else is required.
  }
}

export function isSessionActive(
  nowMs: number = Date.now(),
  startedAtMs: number | null = readSessionStartedAt(),
): boolean {
  if (startedAtMs === null || !Number.isFinite(startedAtMs)) return false;
  return nowMs - startedAtMs < SESSION_MAX_AGE_MS;
}

function firstCodePoints(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join('');
}

export function deriveDisplayName(
  profileName: string | null | undefined,
  email: string | null | undefined,
): string {
  const trimmedName = (profileName ?? '').trim();
  if (trimmedName) return firstCodePoints(trimmedName, DISPLAY_NAME_MAX_LENGTH);
  const localPart = (email ?? '').trim().split('@')[0]?.trim() ?? '';
  return firstCodePoints(localPart || DEFAULT_DISPLAY_NAME, DISPLAY_NAME_MAX_LENGTH);
}

export interface SignInThrottleState {
  allowed: boolean;
  retryAfterSeconds: number;
  failureCount: number;
}

type FailureLedger = Record<string, number[]>;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fallbackHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a-${hash.toString(16).padStart(8, '0')}`;
}

export async function signInLedgerKey(email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return fallbackHash(normalized);
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
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(SIGNIN_FAILURES_KEY) ?? '{}',
    );
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const ledger: FailureLedger = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        ledger[key] = value.filter(
          (entry): entry is number => typeof entry === 'number' && Number.isFinite(entry),
        );
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
      Object.entries(ledger).filter(([, attempts]) => attempts.length > 0),
    );
    if (Object.keys(pruned).length === 0) {
      window.localStorage.removeItem(SIGNIN_FAILURES_KEY);
    } else {
      window.localStorage.setItem(SIGNIN_FAILURES_KEY, JSON.stringify(pruned));
    }
  } catch {
    // Cognito applies server-side rate limiting independently.
  }
}

function toThrottleState(decision: ThrottleDecision): SignInThrottleState {
  return {
    allowed: decision.allowed,
    retryAfterSeconds: decision.retryAfterSeconds,
    failureCount: decision.attempts.length,
  };
}

export async function getSignInThrottleState(
  email: string,
  nowMs: number = Date.now(),
): Promise<SignInThrottleState> {
  const key = await signInLedgerKey(email);
  const ledger = readFailureLedger();
  const decision = evaluateThrottle(ledger[key] ?? [], nowMs, SIGNIN_FAILURE_RULE);
  ledger[key] = decision.attempts;
  writeFailureLedger(ledger);
  return toThrottleState(decision);
}

export async function recordSignInFailure(
  email: string,
  nowMs: number = Date.now(),
): Promise<SignInThrottleState> {
  const key = await signInLedgerKey(email);
  const ledger = readFailureLedger();
  ledger[key] = recordAttempt(ledger[key] ?? [], nowMs, SIGNIN_FAILURE_RULE);
  writeFailureLedger(ledger);
  return toThrottleState(evaluateThrottle(ledger[key], nowMs, SIGNIN_FAILURE_RULE));
}

export async function resetSignInFailures(email: string): Promise<void> {
  const key = await signInLedgerKey(email);
  const ledger = readFailureLedger();
  delete ledger[key];
  writeFailureLedger(ledger);
}

export function authStartUrl(input: {
  intent?: 'signin' | 'signup';
  provider?: string;
  prompt?: 'login';
  returnTo?: string;
} = {}): string {
  const params = new URLSearchParams({
    intent: input.intent ?? 'signin',
    returnTo: input.returnTo ?? '/',
  });
  if (input.provider) params.set('provider', input.provider);
  if (input.prompt) params.set('prompt', input.prompt);
  return `/api/auth/start?${params.toString()}`;
}

function navigate(url: string): void {
  if (typeof window !== 'undefined') window.location.assign(url);
}

function accountErrorCode(value: unknown): string {
  switch (value) {
    case 'email-in-use':
      return 'auth/email-already-in-use';
    case 'weak-password':
      return 'auth/weak-password';
    case 'invalid-credentials':
      return 'auth/invalid-credential';
    case 'too-many-requests':
      return 'auth/too-many-requests';
    case 'invalid-code':
      return 'auth/invalid-code';
    case 'expired-code':
      return 'auth/expired-code';
    case 'unverified-email':
      return 'auth/unverified-email';
    case 'password-reset-required':
      return 'auth/password-reset-required';
    case 'invalid-input':
      return 'auth/invalid-email';
    case 'unavailable':
      return 'auth/unavailable';
    default:
      return 'auth/unknown';
  }
}

async function passwordAuthRequest(
  body: Record<string, unknown>,
): Promise<PasswordAuthResult> {
  if (!isCognitoConfigured()) {
    throw new AuthOperationError(
      'auth/not-configured',
      'Account features are not configured.',
    );
  }
  let response: Response;
  try {
    response = await fetch('/api/auth/password', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AuthOperationError('auth/unavailable', 'Account service unavailable.');
  }
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code =
      value !== null &&
      typeof value === 'object' &&
      typeof (value as { code?: unknown }).code === 'string'
        ? (value as { code: string }).code
        : 'unavailable';
    throw new AuthOperationError(accountErrorCode(code), 'Account request failed.');
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (value as { step?: unknown }).step !== 'string'
  ) {
    throw new AuthOperationError('auth/unavailable', 'Account request failed.');
  }
  return value as PasswordAuthResult;
}

export async function signUp(
  email = '',
  password = '',
  displayName = '',
): Promise<PasswordAuthResult> {
  return passwordAuthRequest({
    action: 'signup',
    email,
    password,
    displayName,
  });
}

export async function confirmSignUp(
  email: string,
  code: string,
): Promise<PasswordAuthResult> {
  return passwordAuthRequest({ action: 'confirm-signup', email, code });
}

export async function resendSignUpCode(email: string): Promise<PasswordAuthResult> {
  return passwordAuthRequest({ action: 'resend-signup', email });
}

export async function signIn(
  email = '',
  password = '',
): Promise<PasswordAuthResult> {
  const throttle = await getSignInThrottleState(email);
  if (!throttle.allowed) throw new SignInThrottledError(throttle.retryAfterSeconds);
  try {
    const result = await passwordAuthRequest({
      action: 'signin',
      email,
      password,
    });
    if (result.step === 'done') {
      await resetSignInFailures(email);
      emitSessionChanged();
    }
    return result;
  } catch (error: unknown) {
    if (classifyAuthError(error) === 'invalid-credentials') {
      await recordSignInFailure(email);
    }
    throw error;
  }
}

export async function confirmSignInMfa(code: string): Promise<PasswordAuthResult> {
  const result = await passwordAuthRequest({ action: 'mfa', code });
  if (result.step === 'done') emitSessionChanged();
  return result;
}

export async function requestPasswordReset(
  email = '',
): Promise<PasswordAuthResult> {
  return passwordAuthRequest({ action: 'forgot-password', email });
}

export async function confirmPasswordReset(
  email: string,
  code: string,
  password: string,
): Promise<PasswordAuthResult> {
  return passwordAuthRequest({
    action: 'reset-password',
    email,
    code,
    password,
  });
}

export async function sendVerificationEmail(): Promise<void> {
  const response = await fetch('/api/auth/verification', {
    method: 'POST',
    credentials: 'same-origin',
  });
  if (response.status === 429) {
    throw new AuthOperationError('auth/too-many-requests', 'Rate limited.');
  }
  if (!response.ok) {
    throw new AuthOperationError('auth/unavailable', 'Verification failed.');
  }
}

export async function reauthenticate(_password?: string): Promise<never> {
  if (!isCognitoConfigured()) {
    throw new AuthOperationError(
      'auth/not-configured',
      'Account features are not configured.',
    );
  }
  const returnTo =
    typeof window === 'undefined'
      ? '/'
      : `${window.location.pathname}${window.location.search}${window.location.hash}`;
  navigate(authStartUrl({ intent: 'signin', prompt: 'login', returnTo }));
  return new Promise<never>(() => undefined);
}

export async function deleteCurrentAccount(): Promise<void> {
  const response = await fetch('/api/auth/account', {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  if (response.status === 401 || response.status === 403) {
    throw new AuthOperationError('auth/requires-recent-login', 'Sign in again.');
  }
  if (!response.ok) {
    throw new AuthOperationError('auth/unavailable', 'Account deletion failed.');
  }
  clearSessionStartedAt();
  emitSessionChanged();
}

export async function getIdTokenForRequest(): Promise<string | null> {
  // Tokens are HttpOnly by design and are never exposed to browser JavaScript.
  return null;
}

export async function signInWithProvider(
  provider: SocialProviderName,
): Promise<GoogleSignInOutcome> {
  if (!isCognitoConfigured()) {
    return { status: 'failed', code: 'auth/not-configured' };
  }
  navigate(authStartUrl({ intent: 'signin', provider }));
  return { status: 'cancelled' };
}

export async function signInWithGoogle(): Promise<GoogleSignInOutcome> {
  return signInWithProvider('Google');
}

export async function completeRedirectSignIn(): Promise<GoogleSignInOutcome | null> {
  return null;
}

function emitSessionChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(AUTH_SESSION_EVENT));
  }
}

export async function fetchAuthSession(): Promise<AuthSession | null> {
  if (!isCognitoConfigured()) return null;
  const response = await fetch('/api/auth/session', {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (response.status === 401) {
    clearSessionStartedAt();
    return null;
  }
  if (!response.ok) {
    throw new AuthOperationError('auth/unavailable', 'Session lookup failed.');
  }
  const body: unknown = await response.json();
  if (
    body === null ||
    typeof body !== 'object' ||
    (body as { authenticated?: unknown }).authenticated !== true
  ) {
    return null;
  }
  const session = (body as { session?: AuthSession }).session;
  if (!session) return null;
  writeSessionStartedAt(session.sessionStartedAtMs);
  return session;
}

export function onAuthChange(
  callback: (session: AuthSession | null) => void,
): () => void {
  if (!isCognitoConfigured()) {
    callback(null);
    return () => undefined;
  }

  let active = true;
  const refresh = () => {
    void fetchAuthSession()
      .then((session) => {
        if (active) callback(session);
      })
      .catch(() => {
        // A temporary Cognito outage must not be misreported as sign-out.
      });
  };

  refresh();
  window.addEventListener(AUTH_SESSION_EVENT, refresh);
  window.addEventListener('focus', refresh);
  return () => {
    active = false;
    window.removeEventListener(AUTH_SESSION_EVENT, refresh);
    window.removeEventListener('focus', refresh);
  };
}

export async function signOutEverywhere(): Promise<void> {
  clearSessionStartedAt();
  emitSessionChanged();
  try {
    const response = await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
    });
    const body: unknown = await response.json().catch(() => null);
    const logoutUrl =
      body !== null &&
      typeof body === 'object' &&
      typeof (body as { logoutUrl?: unknown }).logoutUrl === 'string'
        ? (body as { logoutUrl: string }).logoutUrl
        : null;
    if (logoutUrl) navigate(logoutUrl);
  } catch {
    // The local Session is already gone.
  }
}

export async function signOut(): Promise<void> {
  await signOutEverywhere();
}

export type User = AuthSession;
