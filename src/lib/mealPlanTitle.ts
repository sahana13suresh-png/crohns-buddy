/**
 * Meal_Plan_Record title normalization and client-side rename validation.
 *
 * Pure domain module: no I/O, no clock. The creation timestamp is always injected
 * so the default title is reproducible.
 *
 * Length is measured in Unicode code points, not UTF-16 code units, so an astral-plane
 * character (an emoji, for example) is never split into a broken half by truncation.
 */

/** Maximum stored title length, measured in Unicode code points. */
export const MAX_TITLE_CODE_POINTS = 100;

/** Minimum stored title length, measured in Unicode code points. */
export const MIN_TITLE_CODE_POINTS = 1;

/** Prefix of the generated default title, followed by an em dash and the UTC creation date. */
export const DEFAULT_TITLE_PREFIX = 'Meal plan';

/** Widest millisecond value a JavaScript Date can represent (±100,000,000 days from the epoch). */
const MAX_TIME_VALUE = 8.64e15;

/** Result of validating a Patient-supplied rename value. */
export type RenameTitleValidation = { ok: true; title: string } | { ok: false };

/** Left-pads a non-negative integer to the requested width with zeros. */
function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * Formats a millisecond timestamp as a UTC calendar date, `YYYY-MM-DD`.
 *
 * Non-finite values and values outside the representable Date range are clamped
 * rather than rejected, so this never yields `Invalid Date` and never yields an
 * empty string.
 */
function formatUtcDate(ms: number): string {
  const safeMs = Number.isFinite(ms)
    ? Math.min(Math.max(Math.trunc(ms), -MAX_TIME_VALUE), MAX_TIME_VALUE)
    : 0;
  const date = new Date(safeMs);
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(
    date.getUTCDate(),
    2
  )}`;
}

/** The default title for a Meal_Plan_Record created at `createdAtMs`. */
export function defaultTitle(createdAtMs: number): string {
  return `${DEFAULT_TITLE_PREFIX} — ${formatUtcDate(createdAtMs)}`;
}

/** Truncates to the first `MAX_TITLE_CODE_POINTS` code points, leaving shorter values untouched. */
function truncateToBound(value: string): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= MAX_TITLE_CODE_POINTS) {
    return value;
  }
  return codePoints.slice(0, MAX_TITLE_CODE_POINTS).join('');
}

/**
 * Normalizes a supplied title into the value stored on the Meal_Plan_Record.
 *
 * - Leading and trailing whitespace is removed.
 * - An absent or whitespace-only title becomes `Meal plan — YYYY-MM-DD`, formed from
 *   the UTC creation date.
 * - A trimmed value longer than 100 code points is truncated to its first 100.
 *
 * The result is never empty and never exceeds 100 code points.
 *
 * @param supplied - The title from the save request, if any
 * @param createdAtMs - The Meal_Plan_Record creation timestamp in milliseconds since the epoch
 */
export function normalizeTitle(supplied: string | undefined, createdAtMs: number): string {
  if (typeof supplied !== 'string') {
    return defaultTitle(createdAtMs);
  }

  const trimmed = supplied.trim();
  if (trimmed.length === 0) {
    return defaultTitle(createdAtMs);
  }

  return truncateToBound(trimmed);
}

/**
 * Validates a Patient-supplied rename value before any request is sent.
 *
 * A trimmed value of 1 to 100 code points is accepted and returned trimmed. An empty
 * or over-long value is rejected, so the rename never reaches the Meal_Plan_API.
 */
export function validateRenameTitle(supplied: string): RenameTitleValidation {
  if (typeof supplied !== 'string') {
    return { ok: false };
  }

  const trimmed = supplied.trim();
  const length = Array.from(trimmed).length;
  if (length < MIN_TITLE_CODE_POINTS || length > MAX_TITLE_CODE_POINTS) {
    return { ok: false };
  }

  return { ok: true, title: trimmed };
}
