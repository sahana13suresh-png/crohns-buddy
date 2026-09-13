/**
 * Auth_Token verification against Google's published certificates (Requirement 4).
 *
 * This is the concrete adapter behind the `AuthTokenVerifier` port. It is the
 * only module that imports `jose` or talks to the Auth_Service, which keeps
 * route handlers depending on the port alone (design layering rule 3).
 *
 * Design Decision 2 rejects `firebase-admin` here: local verification needs
 * only the Firebase project id and Web API key — both already public browser
 * config — instead of a service-account private key, and it adds no outbound
 * call on the happy path once the certificate cache is warm.
 *
 * The order of operations is fixed, cheapest rejection first, so nothing
 * reaches the network or the Meal_Plan_Store unnecessarily:
 *
 *  1. Read `Authorization: Bearer <token>`; absent or wrong scheme → `missing`.
 *  2. Length guard at 8,192 characters → `invalid`, with no outbound request at
 *     all (Requirement 4.7).
 *  3. Read the JWT header; require `alg: RS256` and a non-empty `kid`.
 *  4. Resolve the signing certificate from the in-process cache, refilling it
 *     from Google inside the 5-second / 2-attempt budget (Requirement 4.5).
 *  5. Verify the signature and the claims, `exp` with a 60-second tolerance —
 *     exactly the "more than 60 seconds in the past" boundary of Requirement 4.3.
 *  6. Look up revocation and account state (Requirement 4.6), cached 5 minutes
 *     per `(sub, auth_time)` unless `requireFreshRevocationCheck` is set.
 *
 * Two properties of this module are load-bearing and easy to break by accident:
 *
 * - **Fail closed.** If the certificates cannot be fetched, the result is
 *   `unavailable` (HTTP 503, Session untouched). There is no code path that
 *   accepts a token whose signature was not checked.
 * - **One indistinguishable rejection.** Every failure from step 2 onward
 *   returns the same `invalid` kind. Nothing in the return value separates a
 *   bad signature from an expired token from a revoked session, so no caller
 *   can build a response that separates them either (Requirements 4.3, 4.6, 4.7).
 */

import { decodeProtectedHeader, importX509, jwtVerify, type JWTPayload, type KeyLike } from 'jose';

import type {
  AuthTokenVerifier,
  VerifyAuthTokenOptions,
  VerifyResult,
} from './authTokenVerifier';
import { assertServerEnv } from './env';
import { redactOutboundPayload, redactString } from './redaction';

/** Longest Auth_Token accepted before any outbound request (Requirement 4.7). */
export const AUTH_TOKEN_MAX_CHARS = 8192;

/** Google's x509 certificates for the `securetoken@system` signer. */
export const CERTIFICATE_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

/** Identity Toolkit endpoint used for the revocation and account-state check. */
export const ACCOUNTS_LOOKUP_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:lookup';

/** Total wall-clock budget for reaching the Auth_Service (Requirement 4.5). */
export const AUTH_SERVICE_BUDGET_MS = 5_000;

/** Attempts allowed inside that budget (Requirement 4.5). */
export const AUTH_SERVICE_MAX_ATTEMPTS = 2;

/**
 * Per-attempt timeout, so both permitted attempts fit inside the total budget
 * rather than the first attempt consuming all of it.
 */
const ATTEMPT_TIMEOUT_MS = AUTH_SERVICE_BUDGET_MS / AUTH_SERVICE_MAX_ATTEMPTS;

/** Expiry tolerance in seconds — the Requirement 4.3 boundary. */
export const CLOCK_TOLERANCE_SECONDS = 60;

/** Longest `sub` claim accepted. */
export const MAX_SUBJECT_CHARS = 128;

/** How long a revocation answer is reused (Requirement 4.6). */
export const REVOCATION_CACHE_TTL_MS = 5 * 60 * 1000;

/** Certificate lifetime used when the response carries no usable `max-age`. */
const DEFAULT_CERTIFICATE_TTL_MS = 6 * 60 * 60 * 1000;

/** Upper bound on a honoured `max-age`, so a bad header cannot pin stale keys. */
const MAX_CERTIFICATE_TTL_MS = 24 * 60 * 60 * 1000;

/** Bound on the revocation cache so a long-lived process cannot grow forever. */
const MAX_REVOCATION_CACHE_ENTRIES = 1000;

/** Longest display name derived from token claims. */
const MAX_DISPLAY_NAME_CHARS = 50;

const INVALID: VerifyResult = { ok: false, kind: 'invalid' };
const MISSING: VerifyResult = { ok: false, kind: 'missing' };
const UNAVAILABLE: VerifyResult = { ok: false, kind: 'unavailable' };

/** Raised when the Auth_Service produced no answer inside its budget. */
class AuthServiceUnavailableError extends Error {
  constructor(readonly stage: 'certificates' | 'revocation') {
    super(`Auth_Service unreachable while resolving ${stage}`);
    this.name = 'AuthServiceUnavailableError';
  }
}

interface CertificateSet {
  /** PEM certificate per `kid`, exactly as published. */
  pemByKid: Map<string, string>;
  expiresAtMs: number;
}

let certificateCache: CertificateSet | null = null;

/** Imported keys memoized by PEM, so a warm cache does no crypto work twice. */
const importedKeys = new Map<string, KeyLike>();

interface RevocationEntry {
  outcome: 'ok' | 'invalid';
  /**
   * Account creation time from the same lookup, cached with the answer so a
   * cache hit does not silently drop it from the derived identity.
   */
  accountCreatedAtMs?: number;
  expiresAtMs: number;
}

/**
 * The revocation answer, plus the account creation time the same lookup already
 * carries. `createdAt` is not a token claim, so this lookup is the only verified
 * source for it (Requirement 10.2); it travels with the outcome rather than
 * through a second call.
 */
interface RevocationAnswer {
  outcome: 'ok' | 'invalid' | 'unavailable';
  accountCreatedAtMs?: number;
}

const revocationCache = new Map<string, RevocationEntry>();

/**
 * Drops every cached certificate and revocation answer. Exported for tests,
 * which need a cold cache per case; nothing in production calls it.
 */
export function resetAuthTokenVerifierCaches(): void {
  certificateCache = null;
  importedKeys.clear();
  revocationCache.clear();
}

/**
 * Reads the Auth_Token out of the request. Returns `null` when there is no
 * `Authorization` header, when the scheme is not `Bearer`, or when the
 * credential part is blank — all of which are `missing` (Requirement 4.2).
 */
function readBearerToken(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (header === null) return null;

  const separator = header.indexOf(' ');
  if (separator < 0) return null;

  const scheme = header.slice(0, separator);
  if (scheme.toLowerCase() !== 'bearer') return null;

  const token = header.slice(separator + 1).trim();
  return token === '' ? null : token;
}

/** Truncates to `limit` code points, so a surrogate pair is never split. */
function firstCodePoints(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join('');
}

/**
 * Display name from the verified claims: the `name` claim when it carries
 * anything, otherwise the local part of the email, each capped at 50
 * characters. Never read from a request body (Requirement 4.4).
 */
function deriveDisplayName(nameClaim: unknown, email: string): string {
  const trimmed = typeof nameClaim === 'string' ? nameClaim.trim() : '';
  if (trimmed !== '') return firstCodePoints(trimmed, MAX_DISPLAY_NAME_CHARS);
  const localPart = email.split('@')[0] ?? '';
  return firstCodePoints(localPart, MAX_DISPLAY_NAME_CHARS);
}

/**
 * Removes anything credential-shaped from a diagnostic string before it is
 * emitted. The Web API key travels in a query string, which the shared
 * redaction patterns do not cover, so it is stripped explicitly here.
 */
function sanitizeDiagnostic(message: string): string {
  return redactString(message).replace(/key=[^&\s"']+/gi, 'key=[redacted]');
}

/**
 * Emits one line when the Auth_Service could not be reached, so a fail-closed
 * 503 is diagnosable. The payload carries no token, no claim, and no personal
 * data, and passes through the shared redaction helper regardless.
 */
function warnUnavailable(stage: 'certificates' | 'revocation', detail: string): void {
  const payload = redactOutboundPayload({
    event: 'authTokenVerifierUnavailable',
    stage,
    detail: sanitizeDiagnostic(detail),
    atMs: Date.now(),
  });
  // eslint-disable-next-line no-console
  console.warn(JSON.stringify(payload));
}

/**
 * Reads the Auth_Service configuration. `assertServerEnv` throws when a value
 * is absent rather than substituting a default, so a misconfigured deployment
 * fails loudly instead of verifying against the wrong project.
 */
function readAuthServiceConfig(): { projectId: string; apiKey: string } {
  assertServerEnv(['AUTH_SERVICE']);
  return {
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? '',
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? '',
  };
}

/** A response status worth a second attempt rather than an immediate answer. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Performs an outbound Auth_Service request inside the Requirement 4.5 budget:
 * at most 2 attempts, at most 5 seconds in total. Throws
 * {@link AuthServiceUnavailableError} when no answer arrives in time, which the
 * callers map to `unavailable` — never to a skipped check.
 */
async function fetchWithinBudget(
  stage: 'certificates' | 'revocation',
  url: string,
  init: RequestInit,
): Promise<Response> {
  const deadlineMs = Date.now() + AUTH_SERVICE_BUDGET_MS;
  let lastDetail = 'no attempt completed';

  for (let attempt = 1; attempt <= AUTH_SERVICE_MAX_ATTEMPTS; attempt += 1) {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) break;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), Math.min(remainingMs, ATTEMPT_TIMEOUT_MS));
    try {
      const response = await fetch(url, { ...init, cache: 'no-store', signal: controller.signal });
      if (isRetryableStatus(response.status)) {
        lastDetail = `status ${response.status}`;
        continue;
      }
      return response;
    } catch (error: unknown) {
      lastDetail = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown transport failure';
    } finally {
      clearTimeout(timeoutId);
    }
  }

  warnUnavailable(stage, lastDetail);
  throw new AuthServiceUnavailableError(stage);
}

/**
 * Honours the response's `Cache-Control: max-age`, clamped to a day. An absent
 * or unparseable header falls back to the ~6 hours Google publishes in
 * practice; a zero or negative age means the set is used once and not cached.
 */
function certificateTtlMs(response: Response): number {
  const header = response.headers.get('cache-control');
  if (header === null) return DEFAULT_CERTIFICATE_TTL_MS;

  const match = /max-age\s*=\s*(\d+)/i.exec(header);
  if (match === null) return DEFAULT_CERTIFICATE_TTL_MS;

  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds)) return DEFAULT_CERTIFICATE_TTL_MS;
  return Math.min(seconds * 1000, MAX_CERTIFICATE_TTL_MS);
}

/**
 * Fetches and caches the published certificate set. Any failure — transport,
 * non-2xx status, or a body that is not a `kid` → PEM map — is
 * {@link AuthServiceUnavailableError}, because a token whose signature cannot
 * be checked must not be accepted.
 */
async function fetchCertificates(): Promise<CertificateSet> {
  const response = await fetchWithinBudget('certificates', CERTIFICATE_URL, { method: 'GET' });
  if (!response.ok) {
    warnUnavailable('certificates', `status ${response.status}`);
    throw new AuthServiceUnavailableError('certificates');
  }

  const body: unknown = await response.json().catch(() => null);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    warnUnavailable('certificates', 'certificate document was not an object');
    throw new AuthServiceUnavailableError('certificates');
  }

  const pemByKid = new Map<string, string>();
  for (const [kid, pem] of Object.entries(body as Record<string, unknown>)) {
    if (typeof pem === 'string' && pem !== '') pemByKid.set(kid, pem);
  }
  if (pemByKid.size === 0) {
    warnUnavailable('certificates', 'certificate document carried no certificates');
    throw new AuthServiceUnavailableError('certificates');
  }

  const ttlMs = certificateTtlMs(response);
  const set: CertificateSet = { pemByKid, expiresAtMs: Date.now() + ttlMs };
  certificateCache = ttlMs > 0 ? set : null;
  return set;
}

/**
 * Resolves the signing key for `kid`. A cached set that lacks the `kid` is
 * refetched once, since that is what a key rotation looks like; a `kid` still
 * absent from a freshly fetched set is an unusable token, not an outage, so it
 * resolves to `null` and the caller answers `invalid`.
 */
async function resolveSigningKey(kid: string): Promise<KeyLike | null> {
  const cached = certificateCache;
  const usable = cached !== null && cached.expiresAtMs > Date.now() && cached.pemByKid.has(kid);
  const set = usable && cached !== null ? cached : await fetchCertificates();

  const pem = set.pemByKid.get(kid);
  if (pem === undefined) return null;

  const alreadyImported = importedKeys.get(pem);
  if (alreadyImported !== undefined) return alreadyImported;

  try {
    const key = await importX509(pem, 'RS256');
    importedKeys.set(pem, key);
    return key;
  } catch (error: unknown) {
    // A published certificate we cannot import is an Auth_Service problem, not
    // a defect in the presented token, so fail closed to `unavailable`.
    warnUnavailable('certificates', error instanceof Error ? error.message : 'certificate import failed');
    throw new AuthServiceUnavailableError('certificates');
  }
}

/** Cache key for one revocation answer: the subject and its authentication time. */
function revocationCacheKey(userId: string, authTimeMs: number): string {
  return `${userId}\u0000${authTimeMs}`;
}

/** Keeps the revocation cache bounded, expired entries first. */
function pruneRevocationCache(nowMs: number): void {
  for (const [key, entry] of Array.from(revocationCache.entries())) {
    if (entry.expiresAtMs <= nowMs) revocationCache.delete(key);
  }
  // Map iterates in insertion order, so this drops the oldest survivors.
  for (const key of Array.from(revocationCache.keys())) {
    if (revocationCache.size <= MAX_REVOCATION_CACHE_ENTRIES) break;
    revocationCache.delete(key);
  }
}

/**
 * Reads `validSince` from a lookup record. Identity Toolkit returns it as a
 * string of whole seconds; anything else is treated as absent.
 */
function validSinceMs(record: Record<string, unknown>): number | null {
  const raw = record.validSince;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

/**
 * Reads `createdAt` from a lookup record. Identity Toolkit returns it as a
 * string of whole milliseconds; anything not a positive finite number is
 * treated as absent, so a malformed value becomes an absent creation time
 * rather than a bogus date in the data export.
 */
function accountCreatedAtMs(record: Record<string, unknown>): number | undefined {
  const raw = record.createdAt;
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return Math.round(ms);
}

/**
 * Revocation and account-state check (Requirement 4.6). A removed Account, a
 * disabled Account, and a `validSince` newer than the token's `auth_time` all
 * answer `invalid`; only a failure to reach the Auth_Service answers
 * `unavailable`.
 *
 * Answers are cached for 5 minutes keyed by `(sub, auth_time)`, so a
 * re-authentication produces a different key and is never served a stale
 * answer. `requireFreshRevocationCheck` skips the read of that cache, which is
 * what every mutating route passes.
 */
async function checkRevocation(
  token: string,
  userId: string,
  authTimeMs: number,
  apiKey: string,
  requireFresh: boolean,
): Promise<RevocationAnswer> {
  const key = revocationCacheKey(userId, authTimeMs);
  const nowMs = Date.now();

  if (!requireFresh) {
    const cached = revocationCache.get(key);
    if (cached !== undefined && cached.expiresAtMs > nowMs) {
      return {
        outcome: cached.outcome,
        ...(cached.accountCreatedAtMs === undefined
          ? {}
          : { accountCreatedAtMs: cached.accountCreatedAtMs }),
      };
    }
  }

  let response: Response;
  try {
    response = await fetchWithinBudget('revocation', `${ACCOUNTS_LOOKUP_URL}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
    });
  } catch {
    return { outcome: 'unavailable' };
  }

  const body: unknown = await response.json().catch(() => null);

  const remember = (outcome: 'ok' | 'invalid', createdAtMs?: number): RevocationAnswer => {
    revocationCache.set(key, {
      outcome,
      ...(createdAtMs === undefined ? {} : { accountCreatedAtMs: createdAtMs }),
      expiresAtMs: Date.now() + REVOCATION_CACHE_TTL_MS,
    });
    pruneRevocationCache(Date.now());
    return { outcome, ...(createdAtMs === undefined ? {} : { accountCreatedAtMs: createdAtMs }) };
  };

  // A 4xx here is the Auth_Service saying the credential or the Account is not
  // usable — USER_NOT_FOUND, INVALID_ID_TOKEN, TOKEN_EXPIRED all land here.
  // Retryable statuses never reach this point; they exhaust the budget above.
  if (!response.ok) return remember('invalid');

  if (body === null || typeof body !== 'object' || Array.isArray(body)) return remember('invalid');

  const users = (body as { users?: unknown }).users;
  if (!Array.isArray(users) || users.length === 0) return remember('invalid');

  const record = users[0];
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return remember('invalid');
  const user = record as Record<string, unknown>;

  if (user.disabled === true) return remember('invalid');
  if (typeof user.localId === 'string' && user.localId !== userId) return remember('invalid');

  const revokedBeforeMs = validSinceMs(user);
  if (revokedBeforeMs !== null && revokedBeforeMs > authTimeMs) return remember('invalid');

  return remember('ok', accountCreatedAtMs(user));
}

/**
 * Claim checks that sit outside what `jwtVerify` already enforces. Returns the
 * derived identity fields, or `null` for any claim that fails — one
 * indistinguishable rejection, as with every other step.
 */
function readIdentityClaims(
  payload: JWTPayload,
  nowMs: number,
): { userId: string; authTimeMs: number; email: string; displayName: string } | null {
  const userId = payload.sub;
  if (typeof userId !== 'string' || userId === '' || userId.length > MAX_SUBJECT_CHARS) return null;

  const authTimeSeconds = (payload as { auth_time?: unknown }).auth_time;
  if (typeof authTimeSeconds !== 'number' || !Number.isFinite(authTimeSeconds)) return null;

  const authTimeMs = Math.round(authTimeSeconds * 1000);
  // Not in the future, allowing the same skew tolerance applied to `exp`.
  if (authTimeMs > nowMs + CLOCK_TOLERANCE_SECONDS * 1000) return null;

  const emailClaim = (payload as { email?: unknown }).email;
  const email = typeof emailClaim === 'string' ? emailClaim : '';
  const displayName = deriveDisplayName((payload as { name?: unknown }).name, email);

  return { userId, authTimeMs, email, displayName };
}

/**
 * Verifies the Auth_Token on `req` and derives the identity, or reports why no
 * identity could be derived. Never throws for an unusable credential.
 */
export async function verifyAuthToken(
  req: Request,
  opts?: VerifyAuthTokenOptions,
): Promise<VerifyResult> {
  // 1. Read the credential. Absent header or wrong scheme is `missing` (4.2).
  const token = readBearerToken(req);
  if (token === null) return MISSING;

  // 2. Length guard, before any outbound request whatsoever (4.7).
  if (token.length > AUTH_TOKEN_MAX_CHARS) return INVALID;

  // 3. JWT header: RS256 with a key id, or nothing to resolve.
  let kid: string;
  try {
    const header = decodeProtectedHeader(token);
    if (header.alg !== 'RS256') return INVALID;
    if (typeof header.kid !== 'string' || header.kid === '') return INVALID;
    kid = header.kid;
  } catch {
    return INVALID;
  }

  let projectId: string;
  let apiKey: string;
  try {
    ({ projectId, apiKey } = readAuthServiceConfig());
  } catch (error: unknown) {
    warnUnavailable(
      'revocation',
      error instanceof Error ? error.message : 'Auth_Service is not configured'
    );
    return UNAVAILABLE;
  }

  // 4. Certificate resolution. A failure here is `unavailable`, so the
  //    signature check is deferred, never skipped (4.5).
  let key: KeyLike | null;
  try {
    key = await resolveSigningKey(kid);
  } catch (error: unknown) {
    if (error instanceof AuthServiceUnavailableError) return UNAVAILABLE;
    return INVALID;
  }
  if (key === null) return INVALID;

  // 5. Signature and claim verification. `clockTolerance` of 60 seconds is the
  //    Requirement 4.3 expiry boundary.
  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(token, key, {
      algorithms: ['RS256'],
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });
    payload = verified.payload;
  } catch {
    return INVALID;
  }

  const claims = readIdentityClaims(payload, Date.now());
  if (claims === null) return INVALID;

  // 6. Revocation and account state (4.6).
  const revocation = await checkRevocation(
    token,
    claims.userId,
    claims.authTimeMs,
    apiKey,
    opts?.requireFreshRevocationCheck === true,
  );
  if (revocation.outcome === 'unavailable') return UNAVAILABLE;
  if (revocation.outcome === 'invalid') return INVALID;

  return {
    ok: true,
    identity: {
      userId: claims.userId,
      authTimeMs: claims.authTimeMs,
      email: claims.email,
      displayName: claims.displayName,
      // Omitted entirely when the Auth_Service reported no creation time, so an
      // identity never carries `accountCreatedAtMs: undefined` as a key.
      ...(revocation.accountCreatedAtMs === undefined
        ? {}
        : { accountCreatedAtMs: revocation.accountCreatedAtMs }),
    },
  };
}

/**
 * The port implementation route handlers receive. `withAuth` depends on this
 * value's type, not on this module, so tests substitute an in-memory verifier.
 */
export const joseAuthTokenVerifier: AuthTokenVerifier = { verifyAuthToken };
