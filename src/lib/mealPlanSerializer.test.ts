import { describe, expect, it } from 'vitest';

import { newMealPlanId } from './mealPlanId';
import {
  MAX_SERIALIZED_BYTES,
  MealPlanItemError,
  MealPlanValidationError,
  deserializeMealPlanItem,
  serializeMealPlanRecord,
  serializedByteLength,
} from './mealPlanSerializer';
import type { MealPlanItem } from './mealPlanSerializer';
import type { MealPlanRecord } from './types';

const CREATED_AT_MS = Date.UTC(2025, 2, 14, 9, 12, 33, 481);

/** A valid record whose ULID carries the same millisecond timestamp as `createdAt`. */
function validRecord(overrides: Partial<MealPlanRecord> = {}): MealPlanRecord {
  return {
    userId: 'kJ8x2mQfirebaseUid0001',
    mealPlanId: newMealPlanId(CREATED_AT_MS),
    title: 'Low-fiber week',
    createdAt: new Date(CREATED_AT_MS).toISOString(),
    updatedAt: new Date(CREATED_AT_MS).toISOString(),
    content: {
      meals: [
        {
          mealName: 'Breakfast',
          items: [
            { name: 'Scrambled eggs', portion: '2 eggs', notes: 'Soft-cooked' },
            { name: 'White toast', portion: '1 slice' },
          ],
        },
      ],
      summary: 'Gentle low-residue day.',
      warnings: ['Avoid raw vegetables during a flare.'],
    },
    ...overrides,
  };
}

/** Collects every key appearing anywhere in a produced item. */
function allKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((entry) => allKeys(entry, found));
    return found;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      found.push(key);
      allKeys(inner, found);
    }
  }
  return found;
}

/** Collects every value appearing anywhere in a produced item. */
function allValues(value: unknown, found: unknown[] = []): unknown[] {
  found.push(value);
  if (Array.isArray(value)) {
    value.forEach((entry) => allValues(entry, found));
  } else if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach((inner) => allValues(inner, found));
  }
  return found;
}

describe('serializeMealPlanRecord', () => {
  it('retains every field, and both timestamps, in the produced item', () => {
    const record = validRecord();
    const item = serializeMealPlanRecord(record);

    expect(item.userId).toEqual({ S: record.userId });
    expect(item.mealPlanId).toEqual({ S: record.mealPlanId });
    expect(item.title).toEqual({ S: 'Low-fiber week' });
    expect(item.createdAt).toEqual({ S: '2025-03-14T09:12:33.481Z' });
    expect(item.updatedAt).toEqual({ S: '2025-03-14T09:12:33.481Z' });
    expect(item.schemaVersion).toEqual({ N: '1' });
    expect(item.content.M.meals.L[0].M.mealName).toEqual({ S: 'Breakfast' });
    expect(item.content.M.meals.L[0].M.items.L[0].M.notes).toEqual({ S: 'Soft-cooked' });
    expect(item.content.M.warnings?.L).toEqual([{ S: 'Avoid raw vegetables during a flare.' }]);
  });

  it('uses list attributes only — no SS, NS, or BS set type appears anywhere', () => {
    const item = serializeMealPlanRecord(validRecord());

    const keys = allKeys(item);
    expect(keys).not.toContain('SS');
    expect(keys).not.toContain('NS');
    expect(keys).not.toContain('BS');
    expect(allValues(item).some((value) => value instanceof Set)).toBe(false);
    // Ordered collections are carried as `L`.
    expect(Array.isArray(item.content.M.meals.L)).toBe(true);
    expect(Array.isArray(item.content.M.meals.L[0].M.items.L)).toBe(true);
  });

  it('omits notes and warnings entirely when the source values are absent', () => {
    const item = serializeMealPlanRecord(
      validRecord({
        content: {
          meals: [{ mealName: 'Lunch', items: [{ name: 'Rice', portion: '1 cup' }] }],
          summary: '',
        },
      })
    );

    expect('warnings' in item.content.M).toBe(false);
    expect('notes' in item.content.M.meals.L[0].M.items.L[0].M).toBe(false);
    expect(item.content.M.summary).toEqual({ S: '' });
  });

  it('rejects a record with zero meals, naming the collection', () => {
    const record = validRecord({
      content: { meals: [], summary: 'Nothing planned.' },
    });

    expect(() => serializeMealPlanRecord(record)).toThrow(MealPlanValidationError);
    try {
      serializeMealPlanRecord(record);
      expect.unreachable();
    } catch (error) {
      expect((error as MealPlanValidationError).field).toBe('content.meals');
    }
  });

  it.each([
    ['title', (r: MealPlanRecord) => ({ ...r, title: 'x'.repeat(201) })],
    [
      'content.summary',
      (r: MealPlanRecord) => ({ ...r, content: { ...r.content, summary: 'x'.repeat(5001) } }),
    ],
    [
      'content.warnings[0]',
      (r: MealPlanRecord) => ({ ...r, content: { ...r.content, warnings: [''] } }),
    ],
    [
      'content.meals[0].items[1].portion',
      (r: MealPlanRecord) => ({
        ...r,
        content: {
          ...r.content,
          meals: [
            {
              ...r.content.meals[0],
              items: [r.content.meals[0].items[0], { name: 'White toast', portion: '' }],
            },
          ],
        },
      }),
    ],
  ])('names %s when that value violates its bound', (field, mutate) => {
    try {
      serializeMealPlanRecord(mutate(validRecord()));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MealPlanValidationError);
      expect((error as MealPlanValidationError).field).toBe(field);
    }
  });

  it('rejects a lone surrogate as a wrong-type violation naming the field', () => {
    const record = validRecord({ title: `Plan \ud800 draft` });

    try {
      serializeMealPlanRecord(record);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MealPlanValidationError);
      expect((error as MealPlanValidationError).field).toBe('title');
      expect((error as MealPlanValidationError).bound).toBe('wrong-type');
    }
  });

  it('applies no Unicode normalization in either direction', () => {
    const nfd = 'cafe\u0301 plan'; // e + combining acute
    const nfc = 'caf\u00e9 plan';
    expect(serializeMealPlanRecord(validRecord({ title: nfd })).title.S).toBe(nfd);
    expect(serializeMealPlanRecord(validRecord({ title: nfc })).title.S).toBe(nfc);
  });

  it('rejects a mealPlanId whose embedded timestamp disagrees with createdAt', () => {
    const record = validRecord({ mealPlanId: newMealPlanId(CREATED_AT_MS + 1) });

    try {
      serializeMealPlanRecord(record);
      expect.unreachable();
    } catch (error) {
      expect((error as MealPlanValidationError).field).toBe('mealPlanId');
    }
  });

  it('rejects a timestamp that is not ISO-8601 UTC with three fractional digits', () => {
    const record = validRecord({ updatedAt: '2025-03-14T09:12:33Z' });

    try {
      serializeMealPlanRecord(record);
      expect.unreachable();
    } catch (error) {
      expect((error as MealPlanValidationError).field).toBe('updatedAt');
    }
  });
});

describe('deserializeMealPlanItem', () => {
  it('round-trips a record with non-ASCII characters, newlines, and quotation marks', () => {
    const record = validRecord({
      title: 'Plan “é中🇯🇵”\nweek',
      content: {
        meals: [
          {
            mealName: "Petit déjeuner \t'quoted'",
            items: [
              { name: 'Œufs brouillés', portion: '2 œufs', notes: 'Doux\r\ncuits' },
              { name: '米飯', portion: '1 杯' },
            ],
          },
          {
            mealName: 'Dinner 👩‍👩‍👦',
            items: [{ name: 'Soup \\ "broth"', portion: '250 ml' }],
          },
        ],
        summary: 'Résumé ${process.env.SECRET} — "gentle"',
        warnings: ['Évitez les légumes crus', 'שים לב'],
      },
    });

    expect(deserializeMealPlanItem(serializeMealPlanRecord(record))).toStrictEqual(record);
  });

  it('produces absent values, not empty ones, for omitted optional attributes', () => {
    const record = validRecord({
      content: {
        meals: [{ mealName: 'Lunch', items: [{ name: 'Rice', portion: '1 cup' }] }],
        summary: 'Plain.',
      },
    });

    const back = deserializeMealPlanItem(serializeMealPlanRecord(record));

    expect('warnings' in back.content).toBe(false);
    expect('notes' in back.content.meals[0].items[0]).toBe(false);
    expect(back).toStrictEqual(record);
  });

  it.each([
    ['title', (i: MealPlanItem) => delete (i as unknown as Record<string, unknown>).title],
    ['createdAt', (i: MealPlanItem) => delete (i as unknown as Record<string, unknown>).createdAt],
    [
      'content.summary',
      (i: MealPlanItem) => delete (i.content.M as unknown as Record<string, unknown>).summary,
    ],
    [
      'content.meals[0].items[0].portion',
      (i: MealPlanItem) =>
        delete (i.content.M.meals.L[0].M.items.L[0].M as Record<string, unknown>).portion,
    ],
  ])('names %s when that attribute is absent', (attribute, remove) => {
    const item = serializeMealPlanRecord(validRecord());
    remove(item);

    try {
      deserializeMealPlanItem(item);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MealPlanItemError);
      expect((error as MealPlanItemError).attribute).toBe(attribute);
      expect((error as MealPlanItemError).reason).toBe('missing');
    }
  });

  it.each([
    [
      'title',
      (i: MealPlanItem) => {
        (i as unknown as Record<string, unknown>).title = { N: '7' };
      },
    ],
    [
      'content.meals',
      (i: MealPlanItem) => {
        (i.content.M as unknown as Record<string, unknown>).meals = { S: 'breakfast' };
      },
    ],
    [
      'content.meals[0].items[1]',
      (i: MealPlanItem) => {
        (i.content.M.meals.L[0].M.items.L as unknown[])[1] = { S: 'not a map' };
      },
    ],
    [
      'content.warnings[0]',
      (i: MealPlanItem) => {
        (i.content.M.warnings!.L as unknown[])[0] = { L: [] };
      },
    ],
    [
      'schemaVersion',
      (i: MealPlanItem) => {
        (i as unknown as Record<string, unknown>).schemaVersion = { S: '1' };
      },
    ],
  ])('names %s when that attribute holds an unexpected type', (attribute, corrupt) => {
    const item = serializeMealPlanRecord(validRecord());
    corrupt(item);

    try {
      deserializeMealPlanItem(item);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MealPlanItemError);
      expect((error as MealPlanItemError).attribute).toBe(attribute);
      expect((error as MealPlanItemError).reason).toBe('wrong-type');
    }
  });

  it('leaves a corrupt item unmodified and returns nothing', () => {
    const item = serializeMealPlanRecord(validRecord());
    delete (item as unknown as Record<string, unknown>).title;
    const before = JSON.stringify(item);

    expect(() => deserializeMealPlanItem(item)).toThrow(MealPlanItemError);
    expect(JSON.stringify(item)).toBe(before);
  });

  it('rejects a value that is not an item at all', () => {
    for (const notAnItem of [undefined, null, 'item', 42, []]) {
      expect(() => deserializeMealPlanItem(notAnItem)).toThrow(MealPlanItemError);
    }
  });
});

describe('serializedByteLength', () => {
  it('counts UTF-8 bytes, so a multi-byte character costs more than one', () => {
    const ascii = serializedByteLength(serializeMealPlanRecord(validRecord({ title: 'aaaa' })));
    const cjk = serializedByteLength(serializeMealPlanRecord(validRecord({ title: '中中中中' })));
    const emoji = serializedByteLength(serializeMealPlanRecord(validRecord({ title: '🍎🍎🍎🍎' })));

    expect(cjk).toBe(ascii + 4 * 2);
    expect(emoji).toBe(ascii + 4 * 3);
  });

  it('measures a large plan above the 100 kilobyte ceiling', () => {
    const record = validRecord({
      content: {
        meals: Array.from({ length: 10 }, (_, mealIndex) => ({
          mealName: `Meal ${mealIndex}`,
          items: Array.from({ length: 20 }, () => ({
            name: 'x'.repeat(200),
            portion: 'y'.repeat(100),
            notes: 'z'.repeat(1000),
          })),
        })),
        summary: 's'.repeat(5000),
        warnings: Array.from({ length: 20 }, () => 'w'.repeat(500)),
      },
    });

    expect(serializedByteLength(serializeMealPlanRecord(record))).toBeGreaterThan(
      MAX_SERIALIZED_BYTES
    );
    expect(serializedByteLength(serializeMealPlanRecord(validRecord()))).toBeLessThan(
      MAX_SERIALIZED_BYTES
    );
  });
});
