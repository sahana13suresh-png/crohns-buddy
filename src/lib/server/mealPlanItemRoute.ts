/**
 * Handlers for `/api/meal-plans/{mealPlanId}` — read, update, rename, delete.
 *
 * The handlers live here rather than in the route file so the repository, the
 * clock, and the token verifier can all be injected: the indistinguishability
 * property for unusable Meal_Plan_Id references drives these same handlers over
 * the in-memory repository, and a route file may export nothing but its HTTP
 * methods and its segment config.
 *
 * Four rules shape every handler below:
 *
 * 1. **The path id is validated before the Meal_Plan_Store is reached.** An id
 *    that is empty, over 64 characters, or outside the letters-digits-hyphens
 *    charset returns the frozen 404 constant with no read and no write performed
 *    (Requirement 7.8). An id that passes the charset check but is not a ULID
 *    cannot name a stored record — every stored Meal_Plan_Id is a ULID the
 *    Meal_Plan_API assigned — so on the mutating paths it returns that same
 *    frozen 404 rather than a validation error that would tell a caller its id
 *    was merely the wrong shape.
 * 2. **Every store operation is key-scoped to `ctx.identity.userId`.** That is
 *    the only User_Id reachable here: `withAuth` has already stripped any
 *    supplied one from the body, the query, and the params (Requirements 4.4,
 *    7.2, 7.7). An id owned by another Account therefore reads as absent, which
 *    is why owned-elsewhere and nonexistent produce identical responses
 *    (Requirements 7.3, 7.4).
 * 3. **Nothing is logged from here.** The repository emits exactly one
 *    `logStoreOp` line per store operation, so a second line from the route
 *    would double-count it — and a path id that failed validation is
 *    unvalidated input that has no business in a log line at all
 *    (Requirement 7.6).
 * 4. **`PUT`, `PATCH`, and `DELETE` verify with `freshRevocationCheck: true`**,
 *    so a removed Account or a revoked Session is observed immediately rather
 *    than through the verifier's 5-minute cache (Requirement 4.6). `GET`
 *    tolerates the cached answer.
 */

import { isValidMealPlanId, mealPlanIdTimestampMs } from '../mealPlanId';
import {
  MAX_SERIALIZED_BYTES,
  MealPlanItemError,
  MealPlanValidationError,
  serializeMealPlanRecord,
  serializedByteLength,
} from '../mealPlanSerializer';
import {
  MAX_TITLE_CODE_POINTS,
  MIN_TITLE_CODE_POINTS,
  normalizeTitle,
  validateRenameTitle,
} from '../mealPlanTitle';
import type { MealPlanContent, MealPlanRecord } from '../types';
import {
  mealPlanValidationErrorResponse,
  notFoundResponse,
  planTooLargeResponse,
  planUnreadableResponse,
  saveFailureResponse,
  serviceUnavailableResponse,
  validationErrorResponse,
  type SaveFailureKind,
} from './apiErrors';
import type { AuthTokenVerifier } from './authTokenVerifier';
import type { Clock, MealPlanRepository, SaveOutcome } from './mealPlanRepository';
import { withAuth, type RouteHandler } from './withAuth';

// ─── Construction ──────────────────────────────────────────────────────────────

/** What the handlers need from outside. Only `repository` has no sensible default. */
export interface MealPlanItemRouteDeps {
  /** The Meal_Plan_Store port. Every call is scoped to the derived User_Id. */
  repository: MealPlanRepository;
  /**
   * Current time in epoch milliseconds, used for `updatedAt`. Injected so the
   * timestamp behavior Requirements 5.3 and 8.4 constrain is deterministic under
   * test.
   */
  now?: Clock;
  /** Substitutes the {@link AuthTokenVerifier}; defaults to the `jose` adapter. */
  verifier?: AuthTokenVerifier;
}

/** The four HTTP methods this path serves. */
export interface MealPlanItemRouteHandlers {
  GET: RouteHandler;
  PUT: RouteHandler;
  PATCH: RouteHandler;
  DELETE: RouteHandler;
}

// ─── Shared helpers ────────────────────────────────────────────────────────────

/**
 * Headers on every success response. `no-store` keeps a stored Meal_Plan — health
 * related personal data — out of shared caches.
 */
const JSON_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
});

/** One success-response builder, so every success shares the same header set. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS } });
}

/** ISO-8601 UTC with exactly three fractional digits, matching every stored timestamp. */
function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

/** The title bound as the validation body reports it. */
const TITLE_BOUND = `${MIN_TITLE_CODE_POINTS} to ${MAX_TITLE_CODE_POINTS} characters`;

/**
 * The creation timestamp a stored record under `mealPlanId` must carry, or
 * `undefined` when the id is not a ULID and so names no storable record.
 *
 * `PUT` needs `createdAt` to build the record it serializes, and Requirement 5.3
 * requires the stored value be preserved. Taking it from the id's own embedded
 * millisecond timestamp — which the serializer guarantees equals the stored
 * `createdAt` — avoids a read purely to learn a value the id already carries.
 */
function createdAtMsOf(mealPlanId: string): number | undefined {
  try {
    return mealPlanIdTimestampMs(mealPlanId);
  } catch {
    return undefined;
  }
}

/** A parsed JSON object body, or the response that rejects it. */
type ParsedBody = { ok: true; body: Record<string, unknown> } | { ok: false; response: Response };

/**
 * Reads the request body as a JSON object.
 *
 * A body that is not JSON, or that is JSON but not an object, is a request the
 * Patient's client can correct, so it names the field at fault and echoes none of
 * the submitted value (Requirement 9.8).
 */
async function parseJsonObjectBody(req: Request): Promise<ParsedBody> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return { ok: false, response: validationErrorResponse('body', 'a JSON object') };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, response: validationErrorResponse('body', 'a JSON object') };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

/**
 * Maps a thrown store or serializer error to its response.
 *
 * `MealPlanValidationError` names the field and its bound and carries no value, so
 * both travel out as a 400 (Requirements 5.15, 9.8). The adapter's own
 * `MealPlanTooLargeError` is its copy of the size guard, reached only if a caller
 * above it skipped the check (Requirement 5.7); it is recognized by name rather
 * than by class so this module never imports the AWS SDK. Everything else is the
 * Meal_Plan_Store being throttled or unreachable, which is a 503 that leaves the
 * Session unchanged.
 */
function storeErrorResponse(error: unknown): Response {
  if (error instanceof MealPlanValidationError) return mealPlanValidationErrorResponse(error);
  if ((error as { name?: unknown } | null)?.name === 'MealPlanTooLargeError') {
    return planTooLargeResponse();
  }
  return serviceUnavailableResponse();
}

/** Whether a {@link SaveOutcome} kind is one of the failures. */
function isSaveFailure(outcome: SaveOutcome): outcome is Extract<SaveOutcome, { kind: SaveFailureKind }> {
  return outcome.kind !== 'created' && outcome.kind !== 'updated';
}

// ─── Factory ───────────────────────────────────────────────────────────────────

/**
 * Builds the `GET`, `PUT`, `PATCH`, and `DELETE` handlers for one Meal_Plan_Record.
 */
export function createMealPlanItemRouteHandlers(
  deps: MealPlanItemRouteDeps
): MealPlanItemRouteHandlers {
  const { repository } = deps;
  const now: Clock = deps.now ?? (() => Date.now());
  const verifierOption = deps.verifier === undefined ? {} : { verifier: deps.verifier };

  /**
   * Reads one Meal_Plan_Record (Requirement 6.4).
   *
   * A stored item the Meal_Plan_Deserializer refuses becomes a 422 carrying
   * cannot-open guidance and no attribute detail, and the stored record is left
   * exactly as it was — the read performed no write (Requirement 6.9).
   */
  const GET = withAuth(async (req, ctx) => {
    const mealPlanId = ctx.params.mealPlanId;
    if (!isValidMealPlanId(mealPlanId)) return notFoundResponse();

    let record: MealPlanRecord | null;
    try {
      record = await repository.get(ctx.identity.userId, mealPlanId);
    } catch (error) {
      if (error instanceof MealPlanItemError) return planUnreadableResponse(error);
      return storeErrorResponse(error);
    }

    // Absent under this Account, whether it exists under another Account or under
    // none at all (Requirements 7.3, 7.4).
    if (record === null) return notFoundResponse();

    return jsonResponse(200, { record });
  }, { ...verifierOption });

  /**
   * Replaces the content and title of an existing Meal_Plan_Record, setting
   * `updatedAt` to the time the request is processed while `mealPlanId` and
   * `createdAt` are preserved (Requirements 5.3, 5.4).
   *
   * The 100 kilobyte ceiling is checked here, before the repository is called at
   * all, so an oversized plan produces a 413 with nothing written
   * (Requirement 5.7).
   */
  const PUT = withAuth(async (req, ctx) => {
    const mealPlanId = ctx.params.mealPlanId;
    if (!isValidMealPlanId(mealPlanId)) return notFoundResponse();

    const parsed = await parseJsonObjectBody(req);
    if (!parsed.ok) return parsed.response;

    // A charset-valid id that is not a ULID names no storable record, so it gets
    // the same frozen 404 an id owned elsewhere gets rather than a 400 that would
    // reveal the id's shape (Requirements 7.3, 7.4).
    const createdAtMs = createdAtMsOf(mealPlanId);
    if (createdAtMs === undefined) return notFoundResponse();

    const suppliedTitle = parsed.body.title;
    const record: MealPlanRecord = {
      userId: ctx.identity.userId,
      mealPlanId,
      // Over-long titles are truncated to their first 100 characters rather than
      // rejected (Requirement 5.14); an absent or blank one becomes the default
      // built from the creation date (Requirement 5.5).
      title: normalizeTitle(
        typeof suppliedTitle === 'string' ? suppliedTitle : undefined,
        createdAtMs
      ),
      createdAt: isoOf(createdAtMs),
      updatedAt: isoOf(now()),
      content: parsed.body.content as MealPlanContent,
    };

    // Serializing first means a plan with no meals, or one violating any other
    // bound, is reported as a 400 naming the field with no write attempted
    // (Requirements 5.15, 9.8).
    let outcome: SaveOutcome;
    try {
      const item = serializeMealPlanRecord(record);
      if (serializedByteLength(item) > MAX_SERIALIZED_BYTES) return planTooLargeResponse();

      outcome = await repository.update(ctx.identity.userId, record);
    } catch (error) {
      return storeErrorResponse(error);
    }

    if (isSaveFailure(outcome)) return saveFailureResponse(outcome.kind);

    return jsonResponse(200, { mealPlanId, updatedAt: record.updatedAt });
  }, { ...verifierOption, freshRevocationCheck: true });

  /**
   * Renames an existing Meal_Plan_Record, storing the whitespace-trimmed title and
   * setting `updatedAt` while the Meal_Plan content is left untouched
   * (Requirement 8.4).
   */
  const PATCH = withAuth(async (req, ctx) => {
    const mealPlanId = ctx.params.mealPlanId;
    if (!isValidMealPlanId(mealPlanId)) return notFoundResponse();

    const parsed = await parseJsonObjectBody(req);
    if (!parsed.ok) return parsed.response;

    const supplied = parsed.body.title;
    if (typeof supplied !== 'string') {
      return validationErrorResponse('title', TITLE_BOUND);
    }
    // A rename is not a save: an empty or over-long title is rejected rather than
    // defaulted or truncated, so the stored title stays as it was
    // (Requirements 8.4, 8.6).
    const validated = validateRenameTitle(supplied);
    if (!validated.ok) return validationErrorResponse('title', TITLE_BOUND);

    const updatedAtMs = now();
    let outcome: SaveOutcome;
    try {
      outcome = await repository.rename(
        ctx.identity.userId,
        mealPlanId,
        validated.title,
        updatedAtMs
      );
    } catch (error) {
      return storeErrorResponse(error);
    }

    if (isSaveFailure(outcome)) return saveFailureResponse(outcome.kind);

    return jsonResponse(200, { title: validated.title, updatedAt: isoOf(updatedAtMs) });
  }, { ...verifierOption, freshRevocationCheck: true });

  /**
   * Removes one Meal_Plan_Record (Requirement 8.1).
   *
   * The response is 204 whether or not the Account still held the record, so a
   * repeated deletion reports the same success and every other Meal_Plan_Record is
   * left unchanged (Requirement 8.3).
   */
  const DELETE = withAuth(async (req, ctx) => {
    const mealPlanId = ctx.params.mealPlanId;
    if (!isValidMealPlanId(mealPlanId)) return notFoundResponse();

    try {
      await repository.delete(ctx.identity.userId, mealPlanId);
    } catch (error) {
      return storeErrorResponse(error);
    }

    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  }, { ...verifierOption, freshRevocationCheck: true });

  return { GET, PUT, PATCH, DELETE };
}
