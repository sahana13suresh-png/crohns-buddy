/**
 * Meal_Plan_Id generation and validation.
 *
 * A Meal_Plan_Id is a ULID: 26 Crockford base-32 characters whose leading 48
 * bits are the creation time in milliseconds and whose trailing 80 bits are
 * random. Because a ULID is lexicographically sortable, the DynamoDB sort key
 * alone gives newest-first ordering with a stable tie-break for records created
 * in the same millisecond (Requirements 6.2, 7.1).
 *
 * This module is pure domain logic: it performs no I/O and reads no clock. The
 * creation timestamp is always injected by the caller so ordering behavior is
 * deterministic under test.
 */

import { decodeTime, ulid } from 'ulid';

/** Largest millisecond timestamp a 48-bit ULID time component can hold. */
const MAX_TIMESTAMP_MS = 2 ** 48 - 1;

/** Number of characters in a ULID. */
const ULID_LENGTH = 26;

/** Longest accepted Meal_Plan_Id, per Requirement 7.8. */
const MAX_MEAL_PLAN_ID_LENGTH = 64;

/**
 * Accepted Meal_Plan_Id shape: 1 to 64 characters drawn solely from ASCII
 * letters, digits, and hyphens (Requirement 7.8). Reserved keys such as `#meta`
 * and `PENDING#DELETION` contain `#` and so are rejected before any store
 * access, which is what keeps a crafted id from addressing them.
 */
const MEAL_PLAN_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Generates a new Meal_Plan_Id from the supplied creation timestamp.
 *
 * The timestamp is injected rather than read from `Date.now()` so that the
 * embedded time component — and therefore the resulting order of ids — is
 * deterministic.
 *
 * @param nowMs Creation time in milliseconds since the Unix epoch. Must be a
 *   non-negative integer no greater than 2^48 - 1.
 * @returns A 26-character Crockford base-32 ULID.
 * @throws {RangeError} When `nowMs` is not a representable millisecond value.
 */
export function newMealPlanId(nowMs: number): string {
  if (!Number.isInteger(nowMs)) {
    throw new RangeError('newMealPlanId: nowMs must be an integer millisecond timestamp');
  }
  if (nowMs < 0 || nowMs > MAX_TIMESTAMP_MS) {
    throw new RangeError(`newMealPlanId: nowMs must be between 0 and ${MAX_TIMESTAMP_MS}`);
  }
  return ulid(nowMs);
}

/**
 * Reports whether a value is usable as a Meal_Plan_Id reference.
 *
 * Callers check this before touching the Meal_Plan_Store so that a malformed id
 * produces the same response as an id owned by another Account, with no read or
 * write performed (Requirement 7.8).
 *
 * @param id Candidate value from a request path, query, or cursor.
 * @returns `true` only for a non-empty string of at most 64 characters
 *   containing solely ASCII letters, digits, and hyphens.
 */
export function isValidMealPlanId(id: unknown): boolean {
  if (typeof id !== 'string') return false;
  if (id.length === 0 || id.length > MAX_MEAL_PLAN_ID_LENGTH) return false;
  return MEAL_PLAN_ID_PATTERN.test(id);
}

/**
 * Extracts the creation timestamp embedded in the leading 48 bits of a ULID
 * Meal_Plan_Id.
 *
 * Used to assert that a stored record's `createdAt` agrees with its id, keeping
 * the sort-key ordering guarantee from silently drifting.
 *
 * @param id A 26-character Crockford base-32 ULID.
 * @returns Milliseconds since the Unix epoch.
 * @throws {RangeError} When `id` is not a well-formed ULID.
 */
export function mealPlanIdTimestampMs(id: string): number {
  if (typeof id !== 'string' || id.length !== ULID_LENGTH) {
    throw new RangeError('mealPlanIdTimestampMs: id must be a 26-character ULID');
  }
  try {
    return decodeTime(id);
  } catch {
    throw new RangeError('mealPlanIdTimestampMs: id must be a 26-character ULID');
  }
}
