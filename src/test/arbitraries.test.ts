/**
 * Self-tests for the shared generators.
 *
 * Generators are test infrastructure, so a defect here is invisible: a property
 * would still pass, just over a narrower or malformed input space than intended.
 * These tests draw fixed-seed samples and check the guarantees the property
 * tests rely on — that a "valid" record really satisfies every Requirement 9.7
 * bound, that the boundaries and optionality combinations are actually reached,
 * and that an "invalid" record breaks exactly the field it reports.
 */

import { X509Certificate, verify as verifyBytes, type KeyObject } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { mealPlanIdTimestampMs, newMealPlanId } from '@/lib/mealPlanId';
import { MealPlanItemError, deserializeMealPlanItem } from '@/lib/mealPlanSerializer';
import { createInMemoryMealPlanRepository } from '@/lib/server/inMemoryMealPlanRepository';
import {
  AUTH_TOKEN_MAX_CHARS,
  CLOCK_TOLERANCE_SECONDS,
} from '@/lib/server/joseAuthTokenVerifier';
import {
  MEAL_PLAN_PAGE_SIZE,
  MEAL_PLAN_RECORD_CAP,
} from '@/lib/server/mealPlanRepository';
import type { MealPlanRecord } from '@/lib/types';

import {
  MAX_COMMAND_SEQUENCE_LENGTH,
  MEAL_PLAN_BOUNDS,
  UNUSABLE_TOKEN_CAUSES,
  arbCommandSequence,
  arbCorruptedItem,
  arbInvalidMealPlanRecord,
  arbMealPlanRecord,
  arbMultiAccountStore,
  arbTrickyString,
  arbUnusableToken,
  createUnusableTokenKit,
} from './arbitraries';
import type {
  MultiAccountStore,
  StoreCommand,
  UnusableToken,
  UnusableTokenCause,
  UnusableTokenKit,
} from './arbitraries';

/** Fixed seed so a failure here replays exactly. */
const SAMPLE = { seed: 20240607, numRuns: 300 } as const;

/** A UTF-16 code unit that is half of a surrogate pair with no partner. */
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const codePoints = (s: string): number => Array.from(s).length;

/**
 * Every bound from Requirement 9.7 that `record` violates, as dotted field
 * paths matching `arbInvalidMealPlanRecord`'s `brokenField`.
 *
 * A string is short when its code point count is under the minimum and long when
 * its code unit count is over the maximum, so a value counted either way inside
 * `[min, max]` is reported as valid under both readings.
 */
function boundViolations(record: MealPlanRecord): string[] {
  const B = MEAL_PLAN_BOUNDS;
  const broken: string[] = [];

  const str = (path: string, value: string, min: number, max: number): void => {
    if (codePoints(value) < min || value.length > max) broken.push(path);
  };
  const count = (path: string, size: number, min: number, max: number): void => {
    if (size < min || size > max) broken.push(path);
  };

  str('title', record.title, B.title.min, B.title.max);
  count('content.meals', record.content.meals.length, B.meals.min, B.meals.max);
  str('content.summary', record.content.summary, B.summary.min, B.summary.max);

  record.content.meals.forEach((meal, m) => {
    str(`content.meals[${m}].mealName`, meal.mealName, B.mealName.min, B.mealName.max);
    count(
      `content.meals[${m}].items`,
      meal.items.length,
      B.itemsPerMeal.min,
      B.itemsPerMeal.max,
    );
    meal.items.forEach((item, i) => {
      const at = `content.meals[${m}].items[${i}]`;
      str(`${at}.name`, item.name, B.itemName.min, B.itemName.max);
      str(`${at}.portion`, item.portion, B.portion.min, B.portion.max);
      if (item.notes !== undefined) {
        str(`${at}.notes`, item.notes, B.itemNote.min, B.itemNote.max);
      }
    });
  });

  const warnings = record.content.warnings;
  if (warnings !== undefined) {
    count('content.warnings', warnings.length, B.warnings.min, B.warnings.max);
    warnings.forEach((warning, w) => {
      str(`content.warnings[${w}]`, warning, B.warning.min, B.warning.max);
    });
  }

  return broken;
}

/**
 * Reads the value a `brokenField` path names, e.g.
 * `content.meals[2].items[5].portion`.
 */
function resolvePath(record: MealPlanRecord, path: string): unknown {
  let cursor: unknown = record;
  for (const token of path.match(/[A-Za-z]+|\[\d+\]/g) ?? []) {
    const index = token.startsWith('[') ? Number(token.slice(1, -1)) : undefined;
    cursor =
      index === undefined
        ? (cursor as Record<string, unknown>)[token]
        : (cursor as unknown[])[index];
  }
  return cursor;
}

describe('arbTrickyString', () => {
  it('produces lengths inside the bounds under both length readings', () => {
    const ranges: Array<[number, number]> = [
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 20],
      [1, 200],
      [100, 100],
      [0, 1000],
    ];
    for (const [min, max] of ranges) {
      for (const value of fc.sample(arbTrickyString(min, max), SAMPLE)) {
        expect(codePoints(value)).toBeGreaterThanOrEqual(min);
        expect(value.length).toBeLessThanOrEqual(max);
      }
    }
  });

  it('never emits a lone surrogate', () => {
    for (const value of fc.sample(arbTrickyString(0, 200), SAMPLE)) {
      expect(LONE_SURROGATE.test(value)).toBe(false);
    }
  });

  it('rejects impossible bounds', () => {
    expect(() => arbTrickyString(5, 4)).toThrow(RangeError);
    expect(() => arbTrickyString(-1, 4)).toThrow(RangeError);
    expect(() => arbTrickyString(1.5, 4)).toThrow(RangeError);
  });

  it('covers every awkward character category the requirement names', () => {
    const joined = fc.sample(arbTrickyString(1, 200), { ...SAMPLE, numRuns: 600 }).join('\u0000');
    expect(joined).toMatch(/[\u00c0-\u00ff]/); // Latin-1 accents
    expect(joined).toMatch(/[\u4e00-\u9fff\u3041-\u30fa\uac00-\ud7a3]/); // CJK
    expect(joined).toMatch(/[\ud800-\udbff][\udc00-\udfff]/); // surrogate pair emoji
    expect(joined).toMatch(/[\u0300-\u036f]/); // combining marks
    expect(joined).toMatch(/[\u0590-\u05ff\u0600-\u06ff\u200e\u200f\u202a-\u202e]/); // RTL
    expect(joined).toContain('\r\n');
    expect(joined).toContain('\t');
    expect(joined).toContain("'");
    expect(joined).toContain('"');
    expect(joined).toContain('\\');
    expect(joined).toContain('${');
  });
});

describe('arbMealPlanRecord', () => {
  const records = fc.sample(arbMealPlanRecord(), SAMPLE);

  it('satisfies every bound in Requirement 9.7', () => {
    for (const record of records) {
      expect(boundViolations(record)).toEqual([]);
    }
  });

  it('carries a 26-character ULID whose timestamp equals createdAt', () => {
    for (const record of records) {
      expect(record.mealPlanId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(mealPlanIdTimestampMs(record.mealPlanId)).toBe(Date.parse(record.createdAt));
      expect(record.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(record.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(Date.parse(record.updatedAt)).toBeGreaterThanOrEqual(Date.parse(record.createdAt));
      expect(record.userId).toMatch(/^[0-9A-Za-z]{20,36}$/);
    }
  });

  it('never represents an absent optional value as an empty one', () => {
    for (const record of records) {
      expect(record.content.warnings).not.toEqual([]);
      for (const meal of record.content.meals) {
        for (const item of meal.items) {
          if ('notes' in item) expect(item.notes).not.toBe('');
        }
      }
    }
  });

  it('reaches the collection boundaries and all four optionality combinations', () => {
    const mealCounts = new Set(records.map((r) => r.content.meals.length));
    expect(mealCounts.has(MEAL_PLAN_BOUNDS.meals.min)).toBe(true);
    expect(mealCounts.has(MEAL_PLAN_BOUNDS.meals.max)).toBe(true);

    const itemCounts = new Set(
      records.flatMap((r) => r.content.meals.map((m) => m.items.length)),
    );
    expect(itemCounts.has(MEAL_PLAN_BOUNDS.itemsPerMeal.min)).toBe(true);
    expect(itemCounts.has(MEAL_PLAN_BOUNDS.itemsPerMeal.max)).toBe(true);

    const warningCounts = new Set(records.map((r) => r.content.warnings?.length ?? 0));
    expect(warningCounts.has(0)).toBe(true);
    expect(warningCounts.has(MEAL_PLAN_BOUNDS.warnings.max)).toBe(true);

    const combos = new Set(
      records.map((r) => {
        const notes = r.content.meals.some((m) => m.items.some((i) => i.notes !== undefined));
        return `${notes ? 'notes' : 'no-notes'}/${r.content.warnings ? 'warnings' : 'no-warnings'}`;
      }),
    );
    expect(combos).toEqual(
      new Set([
        'no-notes/no-warnings',
        'notes/no-warnings',
        'no-notes/warnings',
        'notes/warnings',
      ]),
    );
  });

  it('reaches minimum- and maximum-length string values', () => {
    const titleLengths = records.map((r) => codePoints(r.title));
    expect(titleLengths).toContain(MEAL_PLAN_BOUNDS.title.min);
    expect(titleLengths).toContain(MEAL_PLAN_BOUNDS.title.max);
  });
});

describe('arbInvalidMealPlanRecord', () => {
  const cases = fc.sample(arbInvalidMealPlanRecord(), SAMPLE);

  it('violates exactly the reported field, and nothing else', () => {
    for (const { record, brokenField } of cases) {
      expect(boundViolations(record)).toEqual([brokenField]);
    }
  });

  it('breaks each bound under both length readings', () => {
    for (const { record, brokenField, violation } of cases) {
      const value = resolvePath(record, brokenField);
      if (violation === 'too-long') {
        // ASCII only, so the bound is exceeded whether the serializer counts
        // code units or code points.
        expect(typeof value).toBe('string');
        expect(value as string).toMatch(/^[\x20-\x7e]+$/);
      }
      if (violation === 'too-short') expect(value).toBe('');
      if (violation === 'too-few') expect(value).toEqual([]);
    }
  });

  it('exercises all four ways to break a bound', () => {
    const kinds = new Set(cases.map((c) => c.violation));
    expect(kinds).toEqual(new Set(['too-few', 'too-many', 'too-short', 'too-long']));
  });

  it('covers every bounded field', () => {
    const fields = new Set(cases.map((c) => c.brokenField.replace(/\[\d+\]/g, '[]')));
    expect(fields).toEqual(
      new Set([
        'title',
        'content.meals',
        'content.summary',
        'content.warnings',
        'content.warnings[]',
        'content.meals[].mealName',
        'content.meals[].items',
        'content.meals[].items[].name',
        'content.meals[].items[].portion',
        'content.meals[].items[].notes',
      ]),
    );
  });
});

// ─── arbCorruptedItem ──────────────────────────────────────────────────────────

/**
 * A minimally valid stored item, item entry, meal, and content map, used to
 * repair a corrupted attribute with a type-correct placeholder.
 *
 * The deserializer deliberately does not re-check bounds or formats on read, so a
 * placeholder only has to carry the right DynamoDB type tag.
 */
const MINIMAL_ITEM_ENTRY = { M: { name: { S: 'n' }, portion: { S: 'p' } } };
const MINIMAL_MEAL = { M: { mealName: { S: 'm' }, items: { L: [MINIMAL_ITEM_ENTRY] } } };
const MINIMAL_CONTENT = { M: { meals: { L: [MINIMAL_MEAL] }, summary: { S: '' } } };

/** A type-correct value for whichever attribute `path` names. */
function placeholderFor(path: string): unknown {
  switch (path.replace(/\[\d+\]/g, '[]')) {
    case 'schemaVersion':
      return { N: '1' };
    case 'content':
      return MINIMAL_CONTENT;
    case 'content.meals':
      return { L: [MINIMAL_MEAL] };
    case 'content.meals[]':
      return MINIMAL_MEAL;
    case 'content.meals[].items':
      return { L: [MINIMAL_ITEM_ENTRY] };
    case 'content.meals[].items[]':
      return MINIMAL_ITEM_ENTRY;
    case 'content.warnings':
      return { L: [{ S: 'w' }] };
    default:
      // Every remaining leaf the generator targets is an `S` attribute.
      return { S: 'placeholder' };
  }
}

/**
 * Physical key sequence reaching the logical `path` inside a stored item,
 * re-inserting the `M` and `L` wrappers the logical form omits. Written
 * independently of the generator's own converter, so a defect in one does not
 * hide behind the other.
 */
function itemPathTokens(path: string): Array<string | number> {
  const tokens: Array<string | number> = [];
  path.split('.').forEach((segment, depth) => {
    if (depth > 0) tokens.push('M');
    tokens.push(segment.replace(/\[\d+\]/g, ''));
    for (const digits of segment.match(/\d+/g) ?? []) tokens.push('L', Number(digits));
  });
  return tokens;
}

function readItemPath(item: unknown, path: string): unknown {
  let cursor: unknown = item;
  for (const token of itemPathTokens(path)) {
    if (cursor === undefined || cursor === null) return undefined;
    cursor =
      typeof token === 'number'
        ? (cursor as unknown[])[token]
        : (cursor as Record<string, unknown>)[token];
  }
  return cursor;
}

/** A deep copy of `item` in which `path` holds a type-correct placeholder. */
function repairItemPath(item: unknown, path: string): unknown {
  const copy: unknown = JSON.parse(JSON.stringify(item));
  const tokens = itemPathTokens(path);

  let parent: unknown = copy;
  for (const token of tokens.slice(0, -1)) {
    parent =
      typeof token === 'number'
        ? (parent as unknown[])[token]
        : (parent as Record<string, unknown>)[token];
  }

  const leaf = tokens[tokens.length - 1];
  if (typeof leaf === 'number') (parent as unknown[])[leaf] = placeholderFor(path);
  else (parent as Record<string, unknown>)[leaf] = placeholderFor(path);
  return copy;
}

describe('arbCorruptedItem', () => {
  const cases = fc.sample(arbCorruptedItem(), SAMPLE);

  it('breaks the reported attribute in the reported way', () => {
    for (const { item, attributePath, mutation } of cases) {
      const value = readItemPath(item, attributePath);
      if (mutation === 'missing') {
        expect(value).toBeUndefined();
      } else {
        // Present, but never a well-formed `S`, `N`, `L`, or `M` attribute.
        expect(value).not.toBeUndefined();
        const holder = typeof value === 'object' && value !== null && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : undefined;
        expect(typeof holder?.S === 'string').toBe(false);
        expect(Array.isArray(holder?.L)).toBe(false);
        expect(typeof holder?.M === 'object' && holder?.M !== null).toBe(false);
        expect(typeof holder?.N === 'string' && /^-?\d+(\.\d+)?$/.test(holder.N as string)).toBe(
          false,
        );
      }
    }
  });

  it('makes the deserializer name that exact attribute path and reason', () => {
    for (const { item, attributePath, mutation } of cases) {
      let thrown: unknown;
      try {
        deserializeMealPlanItem(item);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(MealPlanItemError);
      expect((thrown as MealPlanItemError).attribute).toBe(attributePath);
      expect((thrown as MealPlanItemError).reason).toBe(mutation);
    }
  });

  it('carries exactly one corruption — repairing the reported path makes the item readable', () => {
    for (const { item, attributePath } of cases) {
      expect(() => deserializeMealPlanItem(repairItemPath(item, attributePath))).not.toThrow();
    }
  });

  it('never names a path carrying a DynamoDB type tag', () => {
    for (const { attributePath } of cases) {
      expect(attributePath).not.toMatch(/(^|\.)[MLSN](\.|$)/);
      expect(attributePath).toMatch(/^[A-Za-z]+(\[\d+\])?(\.[A-Za-z]+(\[\d+\])?)*$/);
    }
  });

  it('covers every corruptible attribute and both mutations', () => {
    expect(new Set(cases.map((c) => c.mutation))).toEqual(new Set(['missing', 'wrong-type']));

    const shapes = new Set(cases.map((c) => c.attributePath.replace(/\[\d+\]/g, '[]')));
    expect(shapes).toEqual(
      new Set([
        'userId',
        'mealPlanId',
        'title',
        'createdAt',
        'updatedAt',
        'schemaVersion',
        'content',
        'content.meals',
        'content.summary',
        'content.meals[]',
        'content.meals[].mealName',
        'content.meals[].items',
        'content.meals[].items[]',
        'content.meals[].items[].name',
        'content.meals[].items[].portion',
        'content.meals[].items[].notes',
        'content.warnings',
        'content.warnings[]',
      ]),
    );
  });

  it('deletes only attributes whose absence is a defect', () => {
    // `content.warnings` and item `notes` may legally be absent, and removing a
    // list element just yields a shorter list, so none of those is ever deleted.
    for (const { attributePath, mutation } of cases) {
      if (mutation !== 'missing') continue;
      const shape = attributePath.replace(/\[\d+\]/g, '[]');
      expect(shape).not.toBe('content.warnings');
      expect(shape).not.toBe('content.meals[].items[].notes');
      expect(attributePath).not.toMatch(/\[\d+\]$/);
    }
  });
});

// ─── arbMultiAccountStore ──────────────────────────────────────────────────────

/**
 * Fewer runs than {@link SAMPLE} for the store and sequence generators: one draw
 * builds up to a hundred records or three hundred commands, so a wide sample buys
 * little beyond what the coverage assertions already check.
 */
const STORE_SAMPLE = { seed: 20240607, numRuns: 60 } as const;

/** Smaller again where each draw is replayed against a repository. */
const REPLAY_SAMPLE = { seed: 20240607, numRuns: 20 } as const;

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ISO_UTC_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A repository whose clock is fixed, so nothing a test observes depends on wall time. */
function freshRepository() {
  return createInMemoryMealPlanRepository({
    now: () => Date.UTC(2031, 5, 7),
    newMealPlanId: () => newMealPlanId(Date.UTC(2031, 5, 7)),
  });
}

/** Every record the seeds place, flattened, so a test can compare against `placements`. */
function seededRecords(store: MultiAccountStore): MealPlanRecord[] {
  return store.seeds.flatMap((seed) => seed.records ?? []);
}

describe('arbMultiAccountStore', () => {
  const stores = fc.sample(arbMultiAccountStore(), STORE_SAMPLE);

  it('populates two to five distinct Accounts plus a User_Id it does not populate', () => {
    for (const store of stores) {
      expect(store.seeds.length).toBeGreaterThanOrEqual(2);
      expect(store.seeds.length).toBeLessThanOrEqual(5);
      expect(store.userIds).toEqual(store.seeds.map((seed) => seed.userId));
      expect(new Set(store.userIds).size).toBe(store.userIds.length);
      expect(store.userIds).not.toContain(store.absentUserId);
      for (const userId of [...store.userIds, store.absentUserId]) {
        expect(userId).toMatch(/^[0-9A-Za-z]{20,36}$/);
      }
    }
  });

  it('stores well-formed records, each owned by the Account holding it', () => {
    for (const store of stores) {
      for (const seed of store.seeds) {
        const records = seed.records ?? [];
        expect(new Set(records.map((r) => r.mealPlanId)).size).toBe(records.length);
        for (const record of records) {
          expect(boundViolations(record)).toEqual([]);
          expect(record.userId).toBe(seed.userId);
          expect(record.mealPlanId).toMatch(ULID);
          expect(record.createdAt).toMatch(ISO_UTC_MILLIS);
          expect(record.updatedAt).toMatch(ISO_UTC_MILLIS);
          expect(mealPlanIdTimestampMs(record.mealPlanId)).toBe(Date.parse(record.createdAt));
          expect(Date.parse(record.updatedAt)).toBeGreaterThanOrEqual(
            Date.parse(record.createdAt),
          );
        }
      }
    }
  });

  it('reports exactly the placements the seeds make', () => {
    for (const store of stores) {
      expect(store.placements).toEqual(
        seededRecords(store).map((record) => ({
          userId: record.userId,
          mealPlanId: record.mealPlanId,
          createdAt: record.createdAt,
        })),
      );
    }
  });

  it('overlaps Meal_Plan_Ids across Accounts and reports exactly the shared ones', () => {
    let sawSharing = false;
    for (const store of stores) {
      const owners = new Map<string, string[]>();
      for (const { mealPlanId, userId } of store.placements) {
        owners.set(mealPlanId, [...(owners.get(mealPlanId) ?? []), userId]);
      }
      const shared = Array.from(owners.entries())
        .filter(([, held]) => held.length > 1)
        .map(([mealPlanId]) => mealPlanId)
        .sort();
      expect(store.sharedMealPlanIds).toEqual(shared);

      // Two non-empty Accounts always overlap: every one of them holds the first
      // pool id, which is what gives a confinement property something to catch.
      const nonEmpty = store.seeds.filter((seed) => (seed.records ?? []).length > 0);
      if (nonEmpty.length > 1) expect(shared.length).toBeGreaterThan(0);
      if (shared.length > 0) sawSharing = true;

      // A shared id carries different content in each Account, so a leaked read
      // returns a visibly wrong record rather than a plausible one.
      for (const mealPlanId of shared) {
        const titles = seededRecords(store)
          .filter((record) => record.mealPlanId === mealPlanId)
          .map((record) => record.title);
        expect(new Set(titles).size).toBe(titles.length);
      }
    }
    expect(sawSharing).toBe(true);
  });

  it('collides createdAt inside an Account while keeping the ids distinct', () => {
    const collidingAccounts = stores.flatMap((store) =>
      store.seeds.filter((seed) => {
        const records = seed.records ?? [];
        const instants = new Set(records.map((record) => record.createdAt));
        return records.length > 1 && instants.size < records.length;
      }),
    );
    expect(collidingAccounts.length).toBeGreaterThan(0);
    for (const seed of collidingAccounts) {
      const records = seed.records ?? [];
      expect(new Set(records.map((r) => r.mealPlanId)).size).toBe(records.length);
    }
  });

  it('names a well-shaped Meal_Plan_Id no Account holds', () => {
    for (const store of stores) {
      expect(store.absentMealPlanId).toMatch(ULID);
      expect(store.placements.map((p) => p.mealPlanId)).not.toContain(store.absentMealPlanId);
    }
  });

  it('reaches the empty, short, exactly-full, and overflowing page counts', () => {
    const counts = new Set(
      stores.flatMap((store) => store.seeds.map((seed) => (seed.records ?? []).length)),
    );
    expect(counts.has(0)).toBe(true);
    expect(counts.has(MEAL_PLAN_PAGE_SIZE - 1)).toBe(true);
    expect(counts.has(MEAL_PLAN_PAGE_SIZE)).toBe(true);
    expect(counts.has(MEAL_PLAN_PAGE_SIZE + 1)).toBe(true);
  });

  it('varies the storage acknowledgment across Accounts', () => {
    const acks = new Set(
      stores.flatMap((store) => store.seeds.map((seed) => seed.storageAckAt !== undefined)),
    );
    expect(acks).toEqual(new Set([true, false]));
  });

  it('loads into the in-memory repository with every record under its own Account', async () => {
    for (const store of fc.sample(arbMultiAccountStore(), REPLAY_SAMPLE)) {
      const repository = freshRepository();
      repository.seed(store.seeds);

      for (const seed of store.seeds) {
        const stored = await repository.listAll(seed.userId);
        const expected = seed.records ?? [];
        expect(stored.map((r) => r.mealPlanId).sort()).toEqual(
          expected.map((r) => r.mealPlanId).sort(),
        );
        for (const record of stored) {
          expect(record.userId).toBe(seed.userId);
          const source = expected.find((r) => r.mealPlanId === record.mealPlanId);
          expect(record.title).toBe(source?.title);
        }
      }

      // A shared id resolves to the holding Account's own record, never another's.
      for (const mealPlanId of store.sharedMealPlanIds) {
        for (const seed of store.seeds) {
          const source = (seed.records ?? []).find((r) => r.mealPlanId === mealPlanId);
          if (source === undefined) continue;
          const read = await repository.get(seed.userId, mealPlanId);
          expect(read?.title).toBe(source.title);
        }
      }

      expect(await repository.listAll(store.absentUserId)).toEqual([]);
    }
  });
});

// ─── arbCommandSequence ────────────────────────────────────────────────────────

/** The record a command carries, for the commands that carry one. */
function commandRecord(command: StoreCommand): MealPlanRecord | undefined {
  return command.kind === 'create' || command.kind === 'update' ? command.record : undefined;
}

/** The Meal_Plan_Id a command names, whichever kind it is. */
function commandMealPlanId(command: StoreCommand): string {
  return command.kind === 'create' || command.kind === 'update'
    ? command.record.mealPlanId
    : command.mealPlanId;
}

describe('arbCommandSequence', () => {
  const sequences = fc.sample(arbCommandSequence(), STORE_SAMPLE);

  it('issues one to three hundred commands, all from one Account', () => {
    for (const sequence of sequences) {
      expect(sequence.commands.length).toBeGreaterThanOrEqual(1);
      expect(sequence.commands.length).toBeLessThanOrEqual(MAX_COMMAND_SEQUENCE_LENGTH);
      expect(sequence.userId).toMatch(/^[0-9A-Za-z]{20,36}$/);
      for (const command of sequence.commands) {
        expect(commandRecord(command)?.userId ?? sequence.userId).toBe(sequence.userId);
      }
    }
  });

  it('advances a non-decreasing clock', () => {
    for (const sequence of sequences) {
      let previous = -Infinity;
      for (const command of sequence.commands) {
        expect(command.atMs).toBeGreaterThanOrEqual(previous);
        previous = command.atMs;
      }
    }
  });

  it('carries only well-formed records whose ids embed their createdAt', () => {
    for (const sequence of sequences) {
      for (const command of sequence.commands) {
        const record = commandRecord(command);
        if (record === undefined) continue;
        expect(boundViolations(record)).toEqual([]);
        expect(record.mealPlanId).toMatch(ULID);
        expect(mealPlanIdTimestampMs(record.mealPlanId)).toBe(Date.parse(record.createdAt));
        expect(Date.parse(record.updatedAt)).toBeGreaterThanOrEqual(Date.parse(record.createdAt));
        // A created record is untouched: `updatedAt` equals `createdAt` (Req 5.2).
        if (command.kind === 'create') expect(record.updatedAt).toBe(record.createdAt);
      }
    }
  });

  it('classifies every target: known ids are created earlier, unknown ids never are', () => {
    for (const sequence of sequences) {
      const introduced = new Set<string>();
      for (const command of sequence.commands) {
        const mealPlanId = commandMealPlanId(command);
        if (command.kind === 'create') {
          expect(sequence.createdMealPlanIds).toContain(mealPlanId);
          introduced.add(mealPlanId);
          continue;
        }
        if (command.target === 'known') {
          expect(introduced.has(mealPlanId)).toBe(true);
        } else {
          expect(sequence.createdMealPlanIds).not.toContain(mealPlanId);
        }
      }
      expect(new Set(sequence.createdMealPlanIds).size).toBe(sequence.createdMealPlanIds.length);
      expect(Array.from(introduced)).toEqual(sequence.createdMealPlanIds);
    }
  });

  it('resubmits repeat creates verbatim', () => {
    let sawRepeat = false;
    for (const sequence of sequences) {
      const firstCreate = new Map<string, MealPlanRecord>();
      for (const command of sequence.commands) {
        if (command.kind !== 'create') continue;
        if (command.intent === 'fresh') {
          expect(firstCreate.has(command.record.mealPlanId)).toBe(false);
          firstCreate.set(command.record.mealPlanId, command.record);
          continue;
        }
        sawRepeat = true;
        expect(command.record).toEqual(firstCreate.get(command.record.mealPlanId));
      }
    }
    expect(sawRepeat).toBe(true);
  });

  it('reaches and exceeds the record cap', () => {
    const freshCounts = sequences.map((s) => s.createdMealPlanIds.length);
    expect(freshCounts.some((count) => count === MEAL_PLAN_RECORD_CAP)).toBe(true);
    expect(freshCounts.some((count) => count > MEAL_PLAN_RECORD_CAP)).toBe(true);
  });

  it('covers every shape, command kind, and target class', () => {
    expect(new Set(sequences.map((s) => s.shape))).toEqual(
      new Set(['short', 'mixed', 'fill-cap', 'over-cap', 'cap-churn']),
    );

    const commands = sequences.flatMap((s) => s.commands);
    expect(new Set(commands.map((c) => c.kind))).toEqual(
      new Set(['create', 'update', 'rename', 'delete']),
    );
    expect(
      new Set(commands.filter((c) => c.kind !== 'create').map((c) => c.target)),
    ).toEqual(new Set(['known', 'unknown']));
    expect(new Set(commands.filter((c) => c.kind === 'create').map((c) => c.intent))).toEqual(
      new Set(['fresh', 'repeat']),
    );
  });

  it('replays against the in-memory repository without a serializer rejection', async () => {
    for (const sequence of fc.sample(arbCommandSequence(), REPLAY_SAMPLE)) {
      const repository = freshRepository();
      const outcomes = new Set<string>();

      for (const command of sequence.commands) {
        switch (command.kind) {
          case 'create':
            outcomes.add(
              (await repository.create(sequence.userId, command.record, command.ackStorage)).kind,
            );
            break;
          case 'update':
            outcomes.add((await repository.update(sequence.userId, command.record)).kind);
            break;
          case 'rename':
            outcomes.add(
              (
                await repository.rename(
                  sequence.userId,
                  command.mealPlanId,
                  command.title,
                  command.atMs,
                )
              ).kind,
            );
            break;
          case 'delete':
            await repository.delete(sequence.userId, command.mealPlanId);
            break;
        }
      }

      // Every command was accepted or refused by a store condition — never by the
      // serializer, which would have thrown rather than returned an outcome.
      const stored = await repository.listAll(sequence.userId);
      expect(stored.length).toBeLessThanOrEqual(MEAL_PLAN_RECORD_CAP);
      for (const kind of Array.from(outcomes)) {
        expect(['created', 'updated', 'not-found', 'cap-reached', 'ack-required']).toContain(kind);
      }
    }
  });
});

/** Enough draws that all ten causes and every sub-variant appear. */
const TOKEN_SAMPLE = { seed: 20240607, numRuns: 420 } as const;

/** Causes for which no credential reaches the verifier at all (Requirement 4.2). */
const MISSING_CAUSES: readonly UnusableTokenCause[] = ['absent', 'blank', 'wrong-scheme'];

/**
 * Causes whose credential is perfect in every respect the verifier checks
 * locally. `wrong-scheme` is offered under the wrong scheme, `over-length` is
 * merely too long, and the last three are rejected only by what the
 * Auth_Service says about the Account — so all five must carry a credential
 * that would otherwise verify.
 */
const USABLE_CREDENTIAL_CAUSES: readonly UnusableTokenCause[] = [
  'wrong-scheme',
  'over-length',
  'revoked',
  'disabled',
  'deleted',
];

interface DecodedToken {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signatureValid: boolean;
}

/** Decodes a credential and checks its RS256 signature with Node, not `jose`. */
function decodeToken(token: string, publicKey: KeyObject): DecodedToken | null {
  const segments = token.split('.');
  if (segments.length !== 3) return null;

  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(Buffer.from(segments[0], 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (header === null || typeof header !== 'object' || Array.isArray(header)) return null;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;

  const signatureValid = verifyBytes(
    'sha256',
    Buffer.from(`${segments[0]}.${segments[1]}`, 'ascii'),
    publicKey,
    Buffer.from(segments[2], 'base64url'),
  );

  return {
    header: header as Record<string, unknown>,
    payload: payload as Record<string, unknown>,
    signatureValid,
  };
}

/**
 * Whether the credential passes every check the verifier makes without asking
 * the Auth_Service about the Account: RS256 under the published `kid`, a valid
 * signature, the project's `iss` and `aud`, a non-empty `sub`, an `auth_time`
 * not in the future, and an `exp` inside the 60-second tolerance.
 */
function isLocallyUsable(kit: UnusableTokenKit, token: string | null): boolean {
  if (token === null) return false;
  const publicKey = new X509Certificate(kit.certificateDocument[kit.kid]).publicKey;
  const decoded = decodeToken(token, publicKey);
  if (decoded === null || !decoded.signatureValid) return false;

  const { header, payload } = decoded;
  if (header.alg !== 'RS256' || header.kid !== kit.kid) return false;
  if (payload.iss !== `https://securetoken.google.com/${kit.projectId}`) return false;
  if (payload.aud !== kit.projectId) return false;
  if (typeof payload.sub !== 'string' || payload.sub === '') return false;

  const exp = payload.exp;
  const authTime = payload.auth_time;
  if (typeof exp !== 'number' || typeof authTime !== 'number') return false;
  if (exp * 1000 <= kit.nowMs - CLOCK_TOLERANCE_SECONDS * 1000) return false;
  return authTime * 1000 <= kit.nowMs;
}

/** The single user record an `accounts:lookup` answer carries, if it carries one. */
function lookupUser(token: UnusableToken): Record<string, unknown> | null {
  const body = token.lookupResponse.body;
  if (body === null || typeof body !== 'object') return null;
  const users = (body as { users?: unknown }).users;
  if (!Array.isArray(users) || users.length === 0) return null;
  const user = users[0];
  if (user === null || typeof user !== 'object' || Array.isArray(user)) return null;
  return user as Record<string, unknown>;
}

describe('arbUnusableToken', () => {
  // One kit per suite: each carries two generated RSA key pairs.
  const kit = createUnusableTokenKit();
  const cases = fc.sample(arbUnusableToken(kit), TOKEN_SAMPLE);
  const byCause = (cause: UnusableTokenCause): UnusableToken[] =>
    cases.filter((entry) => entry.cause === cause);

  it('covers every cause the requirement set names', () => {
    expect(new Set(cases.map((entry) => entry.cause))).toEqual(new Set(UNUSABLE_TOKEN_CAUSES));
    expect(UNUSABLE_TOKEN_CAUSES).toHaveLength(10);
  });

  it('tags each case with the VerifyResult kind the verifier owes it', () => {
    for (const entry of cases) {
      const expected = MISSING_CAUSES.includes(entry.cause) ? 'missing' : 'invalid';
      expect(entry.expectedKind).toBe(expected);
    }
  });

  it('carries a header for every case except the absent one', () => {
    for (const entry of cases) {
      if (entry.cause === 'absent') {
        expect(entry.authorization).toBeNull();
        expect(entry.token).toBeNull();
        expect(entry.userId).toBeNull();
        continue;
      }
      expect(typeof entry.authorization).toBe('string');
      // A blank header carries no credential by definition; everything else does.
      expect(entry.token === null).toBe(entry.cause === 'blank');
    }
  });

  it('offers the credential under a scheme that is never Bearer for the wrong-scheme case', () => {
    const schemes = new Set(
      byCause('wrong-scheme').map((entry) => (entry.authorization ?? '').split(' ')[0]),
    );
    expect(schemes.size).toBeGreaterThan(1);
    for (const scheme of Array.from(schemes)) {
      expect(scheme.toLowerCase()).not.toBe('bearer');
    }
  });

  it('trips the length guard only for the over-length case', () => {
    for (const entry of cases) {
      if (entry.token === null) continue;
      const overGuard = entry.token.length > AUTH_TOKEN_MAX_CHARS;
      expect(overGuard).toBe(entry.cause === 'over-length');
    }
    // The off-by-one boundary is drawn, not merely approached.
    const shortest = Math.min(...byCause('over-length').map((entry) => entry.token?.length ?? 0));
    expect(shortest).toBeGreaterThan(AUTH_TOKEN_MAX_CHARS);
    expect(shortest).toBeLessThan(AUTH_TOKEN_MAX_CHARS * 2);
  });

  it('breaks the credential itself only where that is the cause under test', () => {
    for (const entry of cases) {
      expect(isLocallyUsable(kit, entry.token)).toBe(
        USABLE_CREDENTIAL_CAUSES.includes(entry.cause),
      );
    }
  });

  it('expires the expired case by 61 to 10,000 seconds, past the tolerance', () => {
    const publicKey = new X509Certificate(kit.certificateDocument[kit.kid]).publicKey;
    const agesSeconds: number[] = [];

    for (const entry of byCause('expired')) {
      const decoded = decodeToken(entry.token ?? '', publicKey);
      expect(decoded?.signatureValid).toBe(true);
      const exp = decoded?.payload.exp;
      const authTime = decoded?.payload.auth_time;
      expect(typeof exp).toBe('number');
      expect(typeof authTime).toBe('number');

      const ageSeconds = (kit.nowMs - (exp as number) * 1000) / 1000;
      expect(ageSeconds).toBeGreaterThan(CLOCK_TOLERANCE_SECONDS);
      expect(ageSeconds).toBeLessThanOrEqual(10_000);
      expect(authTime as number).toBeLessThanOrEqual(exp as number);
      agesSeconds.push(ageSeconds);
    }

    // 61 seconds is the first instant Requirement 4.3 calls expired.
    expect(agesSeconds).toContain(61);
    expect(agesSeconds).toContain(10_000);
  });

  it('makes the revoked, disabled, and removed answers controllable and correct', () => {
    for (const entry of byCause('revoked')) {
      const user = lookupUser(entry);
      expect(user?.disabled).toBe(false);
      expect(Number(user?.validSince) * 1000).toBeGreaterThan(kit.nowMs - 60_000);
    }

    for (const entry of byCause('disabled')) {
      expect(lookupUser(entry)?.disabled).toBe(true);
    }

    for (const entry of byCause('deleted')) {
      // No usable user record, whichever of the three shapes was drawn.
      expect(lookupUser(entry)).toBeNull();
    }
    expect(new Set(byCause('deleted').map((entry) => entry.lookupResponse.status))).toEqual(
      new Set([200, 400]),
    );
  });

  it('answers with an active Account for every case that never reaches the lookup', () => {
    for (const entry of cases) {
      if (['revoked', 'disabled', 'deleted'].includes(entry.cause)) continue;
      const user = lookupUser(entry);
      expect(user?.disabled).toBe(false);
      if (entry.userId !== null) expect(user?.localId).toBe(entry.userId);
    }
  });

  it('permits an outbound request only where the requirements allow one', () => {
    for (const entry of cases) {
      const preNetwork = ['absent', 'blank', 'wrong-scheme', 'over-length'].includes(entry.cause);
      // Requirement 4.7 in particular: an over-length credential sends nothing.
      if (preNetwork) expect(entry.reachesAuthService).toBe(false);
      if (['wrong-key-signed', 'expired', 'revoked', 'disabled', 'deleted'].includes(entry.cause)) {
        expect(entry.reachesAuthService).toBe(true);
      }
    }
    expect(new Set(byCause('garbage').map((entry) => entry.reachesAuthService))).toEqual(
      new Set([true, false]),
    );
  });

  it('covers every blank, scheme, and garbage variant', () => {
    expect(new Set(byCause('blank').map((entry) => entry.authorization)).size).toBe(5);
    expect(new Set(byCause('wrong-scheme').map((entry) => entry.detail)).size).toBe(6);
    expect(new Set(byCause('garbage').map((entry) => entry.detail)).size).toBe(7);
  });

  it('replays identically for a given seed and kit', () => {
    const again = fc.sample(arbUnusableToken(kit), TOKEN_SAMPLE);
    expect(again).toEqual(cases);
  });
});
