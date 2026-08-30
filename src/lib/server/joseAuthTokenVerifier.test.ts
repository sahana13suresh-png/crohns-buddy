// @vitest-environment node
//
// The verifier is server-only, and `jose` signs and verifies against Node's own
// Uint8Array and WebCrypto. Under the project-wide jsdom environment those come
// from a different realm and the signing path rejects its own payload, so this
// file runs in the environment the code actually runs in.

import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestSigningKeyPair } from '../../test/testCertificate';
import {
  ACCOUNTS_LOOKUP_URL,
  AUTH_SERVICE_BUDGET_MS,
  AUTH_SERVICE_MAX_ATTEMPTS,
  AUTH_TOKEN_MAX_CHARS,
  CERTIFICATE_URL,
  REVOCATION_CACHE_TTL_MS,
  resetAuthTokenVerifierCaches,
  verifyAuthToken,
} from './joseAuthTokenVerifier';

/**
 * Smoke coverage for the pre-network steps of the verifier: the ones that must
 * reject without ever reaching the Auth_Service. The fail-closed, certificate
 * cache, and revocation cache cases are covered by task 5.3.
 */
describe('verifyAuthToken pre-network rejections', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetAuthTokenVerifierCaches();
    fetchSpy = vi.fn(() => Promise.reject(new Error('no outbound request expected')));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetAuthTokenVerifierCaches();
  });

  const request = (authorization?: string): Request =>
    new Request('https://example.test/api/meal-plans', {
      headers: authorization === undefined ? {} : { authorization },
    });

  it('reports missing when no Authorization header is present', async () => {
    await expect(verifyAuthToken(request())).resolves.toEqual({ ok: false, kind: 'missing' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports missing for a non-Bearer scheme or a blank credential', async () => {
    await expect(verifyAuthToken(request('Basic abc'))).resolves.toEqual({ ok: false, kind: 'missing' });
    await expect(verifyAuthToken(request('Bearer    '))).resolves.toEqual({ ok: false, kind: 'missing' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports invalid for a token over 8,192 characters with no outbound request', async () => {
    const oversized = 'a'.repeat(AUTH_TOKEN_MAX_CHARS + 1);
    await expect(verifyAuthToken(request(`Bearer ${oversized}`))).resolves.toEqual({
      ok: false,
      kind: 'invalid',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports invalid for a token whose header is unreadable or not RS256', async () => {
    const garbage = 'not-a-jwt';
    const hs256Header = Buffer.from(JSON.stringify({ alg: 'HS256', kid: 'k1' })).toString('base64url');
    const noKidHeader = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');

    for (const token of [garbage, `${hs256Header}.e30.sig`, `${noKidHeader}.e30.sig`]) {
      await expect(verifyAuthToken(request(`Bearer ${token}`))).resolves.toEqual({
        ok: false,
        kind: 'invalid',
      });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/**
 * Fail-closed and cache behaviour.
 *
 * **Validates: Requirements 4.5, 4.6**
 *
 * These cases drive the verifier through real RS256 signature verification: the
 * tokens are signed with a generated key pair and the mocked certificate
 * endpoint serves a real X.509 certificate for the matching public key, so
 * nothing about step 5 is stubbed out. Only `fetch` is replaced, which is the
 * boundary the requirements talk about.
 *
 * Time is controlled with `vi.useFakeTimers()`. The 5-second budget, the
 * certificate `max-age`, and the 5-minute revocation TTL are all advanced
 * rather than waited on, so the suite stays fast and deterministic.
 */
describe('verifyAuthToken fail-closed and cache behaviour', () => {
  const PROJECT_ID = 'crohns-buddy-test';
  const API_KEY = 'test-web-api-key';
  const KID = 'test-kid-1';
  const USER_ID = 'user-under-test';
  const NOW_MS = Date.UTC(2025, 0, 15, 12, 0, 0);
  const AUTH_TIME_MS = NOW_MS - 60_000;
  const ATTEMPT_SLICE_MS = AUTH_SERVICE_BUDGET_MS / AUTH_SERVICE_MAX_ATTEMPTS;

  const keyPair = createTestSigningKeyPair(KID);

  const expectedIdentity = {
    ok: true,
    identity: {
      userId: USER_ID,
      authTimeMs: AUTH_TIME_MS,
      email: 'patient@example.test',
      displayName: 'Test Patient',
    },
  };

  let certificateCalls = 0;
  let revocationCalls = 0;
  let certificateHandler: (init: RequestInit) => Promise<Response>;
  let revocationHandler: (init: RequestInit) => Promise<Response>;

  /**
   * Settles when its stage is first requested. Advancing fake timers before the
   * request exists would leave nothing to abort, and signature verification
   * happens between the two stages, so a silent-request case waits for the
   * request rather than assuming it is already in flight.
   */
  const requested = (): { promise: Promise<void>; fire: () => void } => {
    let fire = (): void => undefined;
    const promise = new Promise<void>((resolve) => {
      fire = resolve;
    });
    return { promise, fire };
  };

  let certificateRequested = requested();
  let revocationRequested = requested();

  /** The certificate document Google publishes: `kid` → certificate PEM. */
  const certificateDocument = (maxAgeSeconds: number): Response =>
    new Response(JSON.stringify({ [KID]: keyPair.certificatePem }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': `public, max-age=${maxAgeSeconds}, must-revalidate`,
      },
    });

  /** An `accounts:lookup` answer for an active, non-revoked Account. */
  const activeAccount = (validSinceMs = AUTH_TIME_MS - 60_000): Response =>
    new Response(
      JSON.stringify({
        users: [{ localId: USER_ID, disabled: false, validSince: String(Math.floor(validSinceMs / 1000)) }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  /** A request that never answers, and only settles when the verifier aborts it. */
  const silent = (init: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      });
    });

  /** Runs the whole 5-second budget forward without waiting on real time. */
  const exhaustAuthServiceBudget = async (): Promise<void> => {
    for (let attempt = 0; attempt < AUTH_SERVICE_MAX_ATTEMPTS; attempt += 1) {
      await vi.advanceTimersByTimeAsync(ATTEMPT_SLICE_MS);
    }
  };

  /** A well-formed Auth_Token for the Account under test, valid for an hour. */
  const mintToken = (): Promise<string> =>
    new SignJWT({
      auth_time: Math.floor(AUTH_TIME_MS / 1000),
      email: 'patient@example.test',
      name: 'Test Patient',
    })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setSubject(USER_ID)
      .setIssuer(`https://securetoken.google.com/${PROJECT_ID}`)
      .setAudience(PROJECT_ID)
      .setIssuedAt(Math.floor(NOW_MS / 1000))
      .setExpirationTime(Math.floor(NOW_MS / 1000) + 3600)
      .sign(keyPair.privateKey);

  const bearer = (token: string): Request =>
    new Request('https://example.test/api/meal-plans', { headers: { authorization: `Bearer ${token}` } });

  let token: string;

  beforeEach(async () => {
    resetAuthTokenVerifierCaches();
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    vi.stubEnv('NEXT_PUBLIC_FIREBASE_PROJECT_ID', PROJECT_ID);
    vi.stubEnv('NEXT_PUBLIC_FIREBASE_API_KEY', API_KEY);
    vi.stubEnv('NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN', `${PROJECT_ID}.firebaseapp.com`);
    // The verifier emits one warning line per unreachable Auth_Service call.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    certificateCalls = 0;
    revocationCalls = 0;
    certificateRequested = requested();
    revocationRequested = requested();
    certificateHandler = () => Promise.resolve(certificateDocument(3600));
    revocationHandler = () => Promise.resolve(activeAccount());

    vi.stubGlobal(
      'fetch',
      vi.fn((url: unknown, init: RequestInit = {}) => {
        const target = String(url);
        if (target === CERTIFICATE_URL) {
          certificateCalls += 1;
          certificateRequested.fire();
          return certificateHandler(init);
        }
        if (target.startsWith(ACCOUNTS_LOOKUP_URL)) {
          revocationCalls += 1;
          revocationRequested.fire();
          return revocationHandler(init);
        }
        return Promise.reject(new Error(`unexpected outbound request to ${target}`));
      }),
    );

    token = await mintToken();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetAuthTokenVerifierCaches();
  });

  it('reports unavailable, not invalid, when the certificate endpoint stays silent across both attempts', async () => {
    certificateHandler = (init) => silent(init);

    let settled = false;
    const pending = verifyAuthToken(bearer(token)).then((result) => {
      settled = true;
      return result;
    });
    await certificateRequested.promise;

    // Half the budget in: the first attempt has been abandoned and the second
    // is underway, and no answer has been produced yet.
    await vi.advanceTimersByTimeAsync(ATTEMPT_SLICE_MS);
    expect(certificateCalls).toBe(2);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(ATTEMPT_SLICE_MS);

    // 503, never 401 — an unreachable Auth_Service must not look like a bad
    // credential, and the signature check is deferred rather than skipped.
    await expect(pending).resolves.toEqual({ ok: false, kind: 'unavailable' });
    expect(certificateCalls).toBe(AUTH_SERVICE_MAX_ATTEMPTS);
    expect(revocationCalls).toBe(0);
  });

  it('leaves the Session unchanged, so the same Auth_Token verifies once certificates return', async () => {
    certificateHandler = (init) => silent(init);
    const failing = verifyAuthToken(bearer(token));
    await certificateRequested.promise;
    await exhaustAuthServiceBudget();
    await expect(failing).resolves.toEqual({ ok: false, kind: 'unavailable' });

    certificateHandler = () => Promise.resolve(certificateDocument(3600));

    await expect(verifyAuthToken(bearer(token))).resolves.toEqual(expectedIdentity);
  });

  it('reports unavailable when the revocation lookup stays silent across both attempts', async () => {
    revocationHandler = (init) => silent(init);

    const pending = verifyAuthToken(bearer(token));
    await revocationRequested.promise;
    await exhaustAuthServiceBudget();

    await expect(pending).resolves.toEqual({ ok: false, kind: 'unavailable' });
    expect(revocationCalls).toBe(AUTH_SERVICE_MAX_ATTEMPTS);
  });

  it('reuses cached certificates until max-age elapses, then refetches them', async () => {
    certificateHandler = () => Promise.resolve(certificateDocument(120));

    await expect(verifyAuthToken(bearer(token))).resolves.toEqual(expectedIdentity);
    await expect(verifyAuthToken(bearer(token))).resolves.toEqual(expectedIdentity);
    expect(certificateCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(121_000);

    await expect(verifyAuthToken(bearer(token))).resolves.toEqual(expectedIdentity);
    expect(certificateCalls).toBe(2);
    // The revocation answer outlives the certificates: each cache honours its
    // own lifetime rather than being invalidated together.
    expect(revocationCalls).toBe(1);
  });

  it('does not cache certificates served with max-age=0', async () => {
    certificateHandler = () => Promise.resolve(certificateDocument(0));

    await expect(verifyAuthToken(bearer(token))).resolves.toEqual(expectedIdentity);
    await expect(verifyAuthToken(bearer(token))).resolves.toEqual(expectedIdentity);

    expect(certificateCalls).toBe(2);
  });

  it('reuses a revocation answer for 5 minutes, then looks it up again', async () => {
    await expect(verifyAuthToken(bearer(token))).resolves.toEqual(expectedIdentity);
    await vi.advanceTimersByTimeAsync(REVOCATION_CACHE_TTL_MS - 1);
    await expect(verifyAuthToken(bearer(token))).resolves.toEqual(expectedIdentity);
    expect(revocationCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(2);

    await expect(verifyAuthToken(bearer(token))).resolves.toEqual(expectedIdentity);
    expect(revocationCalls).toBe(2);
  });

  it('bypasses the revocation cache under requireFreshRevocationCheck', async () => {
    await expect(verifyAuthToken(bearer(token))).resolves.toEqual(expectedIdentity);
    expect(revocationCalls).toBe(1);

    await expect(
      verifyAuthToken(bearer(token), { requireFreshRevocationCheck: true }),
    ).resolves.toEqual(expectedIdentity);

    expect(revocationCalls).toBe(2);
  });

  it('observes a revoked Session immediately under requireFreshRevocationCheck', async () => {
    await expect(verifyAuthToken(bearer(token))).resolves.toEqual(expectedIdentity);

    // The Session is revoked after the answer was cached: validSince is now
    // newer than the token's auth_time.
    revocationHandler = () => Promise.resolve(activeAccount(AUTH_TIME_MS + 1_000));

    // A read path tolerates the cached answer for up to 5 minutes...
    await expect(verifyAuthToken(bearer(token))).resolves.toEqual(expectedIdentity);

    // ...a mutating path does not, and the rejection is the same opaque
    // `invalid` every other cause produces (Requirement 4.6).
    await expect(
      verifyAuthToken(bearer(token), { requireFreshRevocationCheck: true }),
    ).resolves.toEqual({ ok: false, kind: 'invalid' });
  });
});
