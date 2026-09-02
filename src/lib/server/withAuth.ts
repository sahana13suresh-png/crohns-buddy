/**
 * Authenticated route middleware (Requirement 4).
 *
 * Every authenticated handler is wrapped by {@link withAuth}, which is what
 * makes the verify-then-derive order of Requirement 4.1 structural rather than
 * a convention a new route could forget. Two properties are load-bearing:
 *
 * - **Verification always resolves first.** The wrapper awaits the verifier
 *   before it calls the handler at all, so no handler body — and therefore no
 *   Meal_Plan_Store access — can run ahead of the check (4.1, 4.2, 4.3, 4.5,
 *   4.6, 4.7, 10.8).
 * - **The handler's only route to a User_Id is `ctx.identity.userId`.** The
 *   wrapper deletes any `userId` key from the parsed body, from the query
 *   string, and from the route params before the handler sees the request, so a
 *   supplied User_Id is not merely ignored by convention — it is not reachable.
 *   A request carrying a mismatched `userId` therefore completes normally
 *   against the derived one, with no error reported, which is exactly what
 *   Requirement 4.4 asks for.
 *
 * The verifier is injected rather than imported by the handler so the
 * property tests can substitute an in-memory fake; the default is the `jose`
 * adapter.
 */

import type {
  AuthTokenVerifier,
  VerifiedIdentity,
} from './authTokenVerifier';
import { credentialErrorResponse, serviceUnavailableResponse } from './apiErrors';
import { configuredAuthProvider } from './authProvider';
import { cognitoAuthTokenVerifier } from './cognitoAuthTokenVerifier';
import { logtoAuthTokenVerifier } from './logtoAuthTokenVerifier';

/** What a wrapped handler receives in place of the raw route context. */
export interface AuthenticatedContext {
  /**
   * The identity derived from the verified Auth_Token. `identity.userId` is the
   * only User_Id available to the handler (Requirement 4.4).
   */
  identity: VerifiedIdentity;
  /** Route params with any `userId`-shaped key removed (Requirement 4.4). */
  params: Record<string, string>;
}

/**
 * The route context Next.js supplies. Next.js 16 resolves route params
 * asynchronously; accepting the synchronous shape too keeps the handler
 * factories straightforward to exercise outside the framework.
 */
export interface RouteContext {
  params?: Record<string, string> | Promise<Record<string, string>>;
}

export interface WithAuthOptions {
  /**
   * Forwarded to the verifier as `requireFreshRevocationCheck`. Mutating routes
   * (`POST`, `PUT`, `PATCH`, `DELETE`, export, purge) set this so a removed
   * Account or a revoked Session is observed immediately instead of through the
   * 5-minute cache (Requirement 4.6).
   */
  freshRevocationCheck?: boolean;
  /**
   * Substitutes the {@link AuthTokenVerifier}. Defaults to the `jose` adapter.
   * Present so tests can drive the wrapper without reaching the network.
   */
  verifier?: AuthTokenVerifier;
}

/** A handler that runs only after an identity has been derived. */
export type AuthenticatedHandler = (
  req: Request,
  ctx: AuthenticatedContext,
) => Promise<Response>;

/** The shape Next.js route exports must have. */
export type RouteHandler = (req: Request, ctx?: RouteContext) => Promise<Response>;

/**
 * Keys treated as a supplied User_Id and removed before the handler runs.
 * Matched after lowercasing and dropping `_`/`-`, so `userId`, `userid`,
 * `user_id`, and `USER-ID` are all covered — a caller cannot slip one through
 * by changing its spelling.
 */
function isUserIdKey(key: string): boolean {
  return key.toLowerCase().replace(/[_-]/g, '') === 'userid';
}

/** A copy of `record` with every `userId`-shaped key removed. */
function withoutUserId<T>(record: Record<string, T>): Record<string, T> {
  const cleaned: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!isUserIdKey(key)) cleaned[key] = value;
  }
  return cleaned;
}

/**
 * Removes every `userId`-shaped query parameter. Returns the URL as a string so
 * the reconstructed request carries no supplied User_Id at all — a handler
 * reading `new URL(req.url).searchParams` cannot find one (Requirement 4.4).
 */
function sanitizeUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  const doomed = Array.from(url.searchParams.keys()).filter(isUserIdKey);
  for (const key of doomed) url.searchParams.delete(key);
  return url.toString();
}

/** Whether the text is worth handing to `JSON.parse`. */
function looksLikeJson(contentType: string | null, text: string): boolean {
  if (contentType !== null && contentType.toLowerCase().includes('json')) return true;
  const first = text.trimStart()[0];
  return first === '{' || first === '[';
}

/**
 * Removes any top-level `userId` key from a JSON body.
 *
 * Only the top level is touched. Deeper keys belong to Meal_Plan content, whose
 * schema has no User_Id field at all, and rewriting arbitrary nested data would
 * mean the handler no longer receives the bytes the Patient sent — a fidelity
 * problem for Requirement 9.6. Returning the original text unchanged when
 * nothing was stripped keeps the common case byte-exact.
 */
function sanitizeJsonBody(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON after all. Forward it untouched and let the handler reject it,
    // so a malformed body still produces the handler's own 400 rather than a
    // response shaped by this wrapper.
    return text;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return text;

  const record = parsed as Record<string, unknown>;
  const carriesUserId = Object.keys(record).some(isUserIdKey);
  if (!carriesUserId) return text;

  return JSON.stringify(withoutUserId(record));
}

/**
 * Rebuilds the request with the supplied User_Id removed from both the query
 * string and the parsed body. The handler receives this request instead of the
 * original, so `req.json()` and `req.url` are already clean.
 */
async function sanitizeRequest(req: Request): Promise<Request> {
  const url = sanitizeUrl(req.url);
  const method = req.method.toUpperCase();
  const headers = new Headers(req.headers);

  if (method === 'GET' || method === 'HEAD') {
    return new Request(url, { method, headers });
  }

  const original = await req.text();
  const body = looksLikeJson(headers.get('content-type'), original)
    ? sanitizeJsonBody(original)
    : original;

  if (body === '') return new Request(url, { method, headers });

  // The incoming `Content-Length` describes the original body, which may be a
  // few bytes longer once a `userId` key is gone. Dropping it leaves the
  // reconstructed request self-consistent.
  headers.delete('content-length');
  return new Request(url, { method, headers, body });
}

/**
 * Wraps `handler` so the Auth_Token is verified and the User_Id derived before
 * the handler body runs, and so the derived User_Id is the only one reachable.
 *
 * `missing` and `invalid` both produce the single frozen 401 (Requirements 4.2,
 * 4.3, 4.6, 4.7); `unavailable` produces the 503 that leaves the Session
 * unchanged (Requirement 4.5).
 */
export function withAuth(
  handler: AuthenticatedHandler,
  opts?: WithAuthOptions,
): RouteHandler {
  const verifier =
    opts?.verifier ??
    (configuredAuthProvider() === 'logto'
      ? logtoAuthTokenVerifier
      : cognitoAuthTokenVerifier);
  const requireFreshRevocationCheck = opts?.freshRevocationCheck === true;

  return async function authenticatedRoute(req: Request, ctx?: RouteContext): Promise<Response> {
    const result = await verifier.verifyAuthToken(req, { requireFreshRevocationCheck });

    if (!result.ok) {
      // One identical 401 for `missing` and `invalid`; 503 only for a silent
      // Auth_Service. No branch here can carry a cause into the response.
      return result.kind === 'unavailable' ? serviceUnavailableResponse() : credentialErrorResponse();
    }

    const sanitized = await sanitizeRequest(req);
    const rawParams = await ctx?.params;
    const params = withoutUserId(rawParams ?? {});

    return handler(sanitized, { identity: result.identity, params });
  };
}
