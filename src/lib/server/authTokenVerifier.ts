/**
 * Auth token verification port (Requirement 4).
 *
 * This module is types only. It is the boundary that keeps route handlers from
 * ever importing `jose`, the certificate cache, or the Identity Toolkit client:
 * handlers depend on {@link AuthTokenVerifier}, and the concrete adapter lives
 * in `joseAuthTokenVerifier.ts` (layer 3 of the design's layering rules).
 *
 * The failure side of {@link VerifyResult} carries exactly three kinds, and the
 * split is driven by the distinct responses the requirements prescribe:
 *
 * - `missing`     → HTTP 401, "authentication is required" (Requirement 4.2)
 * - `invalid`     → HTTP 401, one single opaque message (Requirements 4.3, 4.6, 4.7)
 * - `unavailable` → HTTP 503, Session left unchanged (Requirement 4.5)
 *
 * Nothing finer than `invalid` is representable on purpose. An unparseable
 * token, a bad signature, an expiry more than 60 seconds in the past, a token
 * over 8,192 characters, a removed Account, and a revoked Session all collapse
 * to the same value, so no caller can build a response that distinguishes them
 * (Requirements 4.3, 4.6, 4.7).
 */

/**
 * The identity derived from a verified Auth_Token. Every field comes from a
 * verified claim; no field is ever read from a request body, query string, or
 * path (Requirement 4.4).
 */
export interface VerifiedIdentity {
  /** `sub` claim — the User_Id, and the only User_Id any handler may use. */
  userId: string;
  /** `auth_time` claim in milliseconds — drives the Requirement 11.5 re-auth window. */
  authTimeMs: number;
  /** `email` claim. */
  email: string;
  /** Display name derived from the token claims. */
  displayName: string;
  /**
   * Account creation time in milliseconds, as reported by the Auth_Service for
   * the verified `sub`. Absent when the Auth_Service supplied no creation time —
   * the data export then emits `accountCreatedAt` as `null` rather than omitting
   * the field (Requirements 10.2, 10.3). Never read from a request body, query
   * string, or path (Requirement 4.4).
   */
  accountCreatedAtMs?: number;
}

/**
 * Why verification did not yield an identity. Ordered as the verifier reaches
 * them, cheapest first.
 */
export type VerifyFailureKind =
  /** No `Authorization: Bearer <token>` header at all. */
  | 'missing'
  /** The credential is not usable, for any reason, with no detail as to which. */
  | 'invalid'
  /** The Auth_Service returned no result inside the 5-second, 2-attempt budget. */
  | 'unavailable';

/**
 * The outcome of verifying the Auth_Token on a request.
 */
export type VerifyResult =
  | { ok: true; identity: VerifiedIdentity }
  | { ok: false; kind: 'missing' }        // 401, Req 4.2
  | { ok: false; kind: 'invalid' }        // 401 single opaque message, Req 4.3/4.6/4.7
  | { ok: false; kind: 'unavailable' };   // 503, Req 4.5

/**
 * Options accepted per verification call.
 */
export interface VerifyAuthTokenOptions {
  /**
   * When set, the revocation and account-state lookup bypasses its 5-minute
   * cache so a removed Account or revoked Session is observed immediately
   * (Requirement 4.6). Mutating routes and the account routes set this; list
   * and read paths tolerate the cached answer.
   */
  requireFreshRevocationCheck?: boolean;
}

/**
 * The port every authenticated route handler depends on. Implementations must
 * verify the token signature and expiry and derive the User_Id *before* any
 * read or write against the Meal_Plan_Store is possible (Requirement 4.1),
 * which is why the only way to obtain a User_Id is through the resolved
 * {@link VerifiedIdentity}.
 */
export interface AuthTokenVerifier {
  /**
   * Reads the Auth_Token from `req` and resolves to the derived identity, or to
   * the reason no identity could be derived. Never throws for an unusable
   * credential: an unusable credential is a `{ ok: false }` value, so no caller
   * can accidentally treat a thrown error as a transport failure.
   */
  verifyAuthToken(req: Request, opts?: VerifyAuthTokenOptions): Promise<VerifyResult>;
}
