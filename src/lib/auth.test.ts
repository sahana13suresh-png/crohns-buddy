import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FirebaseError } from 'firebase/app';
import {
  AuthErrorKind,
  classifyAuthError,
  clearSessionStartedAt,
  deriveDisplayName,
  DISPLAY_NAME_MAX_LENGTH,
  getAuthErrorCode,
  getIdTokenForRequest,
  getSignInThrottleState,
  isSessionActive,
  onAuthChange,
  PROVIDER_TIMEOUT_MS,
  readSessionStartedAt,
  recordSignInFailure,
  resetSignInFailures,
  SESSION_MAX_AGE_MS,
  SESSION_STARTED_AT_KEY,
  SIGNIN_FAILURES_KEY,
  SignInThrottledError,
  writeSessionStartedAt,
} from './auth';

/**
 * These tests cover the parts of the Auth_Service module that do not need a
 * live Cognito deployment: error-code classification and the unconfigured path.
 */

describe('getAuthErrorCode', () => {
  it('returns the auth code of a FirebaseError', () => {
    expect(getAuthErrorCode(new FirebaseError('auth/weak-password', 'too short'))).toBe(
      'auth/weak-password'
    );
  });

  it('returns null for anything that is not a FirebaseError', () => {
    expect(getAuthErrorCode(new Error('auth/weak-password'))).toBeNull();
    expect(getAuthErrorCode('auth/weak-password')).toBeNull();
    expect(getAuthErrorCode(undefined)).toBeNull();
  });
});

describe('classifyAuthError', () => {
  const cases: Array<[string, AuthErrorKind]> = [
    ['auth/email-already-in-use', 'email-already-in-use'],
    ['auth/weak-password', 'weak-password'],
    ['auth/invalid-email', 'invalid-email'],
    ['auth/too-many-requests', 'too-many-requests'],
    ['auth/network-request-failed', 'unavailable'],
    ['auth/timeout', 'unavailable'],
    ['auth/popup-closed-by-user', 'popup-cancelled'],
    ['auth/cancelled-popup-request', 'popup-cancelled'],
    ['auth/popup-blocked', 'popup-blocked'],
    ['auth/operation-not-supported-in-this-environment', 'popup-blocked'],
    ['auth/account-exists-with-different-credential', 'account-exists-with-different-credential'],
    ['auth/requires-recent-login', 'requires-recent-login'],
    ['auth/some-code-we-have-never-seen', 'unknown'],
  ];

  it.each(cases)('maps %s to %s', (code, kind) => {
    expect(classifyAuthError(new FirebaseError(code, code))).toBe(kind);
  });

  it('collapses every credential rejection onto one category so nothing reveals which value was wrong', () => {
    const credentialCodes = [
      'auth/invalid-credential',
      'auth/wrong-password',
      'auth/user-not-found',
      'auth/invalid-login-credentials',
    ];
    const kinds = new Set(
      credentialCodes.map((code) => classifyAuthError(new FirebaseError(code, code)))
    );
    expect(kinds).toEqual(new Set<AuthErrorKind>(['invalid-credentials']));
  });

  it('reports a missing identity-service configuration as not-configured', () => {
    expect(classifyAuthError(new Error('Firebase is not configured.'))).toBe('not-configured');
    expect(classifyAuthError(new FirebaseError('auth/invalid-api-key', 'bad key'))).toBe(
      'not-configured'
    );
  });

  it('reports a non-error value as unknown', () => {
    expect(classifyAuthError('boom')).toBe('unknown');
  });
});

describe('with no Cognito configuration present', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_AUTH_ENABLED', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('onAuthChange reports an unauthenticated visitor instead of throwing', () => {
    const callback = vi.fn();
    const unsubscribe = onAuthChange(callback);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(null);
    expect(() => unsubscribe()).not.toThrow();
  });

  it('getIdTokenForRequest yields no Auth_Token', async () => {
    await expect(getIdTokenForRequest()).resolves.toBeNull();
  });
});

describe('provider timeout', () => {
  it('is the 120 seconds Requirement 3.9 prescribes', () => {
    expect(PROVIDER_TIMEOUT_MS).toBe(120_000);
  });
});

describe('deriveDisplayName', () => {
  it('uses the trimmed profile name when it holds at least one character', () => {
    expect(deriveDisplayName('  Ada Lovelace  ', 'ada@example.com')).toBe('Ada Lovelace');
  });

  it('truncates a long profile name to 50 characters', () => {
    const derived = deriveDisplayName('x'.repeat(120), 'ada@example.com');
    expect(derived).toHaveLength(DISPLAY_NAME_MAX_LENGTH);
  });

  it('falls back to the email local part when the profile supplies no name', () => {
    expect(deriveDisplayName(null, 'ada.lovelace@example.com')).toBe('ada.lovelace');
    expect(deriveDisplayName('   ', 'ada.lovelace@example.com')).toBe('ada.lovelace');
    expect(deriveDisplayName(undefined, 'ada@example.com')).toBe('ada');
  });

  it('truncates a long email local part to 50 characters', () => {
    const derived = deriveDisplayName('', `${'a'.repeat(90)}@example.com`);
    expect(derived).toHaveLength(DISPLAY_NAME_MAX_LENGTH);
  });

  it('is never empty, even with nothing usable to derive from', () => {
    expect(deriveDisplayName(null, null).length).toBeGreaterThan(0);
    expect(deriveDisplayName('', '@example.com').length).toBeGreaterThan(0);
  });
});

describe('session age', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('reads back the stored session start under the key auth.ts writes', () => {
    writeSessionStartedAt(1_700_000_000_000);
    expect(window.localStorage.getItem(SESSION_STARTED_AT_KEY)).toBe('1700000000000');
    expect(readSessionStartedAt()).toBe(1_700_000_000_000);
  });

  it('reports no session start after it is cleared, or when the stored value is not a number', () => {
    writeSessionStartedAt(1_000);
    clearSessionStartedAt();
    expect(readSessionStartedAt()).toBeNull();

    window.localStorage.setItem(SESSION_STARTED_AT_KEY, 'not-a-number');
    expect(readSessionStartedAt()).toBeNull();
  });

  it('treats a Session as active only while its age is under 30 days', () => {
    const startedAt = 1_700_000_000_000;
    expect(isSessionActive(startedAt, startedAt)).toBe(true);
    expect(isSessionActive(startedAt + SESSION_MAX_AGE_MS - 1, startedAt)).toBe(true);
    expect(isSessionActive(startedAt + SESSION_MAX_AGE_MS, startedAt)).toBe(false);
    expect(isSessionActive(startedAt + SESSION_MAX_AGE_MS * 2, startedAt)).toBe(false);
  });

  it('falls back to the stored value, and reports inactive when nothing is stored', () => {
    expect(isSessionActive(1_700_000_000_000)).toBe(false);

    writeSessionStartedAt(1_700_000_000_000);
    expect(isSessionActive(1_700_000_000_000 + 1_000)).toBe(true);
  });
});

describe('signin failure ledger', () => {
  const email = 'ada@example.com';

  beforeEach(() => {
    window.localStorage.clear();
  });

  it('admits an attempt for an address with no recorded failures', async () => {
    await expect(getSignInThrottleState(email, 0)).resolves.toEqual({
      allowed: true,
      retryAfterSeconds: 0,
      failureCount: 0,
    });
  });

  it('blocks the eleventh attempt for 60 seconds after 10 failures inside 5 minutes', async () => {
    for (let i = 0; i < 10; i += 1) {
      await recordSignInFailure(email, i * 1_000);
    }

    const blocked = await getSignInThrottleState(email, 9_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(60);
    expect(blocked.failureCount).toBe(10);

    await expect(getSignInThrottleState(email, 9_000 + 60_000)).resolves.toMatchObject({
      allowed: true,
      retryAfterSeconds: 0,
    });
  });

  it('stores no email address, only a hash of it', async () => {
    await recordSignInFailure(email, 0);

    const stored = window.localStorage.getItem(SIGNIN_FAILURES_KEY) ?? '';
    expect(stored).not.toContain(email);
    expect(stored).not.toContain('ada');
    expect(stored).not.toContain('example.com');
  });

  it('treats addresses differing only in letter case as the same address', async () => {
    await recordSignInFailure('Ada@Example.COM', 0);
    await expect(getSignInThrottleState(email, 0)).resolves.toMatchObject({ failureCount: 1 });
  });

  it('resets the recorded count to zero, from any prior state', async () => {
    for (let i = 0; i < 10; i += 1) {
      await recordSignInFailure(email, i * 1_000);
    }

    await resetSignInFailures(email);

    await expect(getSignInThrottleState(email, 9_000)).resolves.toEqual({
      allowed: true,
      retryAfterSeconds: 0,
      failureCount: 0,
    });
    expect(window.localStorage.getItem(SIGNIN_FAILURES_KEY)).toBeNull();
  });

  it('keeps one address\u2019s failures from blocking another', async () => {
    for (let i = 0; i < 10; i += 1) {
      await recordSignInFailure(email, i * 1_000);
    }

    await expect(getSignInThrottleState('grace@example.com', 9_000)).resolves.toMatchObject({
      allowed: true,
      failureCount: 0,
    });
  });

  it('survives a corrupted ledger by starting over rather than throwing', async () => {
    window.localStorage.setItem(SIGNIN_FAILURES_KEY, '{not json');
    await expect(getSignInThrottleState(email, 0)).resolves.toMatchObject({ allowed: true });
  });
});

describe('SignInThrottledError', () => {
  it('carries the countdown and classifies as a rate-limit failure', () => {
    const err = new SignInThrottledError(42);
    expect(err.retryAfterSeconds).toBe(42);
    expect(classifyAuthError(err)).toBe('too-many-requests');
  });
});
