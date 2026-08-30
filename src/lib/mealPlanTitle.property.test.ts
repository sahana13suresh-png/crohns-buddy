/**
 * Property-based test for Meal_Plan_Record title normalization.
 *
 * Feature: user-auth-and-cloud-storage, Property 9.
 *
 * Length is asserted in Unicode code points, matching the module under test and the
 * design decision that truncation never splits an astral-plane character.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  MAX_TITLE_CODE_POINTS,
  DEFAULT_TITLE_PREFIX,
  normalizeTitle,
  validateRenameTitle,
} from '@/lib/mealPlanTitle';
import { arbTrickyString } from '@/test/arbitraries';

/** Code point count, i.e. "characters" as the design reads Requirement 5.6. */
const codePoints = (value: string): string[] => Array.from(value);

/**
 * Trims using an explicit whitespace class rather than `String.prototype.trim`, so the
 * expectation is not simply a copy of the implementation.
 */
const trimWhitespace = (value: string): string => value.replace(/^[\s\ufeff]+|[\s\ufeff]+$/gu, '');

/** The UTC calendar date of `ms`, derived independently of the module under test. */
function expectedUtcDate(ms: number): string {
  const iso = new Date(ms).toISOString();
  return iso.slice(0, iso.indexOf('T'));
}

/** Whitespace runs, including the ones a naive `[ \t\n]` trim would miss. */
const arbPadding = fc.constantFrom(
  '',
  ' ',
  '   ',
  '\t',
  '\n',
  '\r\n',
  ' \t\r\n ',
  '\u00a0',
  '\u2028\u2029',
  '\u3000',
  '\ufeff',
);

/**
 * Title bodies spread across every branch of the normalizer: comfortably short, exactly
 * at the 100-code-point bound, one past it, far past it, and empty. Whitespace-only
 * bodies arise naturally, since the tricky generator emits separators.
 */
const arbTitleBody = fc.oneof(
  { weight: 5, arbitrary: arbTrickyString(1, 60) },
  { weight: 2, arbitrary: arbTrickyString(MAX_TITLE_CODE_POINTS, MAX_TITLE_CODE_POINTS) },
  { weight: 2, arbitrary: arbTrickyString(MAX_TITLE_CODE_POINTS + 1, MAX_TITLE_CODE_POINTS + 1) },
  { weight: 2, arbitrary: arbTrickyString(MAX_TITLE_CODE_POINTS + 1, 400) },
  { weight: 1, arbitrary: fc.constant('') },
);

/** A supplied title: absent, or a body wrapped in leading and trailing whitespace. */
const arbSuppliedTitle: fc.Arbitrary<string | undefined> = fc.oneof(
  { weight: 1, arbitrary: fc.constant(undefined) },
  {
    weight: 9,
    arbitrary: fc
      .tuple(arbPadding, arbTitleBody, arbPadding)
      .map(([left, body, right]) => `${left}${body}${right}`),
  },
);

/** Creation timestamps: the realistic window, a wide historical span, and the epoch edges. */
const arbCreatedAtMs = fc.oneof(
  { weight: 6, arbitrary: fc.integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2035, 0, 1) }) },
  { weight: 3, arbitrary: fc.integer({ min: Date.UTC(1000, 0, 1), max: Date.UTC(9998, 11, 31) }) },
  { weight: 1, arbitrary: fc.constantFrom(0, -1, 1, 86_400_000) },
);

describe('Meal_Plan_Record title normalization', () => {
  // Feature: user-auth-and-cloud-storage, Property 9: Title normalization trims, defaults, and truncates
  it('trims, defaults, and truncates any supplied title within the 1..100 code point bound', () => {
    fc.assert(
      fc.property(arbSuppliedTitle, arbCreatedAtMs, (supplied, createdAtMs) => {
        const stored = normalizeTitle(supplied, createdAtMs);
        const trimmed = supplied === undefined ? '' : trimWhitespace(supplied);
        const trimmedPoints = codePoints(trimmed);

        // Never empty, never over the bound — for every input.
        expect(stored.length).toBeGreaterThan(0);
        expect(codePoints(stored).length).toBeGreaterThanOrEqual(1);
        expect(codePoints(stored).length).toBeLessThanOrEqual(MAX_TITLE_CODE_POINTS);

        if (trimmedPoints.length === 0) {
          // Absent or whitespace-only: the default formed from the UTC creation date.
          expect(stored).toBe(`${DEFAULT_TITLE_PREFIX} — ${expectedUtcDate(createdAtMs)}`);
        } else if (trimmedPoints.length <= MAX_TITLE_CODE_POINTS) {
          // Within bound: the input with leading and trailing whitespace removed.
          expect(stored).toBe(trimmed);
        } else {
          // Over bound: the first 100 code points of the trimmed value.
          expect(stored).toBe(trimmedPoints.slice(0, MAX_TITLE_CODE_POINTS).join(''));
        }

        // Client-side rename validation (Requirements 8.4, 8.6) accepts exactly the
        // trimmed values that fit the bound, and returns them trimmed.
        if (supplied !== undefined) {
          const validation = validateRenameTitle(supplied);
          const acceptable =
            trimmedPoints.length >= 1 && trimmedPoints.length <= MAX_TITLE_CODE_POINTS;
          expect(validation.ok).toBe(acceptable);
          if (validation.ok) {
            expect(validation.title).toBe(trimmed);
            expect(normalizeTitle(supplied, createdAtMs)).toBe(validation.title);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});
