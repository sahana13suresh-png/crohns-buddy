import { describe, it, expect } from 'vitest';
import { isValidMealPlanId, mealPlanIdTimestampMs, newMealPlanId } from './mealPlanId';

const MAX_TIMESTAMP_MS = 2 ** 48 - 1;

/** A ULID produced at a fixed instant, used where the exact value is irrelevant. */
const SAMPLE_ID = newMealPlanId(1_700_000_000_000);

describe('isValidMealPlanId', () => {
  it('accepts a generated Meal_Plan_Id', () => {
    expect(isValidMealPlanId(SAMPLE_ID)).toBe(true);
  });

  it('accepts a single character', () => {
    expect(isValidMealPlanId('a')).toBe(true);
    expect(isValidMealPlanId('Z')).toBe(true);
    expect(isValidMealPlanId('0')).toBe(true);
    expect(isValidMealPlanId('-')).toBe(true);
  });

  it('accepts lowercase letters, digits, and hyphens together', () => {
    expect(isValidMealPlanId('plan-2024-01-02-abc')).toBe(true);
  });

  it('accepts exactly 64 characters', () => {
    expect(isValidMealPlanId('a'.repeat(64))).toBe(true);
  });

  it('rejects the empty string', () => {
    expect(isValidMealPlanId('')).toBe(false);
  });

  it('rejects 65 characters', () => {
    expect(isValidMealPlanId('a'.repeat(65))).toBe(false);
  });

  it('rejects the reserved metadata key', () => {
    expect(isValidMealPlanId('#meta')).toBe(false);
  });

  it('rejects the pending-deletion partition key', () => {
    expect(isValidMealPlanId('PENDING#DELETION')).toBe(false);
  });

  it('rejects an underscore', () => {
    expect(isValidMealPlanId('plan_1')).toBe(false);
    expect(isValidMealPlanId('_')).toBe(false);
  });

  it.each([
    ['space', 'plan 1'],
    ['leading whitespace', ' plan'],
    ['newline', 'plan\n'],
    ['tab', 'plan\t1'],
    ['hash alone', '#'],
    ['slash', 'plan/1'],
    ['dot segment', '..'],
    ['accented letter', 'planté'],
    ['emoji', 'plan🍎'],
    ['null byte', 'plan\u0000'],
  ])('rejects an id containing a %s', (_label, id) => {
    expect(isValidMealPlanId(id)).toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['number', 12345],
    ['boolean', true],
    ['object', { toString: () => SAMPLE_ID }],
    ['array', [SAMPLE_ID]],
  ])('rejects a non-string %s value', (_label, value) => {
    expect(isValidMealPlanId(value)).toBe(false);
  });
});

describe('newMealPlanId', () => {
  it('produces a 26-character id that passes validation', () => {
    const id = newMealPlanId(1_700_000_000_000);
    expect(id).toHaveLength(26);
    expect(isValidMealPlanId(id)).toBe(true);
  });

  it('embeds the supplied creation timestamp', () => {
    const nowMs = 1_712_345_678_901;
    expect(mealPlanIdTimestampMs(newMealPlanId(nowMs))).toBe(nowMs);
  });

  it('accepts the timestamp boundaries', () => {
    expect(mealPlanIdTimestampMs(newMealPlanId(0))).toBe(0);
    expect(mealPlanIdTimestampMs(newMealPlanId(MAX_TIMESTAMP_MS))).toBe(MAX_TIMESTAMP_MS);
  });

  it.each([
    ['a fractional value', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a negative value', -1],
    ['a value past the 48-bit range', MAX_TIMESTAMP_MS + 1],
  ])('throws a RangeError for %s', (_label, nowMs) => {
    expect(() => newMealPlanId(nowMs)).toThrow(RangeError);
  });

  it('produces distinct ids within the same millisecond', () => {
    const nowMs = 1_700_000_000_000;
    const ids = new Set(Array.from({ length: 50 }, () => newMealPlanId(nowMs)));
    expect(ids.size).toBe(50);
  });

  it('orders ids generated at increasing timestamps lexicographically', () => {
    const timestamps = [
      0, 1, 999, 1_000, 1_600_000_000_000, 1_700_000_000_000, 1_700_000_000_001,
      1_999_999_999_999, MAX_TIMESTAMP_MS,
    ];
    const ids = timestamps.map((t) => newMealPlanId(t));

    for (let i = 1; i < ids.length; i += 1) {
      expect(ids[i - 1] < ids[i]).toBe(true);
    }
    expect([...ids].sort()).toEqual(ids);
  });

  it('orders ids the same way whether compared as strings or by embedded timestamp', () => {
    const unordered = [1_700_000_005_000, 1_500_000_000_000, 1_700_000_000_000, 42];
    const ids = unordered.map((t) => newMealPlanId(t));

    const byString = [...ids].sort();
    const byTimestamp = [...ids].sort(
      (a, b) => mealPlanIdTimestampMs(a) - mealPlanIdTimestampMs(b),
    );

    expect(byString).toEqual(byTimestamp);
  });
});

describe('mealPlanIdTimestampMs', () => {
  it('round trips a generated id', () => {
    const nowMs = 1_650_000_000_123;
    expect(mealPlanIdTimestampMs(newMealPlanId(nowMs))).toBe(nowMs);
  });

  it.each([
    ['the empty string', ''],
    ['a 25-character id', 'A'.repeat(25)],
    ['a 27-character id', 'A'.repeat(27)],
    ['a 64-character id', 'A'.repeat(64)],
    ['characters outside Crockford base 32', '!'.repeat(26)],
    ['the reserved metadata key', '#meta'],
  ])('throws a RangeError for %s', (_label, id) => {
    expect(() => mealPlanIdTimestampMs(id)).toThrow(RangeError);
  });

  it('throws a RangeError for a non-string value', () => {
    expect(() => mealPlanIdTimestampMs(undefined as unknown as string)).toThrow(RangeError);
    expect(() => mealPlanIdTimestampMs(null as unknown as string)).toThrow(RangeError);
  });
});
