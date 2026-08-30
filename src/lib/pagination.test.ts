/**
 * Unit tests for the listing continuation token (cursor).
 *
 * Two behaviors carry the weight here. First, a cursor this module produced must
 * decode back to exactly the sort key it was built from (Requirement 6.3), and
 * anything else — malformed, truncated, non-canonical, wrong-version, or naming a
 * reserved key — must be rejected before it can reach the Meal_Plan_Store.
 * Second, the cursor names *only* a sort-key position: it carries no Account, so a
 * cursor lifted from another Account is inert once the next request re-derives the
 * User_Id from the verified Auth_Token (Requirements 6.3, 6.8).
 */

import { describe, expect, it } from 'vitest';

import { newMealPlanId } from './mealPlanId';
import { CURSOR_VERSION, decodeCursor, encodeCursor } from './pagination';

/** Base64url alphabet, restated here so the tests do not depend on module internals. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Encodes arbitrary ASCII as unpadded base64url, for hand-crafting cursors. */
function craft(ascii: string): string {
  let out = '';
  for (let i = 0; i < ascii.length; i += 3) {
    const b0 = ascii.charCodeAt(i);
    const has1 = i + 1 < ascii.length;
    const has2 = i + 2 < ascii.length;
    const b1 = has1 ? ascii.charCodeAt(i + 1) : 0;
    const b2 = has2 ? ascii.charCodeAt(i + 2) : 0;
    out += ALPHABET.charAt(b0 >> 2);
    out += ALPHABET.charAt(((b0 & 0x03) << 4) | (b1 >> 4));
    if (has1) out += ALPHABET.charAt(((b1 & 0x0f) << 2) | (b2 >> 6));
    if (has2) out += ALPHABET.charAt(b2 & 0x3f);
  }
  return out;
}

/** Decodes a cursor's payload text, for asserting on what the cursor carries. */
function payloadOf(cursor: string): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < cursor.length; i += 1) {
    buffer = (buffer << 6) | ALPHABET.indexOf(cursor.charAt(i));
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  return out;
}

/** A representative spread of legal Meal_Plan_Ids, boundaries included. */
const VALID_IDS = [
  newMealPlanId(0),
  newMealPlanId(1_700_000_000_000),
  '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  'A',
  '0',
  '-',
  'plan-2024-01-01',
  'a'.repeat(64),
];

describe('encodeCursor / decodeCursor round trip', () => {
  it('recovers the exact sort key for every legal Meal_Plan_Id', () => {
    for (const id of VALID_IDS) {
      expect(decodeCursor(encodeCursor(id))).toEqual({ ok: true, sk: id });
    }
  });

  it('is deterministic — the same id always yields the same cursor', () => {
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    expect(encodeCursor(id)).toBe(encodeCursor(id));
  });

  it('emits unpadded base64url only, so it is safe in a query string', () => {
    for (const id of VALID_IDS) {
      expect(encodeCursor(id)).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('refuses to build a cursor decodeCursor would then reject', () => {
    for (const id of ['', '#meta', 'PENDING#DELETION', 'a'.repeat(65), 'has space', 'a_b']) {
      expect(() => encodeCursor(id)).toThrow(RangeError);
    }
  });
});

describe('decodeCursor rejects unusable cursors', () => {
  const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const valid = encodeCursor(id);

  it('rejects an absent, empty, or non-string cursor', () => {
    expect(decodeCursor('')).toEqual({ ok: false });
    expect(decodeCursor(undefined as unknown as string)).toEqual({ ok: false });
    expect(decodeCursor(null as unknown as string)).toEqual({ ok: false });
    expect(decodeCursor(42 as unknown as string)).toEqual({ ok: false });
    expect(decodeCursor({ sk: id } as unknown as string)).toEqual({ ok: false });
  });

  it('rejects an over-long cursor before decoding it', () => {
    expect(decodeCursor('A'.repeat(256))).toEqual({ ok: false });
    expect(decodeCursor('A'.repeat(257))).toEqual({ ok: false });
  });

  it('rejects every proper prefix of a valid cursor', () => {
    for (let cut = 1; cut < valid.length; cut += 1) {
      expect(decodeCursor(valid.slice(0, cut))).toEqual({ ok: false });
    }
  });

  it('rejects characters outside the base64url alphabet, padding included', () => {
    for (const bad of [`${valid}=`, `${valid.slice(0, -1)}+`, `${valid.slice(0, -1)}/`, `${valid.slice(0, -1)}!`, `${valid.slice(0, -1)} `]) {
      expect(decodeCursor(bad)).toEqual({ ok: false });
    }
  });

  it('rejects a non-canonical encoding of an otherwise valid payload', () => {
    // The final base64url character of this cursor carries two spare bits that a
    // canonical encoding leaves zeroed. Setting them keeps the decoded bytes
    // identical, so only a canonicality check catches it.
    expect(valid.length % 4).toBe(3);
    const last = ALPHABET.indexOf(valid.charAt(valid.length - 1));
    const mutated = valid.slice(0, -1) + ALPHABET.charAt(last | 0b11);
    expect(mutated).not.toBe(valid);
    expect(payloadOf(mutated)).toBe(payloadOf(valid));
    expect(decodeCursor(mutated)).toEqual({ ok: false });
  });

  it('rejects a payload that is not JSON, or is JSON but not an object', () => {
    for (const payload of ['', 'not json', '{', '[]', `["${id}"]`, `"${id}"`, '1', 'null', 'true']) {
      expect(decodeCursor(craft(payload))).toEqual({ ok: false });
    }
  });

  it('rejects any version other than the current one', () => {
    for (const v of ['0', '2', '"1"', 'null', '1.5']) {
      expect(decodeCursor(craft(`{"v":${v},"sk":"${id}"}`))).toEqual({ ok: false });
    }
    expect(decodeCursor(craft(`{"sk":"${id}"}`))).toEqual({ ok: false });
    // Sanity check that the payload shape itself is otherwise acceptable.
    expect(decodeCursor(craft(`{"v":${CURSOR_VERSION},"sk":"${id}"}`))).toEqual({ ok: true, sk: id });
  });

  it('rejects a missing, wrongly typed, or illegal sort key', () => {
    for (const sk of ['', 'null', '123', 'true', '{}', '["' + id + '"]', '"a b"', '"' + 'a'.repeat(65) + '"']) {
      const payload = sk === '' ? `{"v":${CURSOR_VERSION}}` : `{"v":${CURSOR_VERSION},"sk":${sk}}`;
      expect(decodeCursor(craft(payload))).toEqual({ ok: false });
    }
  });

  it('rejects a cursor whose sort key names a reserved key', () => {
    for (const reserved of ['#meta', 'PENDING#DELETION']) {
      expect(decodeCursor(craft(`{"v":${CURSOR_VERSION},"sk":"${reserved}"}`))).toEqual({ ok: false });
    }
  });
});

describe('a cursor from another Account is inert', () => {
  it('carries only a version and a sort key — no Account is encoded', () => {
    const cursor = encodeCursor('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    const parsed = JSON.parse(payloadOf(cursor));
    expect(Object.keys(parsed).sort()).toEqual(['sk', 'v']);
  });

  it('is byte-identical for two Accounts resuming at the same sort key', () => {
    // Both Accounts' pages ended on this Meal_Plan_Id. Nothing Account-specific
    // goes into the token, so the two cursors cannot be told apart.
    const sharedLastId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    expect(encodeCursor(sharedLastId)).toBe(encodeCursor(sharedLastId));
  });

  it('drops an Account named in a crafted cursor rather than surfacing it', () => {
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const crafted = craft(`{"v":${CURSOR_VERSION},"sk":"${id}","userId":"victim-uid","uid":"victim-uid"}`);
    const result = decodeCursor(crafted);

    expect(result).toEqual({ ok: true, sk: id });
    // The decode surfaces a sort-key position and nothing else, so the caller has
    // no route to a User_Id other than the one derived from the Auth_Token.
    expect(Object.keys(result).sort()).toEqual(['ok', 'sk']);
    expect(JSON.stringify(result)).not.toContain('victim-uid');
  });
});
