/**
 * Property-based tests for the Meal_Plan_Serializer and Meal_Plan_Deserializer.
 *
 * Feature: user-auth-and-cloud-storage, Properties 1, 2, 3, 4.
 *
 * One `describe` block per property, in the design's numbering order.
 *
 * The round trip is asserted over records in canonical form — the form
 * `arbMealPlanRecord()` produces, where an absent optional value is a missing key and
 * never an empty string or an empty list. That is deliberate: the serializer collapses a
 * present-but-empty `warnings` list to an absent attribute, so `serialize` of such a
 * record is not the identity, and Property 2 covers that omission behavior directly.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  MealPlanItemError,
  MealPlanValidationError,
  deserializeMealPlanItem,
  serializeMealPlanRecord,
  type MealPlanItem,
} from '@/lib/mealPlanSerializer';
import type { MealPlanRecord } from '@/lib/types';
import {
  arbCorruptedItem,
  arbInvalidMealPlanRecord,
  arbMealPlanRecord,
} from '@/test/arbitraries';

/** Splits a string into whole code points, so an astral-plane character stays one entry. */
const codePoints = (value: string): string[] => Array.from(value);

/**
 * The characters Requirement 9.6 names explicitly, plus the backslash — the one an
 * escaping layer would be most likely to double or drop.
 */
const TRACKED_CHARACTERS = ['\n', '\r', '\t', "'", '"', '\\'] as const;

/** Occurrences of `needle` in `haystack`, counted over code units. */
function occurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) {
    count += 1;
  }
  return count;
}

/**
 * Asserts that `actual` is the same string as `expected` code point for code point, with
 * the characters Requirement 9.6 names appearing at the same indices and in the same
 * counts, and with no escape sequence introduced or removed.
 */
function expectSameCharacters(actual: string, expected: string, path: string): void {
  const actualPoints = codePoints(actual);
  const expectedPoints = codePoints(expected);

  expect(actualPoints.length, `${path}: code point count`).toBe(expectedPoints.length);
  expect(actualPoints, `${path}: code point sequence`).toStrictEqual(expectedPoints);
  // Code unit length too, so a surrogate pair cannot have been re-encoded.
  expect(actual.length, `${path}: code unit count`).toBe(expected.length);

  for (const character of TRACKED_CHARACTERS) {
    expect(occurrences(actual, character), `${path}: count of ${JSON.stringify(character)}`).toBe(
      occurrences(expected, character)
    );
    expect(actual.indexOf(character), `${path}: first index of ${JSON.stringify(character)}`).toBe(
      expected.indexOf(character)
    );
  }
}

/**
 * Asserts that a timestamp survived as a UTC value with millisecond precision: the same
 * instant, and still the self-describing ISO-8601 form with exactly three fractional
 * digits.
 */
function expectSameUtcMillis(actual: string, expected: string, path: string): void {
  expect(actual, `${path}: exact form`).toBe(expected);
  expect(actual, `${path}: ISO-8601 UTC with 3 fractional digits`).toMatch(
    /^-?\d{4,6}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
  );
  const ms = Date.parse(actual);
  expect(Number.isNaN(ms), `${path}: parseable instant`).toBe(false);
  expect(ms, `${path}: same instant`).toBe(Date.parse(expected));
  expect(new Date(ms).toISOString(), `${path}: millisecond precision retained`).toBe(actual);
}

/**
 * The keys of a path map, sorted. `Array.from` rather than a spread so the file compiles
 * under the project's `tsconfig` without `downlevelIteration`.
 */
function sortedKeys(strings: Map<string, string>): string[] {
  return Array.from(strings.keys()).sort();
}

/** Every string the item itself carries, keyed by the path the record uses. */
function itemStrings(item: MealPlanItem): Map<string, string> {
  const strings = new Map<string, string>();
  strings.set('userId', item.userId.S);
  strings.set('mealPlanId', item.mealPlanId.S);
  strings.set('title', item.title.S);
  strings.set('createdAt', item.createdAt.S);
  strings.set('updatedAt', item.updatedAt.S);
  strings.set('content.summary', item.content.M.summary.S);
  item.content.M.meals.L.forEach((meal, m) => {
    strings.set(`content.meals[${m}].mealName`, meal.M.mealName.S);
    meal.M.items.L.forEach((entry, i) => {
      strings.set(`content.meals[${m}].items[${i}].name`, entry.M.name.S);
      strings.set(`content.meals[${m}].items[${i}].portion`, entry.M.portion.S);
      if (entry.M.notes !== undefined) {
        strings.set(`content.meals[${m}].items[${i}].notes`, entry.M.notes.S);
      }
    });
  });
  item.content.M.warnings?.L.forEach((warning, w) => {
    strings.set(`content.warnings[${w}]`, warning.S);
  });
  return strings;
}

/** The same strings, read off the record rather than the item. */
function recordStrings(record: MealPlanRecord): Map<string, string> {
  const strings = new Map<string, string>();
  strings.set('userId', record.userId);
  strings.set('mealPlanId', record.mealPlanId);
  strings.set('title', record.title);
  strings.set('createdAt', record.createdAt);
  strings.set('updatedAt', record.updatedAt);
  strings.set('content.summary', record.content.summary);
  record.content.meals.forEach((meal, m) => {
    strings.set(`content.meals[${m}].mealName`, meal.mealName);
    meal.items.forEach((entry, i) => {
      strings.set(`content.meals[${m}].items[${i}].name`, entry.name);
      strings.set(`content.meals[${m}].items[${i}].portion`, entry.portion);
      if (entry.notes !== undefined) {
        strings.set(`content.meals[${m}].items[${i}].notes`, entry.notes);
      }
    });
  });
  record.content.warnings?.forEach((warning, w) => {
    strings.set(`content.warnings[${w}]`, warning);
  });
  return strings;
}

describe('Property 1: Serialization round trip preserves the record exactly', () => {
  // Feature: user-auth-and-cloud-storage, Property 1: Serialization round trip preserves the record exactly
  // Validates: Requirements 9.1, 9.2, 9.3, 9.6
  it('round-trips any valid Meal_Plan_Record', () => {
    fc.assert(
      fc.property(arbMealPlanRecord(), (record) => {
        const item = serializeMealPlanRecord(record);
        const roundTripped = deserializeMealPlanItem(item);

        // Whole-record equality, including which optional keys are present (9.2, 9.3).
        expect(roundTripped).toStrictEqual(record);

        // Sequences, asserted directly rather than left to structural equality, so a
        // failure says which ordering broke (9.3).
        expect(roundTripped.content.meals.map((meal) => meal.mealName)).toStrictEqual(
          record.content.meals.map((meal) => meal.mealName)
        );
        record.content.meals.forEach((meal, m) => {
          const actualMeal = roundTripped.content.meals[m];
          expect(actualMeal.items.map((entry) => entry.name)).toStrictEqual(
            meal.items.map((entry) => entry.name)
          );
          expect(actualMeal.items.map((entry) => entry.portion)).toStrictEqual(
            meal.items.map((entry) => entry.portion)
          );
          expect(actualMeal.items.map((entry) => entry.notes)).toStrictEqual(
            meal.items.map((entry) => entry.notes)
          );
        });
        expect(roundTripped.content.warnings).toStrictEqual(record.content.warnings);

        // Character fidelity, both in the produced item (9.1) and after the round trip
        // (9.6): every string identical code point for code point, with newlines and
        // quotation marks in the same positions and counts.
        const expected = recordStrings(record);
        const stored = itemStrings(item);
        const actual = recordStrings(roundTripped);
        expect(sortedKeys(stored)).toStrictEqual(sortedKeys(expected));
        expect(sortedKeys(actual)).toStrictEqual(sortedKeys(expected));
        for (const [path, value] of Array.from(expected)) {
          expectSameCharacters(stored.get(path)!, value, `item ${path}`);
          expectSameCharacters(actual.get(path)!, value, path);
        }

        // Both timestamps retained as UTC with millisecond precision (9.1).
        expectSameUtcMillis(item.createdAt.S, record.createdAt, 'item createdAt');
        expectSameUtcMillis(item.updatedAt.S, record.updatedAt, 'item updatedAt');
        expectSameUtcMillis(roundTripped.createdAt, record.createdAt, 'createdAt');
        expectSameUtcMillis(roundTripped.updatedAt, record.updatedAt, 'updatedAt');
      }),
      { numRuns: 500 }
    );
  });
});
/** The optional paths only — item `notes` and record `warnings` — from a path map. */
function optionalPaths(strings: Map<string, string>): string[] {
  return sortedKeys(strings).filter(
    (path) => path.endsWith('.notes') || path.startsWith('content.warnings')
  );
}

/** Reports whether an object carries `key` as an own key, so `{ notes: undefined }` fails. */
function hasKey(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** A copy of `record` with every item note and the warnings list removed outright. */
function withoutOptionals(record: MealPlanRecord): MealPlanRecord {
  return {
    ...record,
    content: {
      meals: record.content.meals.map((meal) => ({
        mealName: meal.mealName,
        items: meal.items.map((entry) => ({ name: entry.name, portion: entry.portion })),
      })),
      summary: record.content.summary,
    },
  };
}

describe('Property 2: Absent optional values stay absent, never empty', () => {
  // Feature: user-auth-and-cloud-storage, Property 2: Absent optional values stay absent, never empty
  // Validates: Requirements 9.4, 9.9
  it('omits an optional attribute exactly when the source value is absent', () => {
    fc.assert(
      fc.property(arbMealPlanRecord(), (record) => {
        const item = serializeMealPlanRecord(record);
        const roundTripped = deserializeMealPlanItem(item);

        // Presence parity across every optional path at once: the item carries an
        // attribute exactly where the record carries a value, and so does the record the
        // deserializer rebuilds (9.4).
        const sourceOptional = optionalPaths(recordStrings(record));
        expect(optionalPaths(itemStrings(item)), 'item optional paths').toStrictEqual(
          sourceOptional
        );
        expect(optionalPaths(recordStrings(roundTripped)), 'round-tripped optional paths')
          .toStrictEqual(sourceOptional);

        // Per item note: own-key presence, not merely an undefined read, so an explicit
        // `notes: undefined` would fail rather than pass as absent.
        record.content.meals.forEach((meal, m) => {
          const storedMeal = item.content.M.meals.L[m].M;
          const rebuiltMeal = roundTripped.content.meals[m];
          meal.items.forEach((entry, i) => {
            const path = `content.meals[${m}].items[${i}].notes`;
            const present = entry.notes !== undefined;
            const storedEntry = storedMeal.items.L[i].M;
            const rebuiltEntry = rebuiltMeal.items[i];

            expect(hasKey(storedEntry, 'notes'), `item ${path}: attribute present`).toBe(present);
            expect(hasKey(rebuiltEntry, 'notes'), `${path}: key present`).toBe(present);

            if (present) {
              expect(rebuiltEntry.notes, `${path}: value`).toBe(entry.notes);
            } else {
              // Absent, not '' — and the key set holds nothing beyond the required pair.
              expect(rebuiltEntry.notes, `${path}: absent`).toBeUndefined();
              expect(Object.keys(rebuiltEntry).sort(), `${path}: key set`).toStrictEqual([
                'name',
                'portion',
              ]);
              expect(Object.keys(storedEntry).sort(), `item ${path}: attribute set`).toStrictEqual([
                'name',
                'portion',
              ]);
            }
          });
        });

        // The warnings list: absent stays absent, and a stored list is never empty — the
        // serializer collapses an empty list to an omitted attribute rather than `{ L: [] }`.
        const warningsPresent = record.content.warnings !== undefined;
        expect(hasKey(item.content.M, 'warnings'), 'item content.warnings: attribute present').toBe(
          warningsPresent
        );
        expect(hasKey(roundTripped.content, 'warnings'), 'content.warnings: key present').toBe(
          warningsPresent
        );
        if (warningsPresent) {
          expect(item.content.M.warnings!.L.length, 'item content.warnings: never empty')
            .toBeGreaterThan(0);
          expect(roundTripped.content.warnings, 'content.warnings: value').toStrictEqual(
            record.content.warnings
          );
        } else {
          expect(roundTripped.content.warnings, 'content.warnings: absent').toBeUndefined();
          expect(item.content.M.warnings, 'item content.warnings: absent').toBeUndefined();
          expect(Object.keys(roundTripped.content).sort(), 'content key set').toStrictEqual([
            'meals',
            'summary',
          ]);
        }
      }),
      { numRuns: 300 }
    );
  });

  // Feature: user-auth-and-cloud-storage, Property 2: Absent optional values stay absent, never empty
  // Validates: Requirements 9.9
  it('round-trips a record with zero warnings and no notes without signalling an error', () => {
    fc.assert(
      fc.property(arbMealPlanRecord(), (generated) => {
        const record = withoutOptionals(generated);

        // No error, and equality including the absence of both optional keys (9.9).
        const roundTripped = deserializeMealPlanItem(serializeMealPlanRecord(record));
        expect(roundTripped).toStrictEqual(record);

        expect(hasKey(roundTripped.content, 'warnings')).toBe(false);
        for (const meal of roundTripped.content.meals) {
          for (const entry of meal.items) {
            expect(hasKey(entry, 'notes')).toBe(false);
          }
        }
      }),
      { numRuns: 300 }
    );
  });

  // Feature: user-auth-and-cloud-storage, Property 2: Absent optional values stay absent, never empty
  // Validates: Requirements 9.4
  it('stores a present-but-empty warnings list as an absent attribute, never as an empty list', () => {
    fc.assert(
      fc.property(arbMealPlanRecord(), (generated) => {
        const record: MealPlanRecord = {
          ...generated,
          content: { ...generated.content, warnings: [] },
        };

        const item = serializeMealPlanRecord(record);
        const roundTripped = deserializeMealPlanItem(item);

        // The one place the round trip canonicalizes rather than preserves: empty and
        // absent collapse to the same stored shape, and the value comes back absent
        // rather than as `[]` (9.4).
        expect(hasKey(item.content.M, 'warnings'), 'item content.warnings: attribute').toBe(false);
        expect(hasKey(roundTripped.content, 'warnings'), 'content.warnings: key').toBe(false);
        expect(roundTripped.content.warnings).toBeUndefined();
        expect(roundTripped).toStrictEqual(withoutWarnings(record));
      }),
      { numRuns: 100 }
    );
  });
});

/** A copy of `record` with the warnings list removed, item notes left as they are. */
function withoutWarnings(record: MealPlanRecord): MealPlanRecord {
  return {
    ...record,
    content: { meals: record.content.meals, summary: record.content.summary },
  };
}

/**
 * A deep copy of a record, used to prove the serializer left its input alone. A JSON
 * round trip is enough here: every value in a generated record is a string, an array, or
 * a plain object, and an absent optional is an absent key rather than `undefined`, so no
 * information is lost by the copy.
 */
function deepCopy(record: MealPlanRecord): MealPlanRecord {
  return JSON.parse(JSON.stringify(record)) as MealPlanRecord;
}

/**
 * Calls the serializer without letting the error escape, so a property can assert on both
 * halves of "signals an error and produces no item" in one place.
 */
function attemptSerialize(record: MealPlanRecord): {
  item: MealPlanItem | undefined;
  error: unknown;
} {
  let item: MealPlanItem | undefined;
  let error: unknown;
  try {
    item = serializeMealPlanRecord(record);
  } catch (caught) {
    error = caught;
  }
  return { item, error };
}

describe('Property 3: Bound violations are rejected with the offending field named', () => {
  // Feature: user-auth-and-cloud-storage, Property 3: Bound violations are rejected with the offending field named
  // Validates: Requirements 9.7, 9.8
  it('produces an item for every record satisfying every bound', () => {
    fc.assert(
      fc.property(arbMealPlanRecord(), (record) => {
        // The "if" half of the biconditional: a record within every bound in 9.7 is
        // serialized rather than rejected.
        const { item, error } = attemptSerialize(record);
        expect(error, 'no error for a record within bounds').toBeUndefined();
        expect(item, 'an item is produced').toBeDefined();
      }),
      { numRuns: 300 }
    );
  });

  // Feature: user-auth-and-cloud-storage, Property 3: Bound violations are rejected with the offending field named
  // Validates: Requirements 9.7, 9.8
  it('rejects a record violating one bound, naming that field and producing no item', () => {
    fc.assert(
      fc.property(arbInvalidMealPlanRecord(), ({ record, brokenField, violation }) => {
        const before = deepCopy(record);

        const { item, error } = attemptSerialize(record);

        // No item at all — not a partial one, not one with the offending value dropped
        // (9.8).
        expect(item, `${brokenField} (${violation}): no item produced`).toBeUndefined();

        // An error that names the field or collection at fault, both as the structured
        // `field` a caller can branch on and in the message a human reads (9.8).
        expect(error, `${brokenField} (${violation}): error signalled`).toBeInstanceOf(
          MealPlanValidationError
        );
        const validationError = error as MealPlanValidationError;
        expect(validationError.field, `${violation}: named field`).toBe(brokenField);
        expect(validationError.message, `${brokenField}: message names the field`).toContain(
          brokenField
        );

        // The reported bound describes the range in the unit the bound is stated in, so
        // the error distinguishes a collection-size violation from a length violation
        // rather than collapsing both into "invalid" (9.7).
        const unit =
          violation === 'too-few' || violation === 'too-many' ? 'entries' : 'characters';
        expect(validationError.bound, `${brokenField}: reported bound`).toContain(unit);

        // Rejection is a read-only operation on the caller's record.
        expect(record, `${brokenField}: input left unmutated`).toStrictEqual(before);
      }),
      { numRuns: 300 }
    );
  });

  // Feature: user-auth-and-cloud-storage, Property 3: Bound violations are rejected with the offending field named
  // Validates: Requirements 5.15
  it('rejects a plan carrying no meals, naming the meals collection', () => {
    fc.assert(
      fc.property(arbMealPlanRecord(), (generated) => {
        const record: MealPlanRecord = {
          ...generated,
          content: { ...generated.content, meals: [] },
        };

        // The 1..10 meals bound is what rejects a Meal_Plan containing no meals, and the
        // named collection is what lets the Meal_Plan_API say so (5.15).
        const { item, error } = attemptSerialize(record);
        expect(item, 'no item produced for a plan with no meals').toBeUndefined();
        expect(error).toBeInstanceOf(MealPlanValidationError);
        expect((error as MealPlanValidationError).field).toBe('content.meals');
      }),
      { numRuns: 100 }
    );
  });
});
/**
 * A faithful deep copy of a corrupted item. A JSON round trip suffices: a serialized item
 * is pure JSON, and every replacement value `arbCorruptedItem()` injects is a JSON value,
 * with a deleted attribute represented as an absent key rather than `undefined`.
 */
function deepCopyItem(item: unknown): unknown {
  return JSON.parse(JSON.stringify(item)) as unknown;
}

/**
 * Calls the deserializer without letting the error escape, so a property can assert on
 * both halves of "signals an error and returns no record" in one place.
 */
function attemptDeserialize(item: unknown): {
  record: MealPlanRecord | undefined;
  error: unknown;
} {
  let record: MealPlanRecord | undefined;
  let error: unknown;
  try {
    record = deserializeMealPlanItem(item);
  } catch (caught) {
    error = caught;
  }
  return { record, error };
}

describe('Property 4: Corrupt items are rejected with the attribute named, and never partially deserialized', () => {
  // Feature: user-auth-and-cloud-storage, Property 4: Corrupt items are rejected with the attribute named, and never partially deserialized
  // Validates: Requirements 9.5
  it('names the single broken attribute path, returns no record, and leaves the item unmutated', () => {
    fc.assert(
      fc.property(arbCorruptedItem(), ({ item, attributePath, mutation }) => {
        const before = deepCopyItem(item);

        const { record, error } = attemptDeserialize(item);

        // No Meal_Plan_Record at all — not a partial one with the broken attribute
        // dropped or defaulted (9.5).
        expect(record, `${attributePath} (${mutation}): no record produced`).toBeUndefined();

        // An error naming that exact attribute path, both as the structured `attribute` a
        // caller can branch on and in the message a human reads (9.5).
        expect(error, `${attributePath} (${mutation}): error signalled`).toBeInstanceOf(
          MealPlanItemError
        );
        const itemError = error as MealPlanItemError;
        expect(itemError.attribute, `${mutation}: named attribute`).toBe(attributePath);
        expect(itemError.message, `${attributePath}: message names the attribute`).toContain(
          attributePath
        );

        // Absent and retyped stay distinguishable, so the error says which defect it met
        // rather than collapsing both into "unreadable".
        expect(itemError.reason, `${attributePath}: reported reason`).toBe(mutation);

        // Rejection is a read-only operation on the caller's item.
        expect(item, `${attributePath}: input left unmutated`).toStrictEqual(before);
      }),
      { numRuns: 500 }
    );
  });
});
