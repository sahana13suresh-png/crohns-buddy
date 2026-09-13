/**
 * Continuation-token (cursor) encoding for paged Meal_Plan_Record listings.
 *
 * The cursor is `base64url(JSON.stringify({ v: 1, sk: lastMealPlanId }))`. It carries
 * only the sort key of the last record on the page just returned. The partition-key
 * half of the store's exclusive start key — the User_Id — is never encoded and is
 * always re-derived from the verified Auth_Token on the next request, so a cursor
 * lifted from another Account is inert: it names a sort-key position within the
 * caller's own partition and nothing more (Requirements 6.3, 6.8).
 *
 * Pure domain module: no I/O, no clock, no randomness. It runs unchanged in the Node
 * runtime and in the browser bundle, so it avoids `Buffer`, `atob`/`btoa`, and
 * `TextEncoder`/`TextDecoder`, using a self-contained base64url codec instead. A
 * well-formed cursor is ASCII-only by construction, so a payload byte outside ASCII
 * is treated as malformed rather than decoded.
 */

import { isValidMealPlanId } from './mealPlanId';

/** The only cursor version this module produces or accepts. */
export const CURSOR_VERSION = 1;

/**
 * Longest cursor accepted before any decoding work is done. A cursor for the longest
 * legal Meal_Plan_Id (64 characters, Requirement 7.8) is about 112 characters, so this
 * leaves generous headroom while bounding the work a crafted query string can cause.
 */
const MAX_CURSOR_LENGTH = 256;

/** Result of decoding a supplied cursor. */
export type CursorDecode = { ok: true; sk: string } | { ok: false };

/** Base64url alphabet (RFC 4648 §5): `-` and `_` replace `+` and `/`, padding omitted. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Reverse lookup for {@link ALPHABET}; `-1` marks a character outside the alphabet. */
const REVERSE: Record<string, number> = (() => {
  const table: Record<string, number> = {};
  for (let i = 0; i < ALPHABET.length; i += 1) {
    table[ALPHABET.charAt(i)] = i;
  }
  return table;
})();

/** Encodes ASCII text as unpadded base64url. */
function encodeBase64Url(ascii: string): string {
  let out = '';

  for (let i = 0; i < ascii.length; i += 3) {
    const b0 = ascii.charCodeAt(i);
    const has1 = i + 1 < ascii.length;
    const has2 = i + 2 < ascii.length;
    const b1 = has1 ? ascii.charCodeAt(i + 1) : 0;
    const b2 = has2 ? ascii.charCodeAt(i + 2) : 0;

    out += ALPHABET.charAt(b0 >> 2);
    out += ALPHABET.charAt(((b0 & 0x03) << 4) | (b1 >> 4));
    if (has1) {
      out += ALPHABET.charAt(((b1 & 0x0f) << 2) | (b2 >> 6));
    }
    if (has2) {
      out += ALPHABET.charAt(b2 & 0x3f);
    }
  }

  return out;
}

/**
 * Decodes unpadded base64url back to ASCII text.
 *
 * Returns `null` for any input that a well-formed cursor could not have produced: a
 * character outside the alphabet (padding `=` included), a length leaving a single
 * orphan character, non-zero bits left over in the final group, or a decoded byte
 * outside ASCII.
 */
function decodeBase64Url(encoded: string): string | null {
  if (encoded.length % 4 === 1) return null;

  let out = '';
  let buffer = 0;
  let bits = 0;

  for (let i = 0; i < encoded.length; i += 1) {
    const value = REVERSE[encoded.charAt(i)];
    if (value === undefined) return null;

    buffer = (buffer << 6) | value;
    bits += 6;

    if (bits >= 8) {
      bits -= 8;
      const byte = (buffer >> bits) & 0xff;
      if (byte > 0x7f) return null;
      out += String.fromCharCode(byte);
      buffer &= (1 << bits) - 1;
    }
  }

  // A canonical encoding leaves the trailing partial group's spare bits zeroed.
  if (buffer !== 0) return null;

  return out;
}

/**
 * Builds the continuation token that resumes a listing after `lastMealPlanId`.
 *
 * @param lastMealPlanId - Sort key of the last record on the page just returned
 * @returns The base64url cursor to send back as `nextCursor`
 * @throws {RangeError} When `lastMealPlanId` is not a valid Meal_Plan_Id, which would
 *   produce a cursor that {@link decodeCursor} must then reject
 */
export function encodeCursor(lastMealPlanId: string): string {
  if (!isValidMealPlanId(lastMealPlanId)) {
    throw new RangeError('encodeCursor: lastMealPlanId is not a valid Meal_Plan_Id');
  }

  return encodeBase64Url(JSON.stringify({ v: CURSOR_VERSION, sk: lastMealPlanId }));
}

/**
 * Decodes a supplied continuation token into the sort-key position it names.
 *
 * Rejects, with no distinction between causes, a cursor that is not a string, is empty,
 * is over-long, is not well-formed base64url, does not hold JSON, holds anything other
 * than a JSON object, carries a `v` other than {@link CURSOR_VERSION}, omits `sk`, or
 * carries an `sk` that fails `isValidMealPlanId`. A rejected cursor therefore never
 * reaches the Meal_Plan_Store.
 *
 * The returned `sk` is only ever used together with the User_Id derived from the
 * verified Auth_Token; the cursor itself names no Account.
 */
export function decodeCursor(cursor: string): CursorDecode {
  if (typeof cursor !== 'string') return { ok: false };
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) return { ok: false };

  const json = decodeBase64Url(cursor);
  if (json === null) return { ok: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false };
  }

  const payload = parsed as { v?: unknown; sk?: unknown };
  if (payload.v !== CURSOR_VERSION) return { ok: false };
  if (!isValidMealPlanId(payload.sk)) return { ok: false };

  return { ok: true, sk: payload.sk as string };
}
