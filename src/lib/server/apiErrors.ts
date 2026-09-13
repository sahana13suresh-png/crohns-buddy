/**
 * Every failure response the Meal_Plan_API and the account routes can produce.
 *
 * One module owns the whole taxonomy from the design's Error Handling table, so
 * a route handler picks a builder rather than assembling a status, a body, and
 * headers of its own. Two rules from that table are what shape this file:
 *
 * 1. **The credential and ownership bodies are module-level frozen constants.**
 *    A 401 is byte-identical for an absent token, a malformed one, a bad
 *    signature, an expired one, an oversized one, and a revoked Session
 *    (Requirements 4.2, 4.3, 4.6, 4.7). A 404 is byte-identical for an id owned
 *    by another Account, an id that exists nowhere, and a malformed id
 *    (Requirements 7.3, 7.4, 7.8). Because the bytes are serialized once from a
 *    frozen object, no future edit at a call site can make two causes
 *    distinguishable — and the two indistinguishability properties (Property 6
 *    and Property 7) assert on these constants directly.
 * 2. **A client-validation message names the field and never echoes the value.**
 *    Requirements 5.15 and 9.8 want the field or collection at fault identified;
 *    the submitted value is Meal_Plan content, which must not travel back out
 *    through an error body any more than it may reach a log line.
 *
 * Nothing here logs. Store outcomes go through `logStoreOp`, whose closed
 * parameter type cannot carry content; {@link storeFailureCategoryFor} exists so
 * a handler can derive the category for that log entry from the same taxonomy
 * that chose the status.
 */

import type { MealPlanItemError, MealPlanValidationError } from '../mealPlanSerializer';
import type { StoreFailureCategory } from './storeLog';
import type { SaveOutcome } from './mealPlanRepository';

// ─── Body shape ────────────────────────────────────────────────────────────────

/** Machine-readable code carried by every failure body. */
export type ApiErrorCode =
  | 'UNAUTHENTICATED'
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'STORAGE_ACK_REQUIRED'
  | 'PLAN_LIMIT_REACHED'
  | 'PLAN_TOO_LARGE'
  | 'PLAN_UNREADABLE'
  | 'DELETION_INCOMPLETE'
  | 'SERVICE_UNAVAILABLE';

/**
 * The only shape a failure body takes. `field` appears solely on the validation
 * body, and holds a field path such as `content.meals[2].items[0].portion` —
 * never a submitted value.
 */
export interface ApiErrorBody {
  error: ApiErrorCode;
  message: string;
  field?: string;
}

// ─── Frozen bodies ─────────────────────────────────────────────────────────────

/**
 * The one and only 401 body. Absent token, malformed token, bad signature,
 * expired token, oversized token, removed Account, and revoked Session all
 * return exactly this (Requirements 4.2, 4.3, 4.6, 4.7).
 */
export const CREDENTIAL_ERROR_BODY: Readonly<ApiErrorBody> = Object.freeze({
  error: 'UNAUTHENTICATED',
  message:
    'Authentication is required. The credential supplied with this request is missing or not valid.',
} as ApiErrorBody);

/**
 * The one and only 404 body. A Meal_Plan_Id owned by a different Account, one
 * that exists under no Account, and one that is empty, over 64 characters, or
 * outside the letters-digits-hyphens charset all return exactly this, carrying
 * no title, content, timestamp, or owner identity (Requirements 7.3, 7.4, 7.8).
 */
export const NOT_FOUND_BODY: Readonly<ApiErrorBody> = Object.freeze({
  error: 'NOT_FOUND',
  message: 'That meal plan was not found.',
} as ApiErrorBody);

/**
 * The 409 body for the 100-record cap. The guidance Requirement 5.9 asks for is
 * actionable, so unlike the ownership 404 it says what to do about it.
 */
export const PLAN_LIMIT_REACHED_BODY: Readonly<ApiErrorBody> = Object.freeze({
  error: 'PLAN_LIMIT_REACHED',
  message:
    'You have reached the limit of 100 saved meal plans. Delete an existing saved meal plan before saving another.',
} as ApiErrorBody);

/** The 413 body for a serialized Meal_Plan over 100 kilobytes (Requirement 5.7). */
export const PLAN_TOO_LARGE_BODY: Readonly<ApiErrorBody> = Object.freeze({
  error: 'PLAN_TOO_LARGE',
  message: 'That meal plan is too large to save.',
} as ApiErrorBody);

/**
 * The 422 body for a stored item the Meal_Plan_Deserializer refuses
 * (Requirement 6.9). The attribute at fault is named by the thrown
 * `MealPlanItemError` and belongs in the store log, not in the response: the
 * Patient can do nothing with it, and the stored record is left unchanged.
 */
export const PLAN_UNREADABLE_BODY: Readonly<ApiErrorBody> = Object.freeze({
  error: 'PLAN_UNREADABLE',
  message: 'That saved meal plan cannot be opened.',
} as ApiErrorBody);

/**
 * The 428 body returned when the save transaction's acknowledgment condition
 * fails. The code is what the client keys on to raise the storage notice
 * (Requirements 12.3, 12.5); no Meal_Plan_Record was written.
 */
export const STORAGE_ACK_REQUIRED_BODY: Readonly<ApiErrorBody> = Object.freeze({
  error: 'STORAGE_ACK_REQUIRED',
  message:
    'Saving requires acknowledging the notice about storing health-related meal plan data in the cloud.',
} as ApiErrorBody);

/**
 * The 500 body for a purge that did not finish before the Account was removed.
 * Requirement 11.9 leaves the Account and every remaining Meal_Plan_Record
 * intact and the Session active, so the message offers a restart rather than
 * reporting a partial success.
 */
export const DELETION_INCOMPLETE_BODY: Readonly<ApiErrorBody> = Object.freeze({
  error: 'DELETION_INCOMPLETE',
  message: 'The deletion did not complete. Nothing was removed. You can start the deletion again.',
} as ApiErrorBody);

/**
 * The 503 body, shared by a silent Auth_Service and an unreachable or throttled
 * Meal_Plan_Store. Distinct from the 401 on purpose: Requirement 4.5 requires
 * the Session be left unchanged so a later request with the same Auth_Token can
 * succeed, and a client that saw a 401 would sign the Patient out over a
 * transient outage.
 */
export const SERVICE_UNAVAILABLE_BODY: Readonly<ApiErrorBody> = Object.freeze({
  error: 'SERVICE_UNAVAILABLE',
  message: 'The service is temporarily unavailable. Please try again.',
} as ApiErrorBody);

// ─── Serialized bytes and headers ──────────────────────────────────────────────

/**
 * Serialized once per constant, so every response for a given class carries
 * identical bytes no matter which call site produced it.
 */
const CREDENTIAL_ERROR_JSON = JSON.stringify(CREDENTIAL_ERROR_BODY);
const NOT_FOUND_JSON = JSON.stringify(NOT_FOUND_BODY);
const PLAN_LIMIT_REACHED_JSON = JSON.stringify(PLAN_LIMIT_REACHED_BODY);
const PLAN_TOO_LARGE_JSON = JSON.stringify(PLAN_TOO_LARGE_BODY);
const PLAN_UNREADABLE_JSON = JSON.stringify(PLAN_UNREADABLE_BODY);
const STORAGE_ACK_REQUIRED_JSON = JSON.stringify(STORAGE_ACK_REQUIRED_BODY);
const DELETION_INCOMPLETE_JSON = JSON.stringify(DELETION_INCOMPLETE_BODY);
const SERVICE_UNAVAILABLE_JSON = JSON.stringify(SERVICE_UNAVAILABLE_BODY);

/**
 * Headers are part of what must not vary between causes, so they are fixed here
 * too — no timestamps, no request ids, nothing derived from the request.
 */
const JSON_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
});

/** One response builder, so every failure shares the same header set. */
function errorResponse(status: number, json: string, extraHeaders?: Record<string, string>): Response {
  return new Response(json, {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

// ─── Response builders ─────────────────────────────────────────────────────────

/**
 * HTTP 401 for every credential failure. Byte-identical for every cause
 * (Requirements 4.2, 4.3, 4.6, 4.7).
 */
export function credentialErrorResponse(): Response {
  return errorResponse(401, CREDENTIAL_ERROR_JSON, { 'WWW-Authenticate': 'Bearer' });
}

/**
 * HTTP 404 for every unusable Meal_Plan_Id reference — owned elsewhere, existing
 * nowhere, or malformed. Byte-identical across all three, and for a malformed id
 * it is returned before the Meal_Plan_Store is touched at all (Requirements 7.3,
 * 7.4, 7.8, 8.7).
 */
export function notFoundResponse(): Response {
  return errorResponse(404, NOT_FOUND_JSON);
}

/**
 * HTTP 400 for a request the Patient can correct: a bound violated, a Meal_Plan
 * with no meals, a title out of range, a malformed cursor.
 *
 * @param field - Field or collection at fault, as a path such as `content.meals`
 *   or `content.meals[0].items[3].portion`. Never a submitted value.
 * @param bound - Optional description of the bound that was violated, for
 *   example `1 to 100 characters`. Describes the rule, not the input.
 */
export function validationErrorResponse(field: string, bound?: string): Response {
  const message =
    bound === undefined
      ? `Request field "${field}" is not valid.`
      : `Request field "${field}" is not within its permitted bound (${bound}).`;

  const body: ApiErrorBody = { error: 'VALIDATION_FAILED', message, field };
  return errorResponse(400, JSON.stringify(body));
}

/**
 * HTTP 400 from a {@link MealPlanValidationError} thrown by the
 * Meal_Plan_Serializer (Requirements 5.15, 9.8). The error already names the
 * field and its bound and carries no field value, so both travel out unchanged.
 */
export function mealPlanValidationErrorResponse(error: MealPlanValidationError): Response {
  return validationErrorResponse(error.field, error.bound);
}

/** HTTP 409 when the Account already holds 100 Meal_Plan_Records (Requirement 5.9). */
export function planLimitReachedResponse(): Response {
  return errorResponse(409, PLAN_LIMIT_REACHED_JSON);
}

/**
 * HTTP 413 when a serialized Meal_Plan exceeds 100 kilobytes (Requirement 5.7).
 * The size check runs before any write, so nothing was stored.
 */
export function planTooLargeResponse(): Response {
  return errorResponse(413, PLAN_TOO_LARGE_JSON);
}

/**
 * HTTP 422 when the Meal_Plan_Deserializer signals an error for a stored record
 * (Requirement 6.9). The record is left unmodified.
 *
 * The `MealPlanItemError` is accepted, and deliberately unused in the body, so a
 * call site cannot mistake this for a builder that reports the attribute to the
 * browser; the attribute belongs in the store log entry instead.
 */
export function planUnreadableResponse(_error?: MealPlanItemError): Response {
  return errorResponse(422, PLAN_UNREADABLE_JSON);
}

/**
 * HTTP 428 when a save carried no acknowledgment of the storage notice and the
 * Account holds none on record. The transaction rolled back, so no
 * Meal_Plan_Record was written (Requirements 12.3, 12.5).
 */
export function storageAckRequiredResponse(): Response {
  return errorResponse(428, STORAGE_ACK_REQUIRED_JSON);
}

/**
 * HTTP 500 when a purge failed before the Account was removed from the
 * Auth_Service (Requirement 11.9). The Account, every remaining
 * Meal_Plan_Record, and the Session are all intact.
 */
export function deletionIncompleteResponse(): Response {
  return errorResponse(500, DELETION_INCOMPLETE_JSON);
}

/**
 * HTTP 503 when the Auth_Service returned no result inside its 5-second,
 * 2-attempt budget (Requirement 4.5), or when the Meal_Plan_Store was throttled
 * or unreachable. The Session is left unchanged either way.
 */
export function serviceUnavailableResponse(): Response {
  return errorResponse(503, SERVICE_UNAVAILABLE_JSON);
}

// ─── Outcome mapping ───────────────────────────────────────────────────────────

/** The {@link SaveOutcome} kinds that are failures rather than successes. */
export type SaveFailureKind = Extract<
  SaveOutcome,
  { kind: 'cap-reached' | 'ack-required' | 'not-found' }
>['kind'];

/**
 * Maps a failing {@link SaveOutcome} to its response, so `create`, `update`, and
 * `rename` handlers share one mapping instead of three switch statements that
 * could drift: `cap-reached` → 409 (5.9), `ack-required` → 428 (12.3),
 * `not-found` → the frozen 404 (7.3, 7.4).
 */
export function saveFailureResponse(kind: SaveFailureKind): Response {
  switch (kind) {
    case 'cap-reached':
      return planLimitReachedResponse();
    case 'ack-required':
      return storageAckRequiredResponse();
    case 'not-found':
      return notFoundResponse();
    default: {
      // A new failure kind on SaveOutcome makes this a compile error rather than
      // a silent fall-through to some default status.
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/**
 * The `logStoreOp` failure category that belongs with a given failure code, per
 * the design's Error Handling table. `undefined` means the class emits no store
 * log entry at all: a credential failure never reaches store logging, and
 * neither does a silent Auth_Service.
 *
 * A store failure reported as 503 is `unavailable` here; a handler that knows
 * the cause was throttling logs `throttled` instead.
 */
export function storeFailureCategoryFor(code: ApiErrorCode): StoreFailureCategory | undefined {
  switch (code) {
    case 'NOT_FOUND':
      return 'not-found';
    case 'PLAN_LIMIT_REACHED':
      return 'cap';
    case 'PLAN_TOO_LARGE':
      return 'size';
    case 'VALIDATION_FAILED':
    case 'STORAGE_ACK_REQUIRED':
    case 'PLAN_UNREADABLE':
      return 'validation';
    case 'SERVICE_UNAVAILABLE':
    case 'DELETION_INCOMPLETE':
      return 'unavailable';
    case 'UNAUTHENTICATED':
      return undefined;
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}
