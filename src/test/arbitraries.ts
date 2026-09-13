/**
 * Shared `fast-check` generators for the Meal_Plan property tests.
 *
 * Two rules shape everything in this file:
 *
 * 1. **Generation is deterministic given the seed.** Nothing here reads the
 *    clock or a global PRNG, so a reported counterexample replays exactly. That
 *    is why Meal_Plan_Ids are built through a seeded ULID factory rather than
 *    `newMealPlanId(nowMs)`, which draws from a non-reproducible source; the
 *    output shape and the embedded timestamp are identical either way.
 * 2. **A "valid" record is valid under either reading of "characters".**
 *    Requirement 9.7 states its bounds in characters, which could mean UTF-16
 *    code units or Unicode code points. Every generated string satisfies both
 *    counts, so a property failure is a real failure and not an argument about
 *    the unit. Conversely, `arbInvalidMealPlanRecord()` breaks a bound under
 *    both readings by using ASCII-only over-long values.
 *
 * Strings never contain a lone surrogate: chunks contribute whole code points
 * and all trimming is done code point by code point. The serializer rejects lone
 * surrogates as a `wrong-type` error, so they belong in a corruption generator,
 * not in the valid-record generator.
 */

import { sign as signBytes, type KeyObject } from 'node:crypto';

import fc from 'fast-check';
import { factory } from 'ulid';

import { serializeMealPlanRecord } from '@/lib/mealPlanSerializer';
import type { MealPlanItem } from '@/lib/mealPlanSerializer';
import type { AccountSeed } from '@/lib/server/inMemoryMealPlanRepository';
import {
  AUTH_TOKEN_MAX_CHARS,
  CLOCK_TOLERANCE_SECONDS,
} from '@/lib/server/joseAuthTokenVerifier';
import { MEAL_PLAN_PAGE_SIZE, MEAL_PLAN_RECORD_CAP } from '@/lib/server/mealPlanRepository';
import type {
  MealEntry,
  MealPlanContent,
  MealPlanItemEntry,
  MealPlanRecord,
} from '@/lib/types';

import { createTestSigningKeyPair } from './testCertificate';

// ─── Bounds (Requirement 9.7) ──────────────────────────────────────────────────

/**
 * Every bound the Meal_Plan_Serializer enforces, in one place, so the generators
 * and the serializer tests cannot drift apart.
 */
export const MEAL_PLAN_BOUNDS = {
  meals: { min: 1, max: 10 },
  itemsPerMeal: { min: 1, max: 20 },
  warnings: { min: 0, max: 20 },
  title: { min: 1, max: 200 },
  mealName: { min: 1, max: 100 },
  itemName: { min: 1, max: 200 },
  portion: { min: 1, max: 100 },
  itemNote: { min: 0, max: 1000 },
  summary: { min: 0, max: 5000 },
  warning: { min: 1, max: 500 },
} as const;

// ─── arbTrickyString ───────────────────────────────────────────────────────────

/** Latin-1 range accents and punctuation. */
const LATIN1 = [
  'é', 'è', 'ê', 'ë', 'à', 'â', 'ä', 'ö', 'ü', 'ñ',
  'ç', 'ß', 'ø', 'å', 'Æ', 'œ', '¿', '¡', '°', 'µ',
];

/** Emoji built from surrogate pairs, plus ZWJ, flag, and variation sequences. */
const EMOJI_SEQUENCES = ['👩‍👩‍👦', '👨🏽‍🍳', '🇯🇵', '🇮🇸', '🏳️‍🌈', '☺️', '❤️', '1️⃣'];

/** Right-to-left letters together with the bidi marks and overrides. */
const RTL = ['א', 'ב', 'ש', 'ת', 'ع', 'ب', 'ي', 'ق', '\u200f', '\u200e', '\u202e', '\u202c'];

/** Line and tab separators, including the two-unit `\r\n` pair. */
const SEPARATORS = ['\n', '\r\n', '\r', '\t', ' ', '\u00a0', '\u2028', '\u2029'];

/** Quotation marks and backslash escapes that survive naive escaping code. */
const QUOTES_AND_ESCAPES = [
  "'", '"', '`', '\\', '\\\\', '\\"', "\\'", '\\n', '\\u0041', '/', '<', '>', '&',
];

/** Sequences that look like an interpolation or a reserved store key. */
const INTERPOLATION_LOOKALIKES = [
  '${}', '${x}', '${process.env.SECRET}', '#{y}', '{{z}}', '%s', '%d', '{0}', '$(whoami)', '#meta',
];

/** Single-code-unit filler used to pad a value up to its minimum length. */
const FILLER = ['a', 'é', '\t', '"', "'", '\\', '中', 'ש', '$'];

const fromCodePoint = (cp: number): string => String.fromCodePoint(cp);

/** One CJK, kana, or Hangul code point. */
const arbCjkChar = fc.oneof(
  fc.integer({ min: 0x4e00, max: 0x9fff }).map(fromCodePoint), // unified ideographs
  fc.integer({ min: 0x3041, max: 0x3096 }).map(fromCodePoint), // hiragana
  fc.integer({ min: 0x30a1, max: 0x30fa }).map(fromCodePoint), // katakana
  fc.integer({ min: 0xac00, max: 0xd7a3 }).map(fromCodePoint), // Hangul syllables
);

/** One astral-plane emoji, i.e. a surrogate pair. */
const arbEmojiChar = fc.oneof(
  fc.integer({ min: 0x1f300, max: 0x1f5ff }).map(fromCodePoint),
  fc.integer({ min: 0x1f600, max: 0x1f64f }).map(fromCodePoint),
  fc.integer({ min: 0x1f900, max: 0x1f9ff }).map(fromCodePoint),
);

/** A base letter carrying one to three combining marks. */
const arbCombiningCluster = fc
  .tuple(
    fc.constantFrom('a', 'e', 'o', 'n', 'ᄀ', '中'),
    fc.array(fc.integer({ min: 0x0300, max: 0x036f }).map(fromCodePoint), {
      minLength: 1,
      maxLength: 3,
    }),
  )
  .map(([base, marks]) => base + marks.join(''));

/**
 * One fragment of a tricky string. Weighted so ASCII dominates — the point is
 * that awkward input hides inside otherwise ordinary text, not that every value
 * is unreadable.
 */
const arbTrickyChunk: fc.Arbitrary<string> = fc.oneof(
  { weight: 10, arbitrary: fc.char() },
  { weight: 3, arbitrary: fc.constantFrom(...LATIN1) },
  { weight: 3, arbitrary: arbCjkChar },
  { weight: 3, arbitrary: arbEmojiChar },
  { weight: 2, arbitrary: fc.constantFrom(...EMOJI_SEQUENCES) },
  { weight: 2, arbitrary: arbCombiningCluster },
  { weight: 2, arbitrary: fc.constantFrom(...RTL) },
  { weight: 2, arbitrary: fc.constantFrom(...SEPARATORS) },
  { weight: 2, arbitrary: fc.constantFrom(...QUOTES_AND_ESCAPES) },
  { weight: 2, arbitrary: fc.constantFrom(...INTERPOLATION_LOOKALIKES) },
);

/**
 * Trims `raw` to fit `[min, max]` under both length readings.
 *
 * Code points are kept whole, and enough room is reserved for the filler needed
 * to reach `min`, so the result satisfies
 * `min <= codePointCount <= utf16Length <= max`.
 */
function fitToBounds(raw: string, min: number, max: number): string {
  const kept: string[] = [];
  let units = 0;
  let codePoints = 0;

  for (const codePoint of raw) {
    const nextUnits = units + codePoint.length;
    const nextCodePoints = codePoints + 1;
    const fillerNeeded = Math.max(0, min - nextCodePoints);
    if (nextUnits + fillerNeeded > max) break;
    kept.push(codePoint);
    units = nextUnits;
    codePoints = nextCodePoints;
  }

  let out = kept.join('');
  while (codePoints < min) {
    out += FILLER[codePoints % FILLER.length];
    codePoints += 1;
  }
  return out;
}

/**
 * Generates an awkward but well-formed string whose length lies in
 * `[min, max]` counted either in UTF-16 code units or in Unicode code points.
 *
 * Draws from ASCII, Latin-1 accents, CJK, emoji including surrogate pairs and
 * ZWJ sequences, combining marks, right-to-left text with bidi overrides, `\n`,
 * `\r\n`, `\t`, quotation marks, backslashes, and `${}`-looking sequences. It is
 * the default generator for every string field, not only the ones where
 * non-ASCII is expected — that is what Requirement 9.6 asks for.
 *
 * Values close to a large `min` carry a tricky prefix followed by
 * single-code-unit filler, since building thousands of tricky chunks per run
 * costs far more than it finds.
 *
 * @param min Minimum length, at least 0.
 * @param max Maximum length, at least `min`.
 */
export function arbTrickyString(min: number, max: number): fc.Arbitrary<string> {
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min) {
    throw new RangeError(`arbTrickyString: bad bounds ${min}..${max}`);
  }
  if (max === 0) return fc.constant('');

  // Chunk count is capped: `fitToBounds` pads up to `min`, so a long minimum
  // does not require a proportionally long chunk array.
  const chunkCount = Math.min(max, 48);
  return fc
    .array(arbTrickyChunk, { minLength: 0, maxLength: chunkCount, size: 'max' })
    .map((chunks) => fitToBounds(chunks.join(''), min, max));
}

/**
 * A string field generator biased toward its bounds: mostly short values, with
 * exact-minimum and exact-maximum lengths drawn regularly.
 */
function arbFieldString(min: number, max: number): fc.Arbitrary<string> {
  const mid = Math.min(max, Math.max(min, 48));
  return fc.oneof(
    { weight: 6, arbitrary: arbTrickyString(min, mid) },
    { weight: 2, arbitrary: arbTrickyString(min, min) },
    { weight: 2, arbitrary: arbTrickyString(max, max) },
  );
}

/** A count generator biased toward both ends of `[min, max]`. */
function arbBoundedCount(min: number, max: number): fc.Arbitrary<number> {
  return fc.oneof(
    { weight: 3, arbitrary: fc.constant(min) },
    { weight: 3, arbitrary: fc.constant(max) },
    { weight: 4, arbitrary: fc.integer({ min, max }) },
  );
}

// ─── arbMealPlanRecord ─────────────────────────────────────────────────────────

/**
 * How a record's optional values are populated. The four named modes cover every
 * present/absent combination of item `notes` and plan `warnings` that Property 2
 * needs; `mixed` additionally varies `notes` item by item.
 */
type Optionality = 'neither' | 'notes-only' | 'warnings-only' | 'both' | 'mixed';

const arbOptionality: fc.Arbitrary<Optionality> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.constantFrom<Optionality[]>('neither', 'notes-only', 'warnings-only', 'both'),
  },
  { weight: 1, arbitrary: fc.constant<Optionality>('mixed') },
);

/** Firebase-shaped User_Id: 20 to 36 characters of base-62. */
const USER_ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');

const arbUserId = fc.stringOf(fc.constantFrom(...USER_ID_CHARS), {
  minLength: 20,
  maxLength: 36,
});

/** 2020-01-01T00:00:00Z through 2035-01-01T00:00:00Z. */
const CREATED_AT_MIN_MS = Date.UTC(2020, 0, 1);
const CREATED_AT_MAX_MS = Date.UTC(2035, 0, 1);

const arbCreatedAtMs = fc.integer({ min: CREATED_AT_MIN_MS, max: CREATED_AT_MAX_MS });

/**
 * Builds a ULID whose leading 48 bits hold `createdAtMs`, using a seeded PRNG so
 * the value is reproducible across runs. Equivalent in shape to
 * `newMealPlanId(createdAtMs)`.
 */
function seededMealPlanId(createdAtMs: number, seed: number): string {
  let state = (seed >>> 0) || 1;
  const prng = (): number => {
    // Numerical Recipes LCG — deterministic, and the statistical quality of the
    // random half of a ULID does not matter to any property under test.
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  return factory(prng)(createdAtMs);
}

/** ISO-8601 UTC with exactly three fractional digits — Requirement 9.1. */
function isoUtcMillis(ms: number): string {
  return new Date(ms).toISOString();
}

function arbItem(optionality: Optionality): fc.Arbitrary<MealPlanItemEntry> {
  const notesPresent: fc.Arbitrary<boolean> =
    optionality === 'notes-only' || optionality === 'both'
      ? fc.constant(true)
      : optionality === 'mixed'
        ? fc.boolean()
        : fc.constant(false);

  return fc
    .record({
      name: arbFieldString(MEAL_PLAN_BOUNDS.itemName.min, MEAL_PLAN_BOUNDS.itemName.max),
      portion: arbFieldString(MEAL_PLAN_BOUNDS.portion.min, MEAL_PLAN_BOUNDS.portion.max),
      // A present note is never empty: the zero-length boundary of the 0..1000
      // note bound is covered by the note being absent, and a present `''` would
      // collide with the absent/empty distinction of Requirements 9.4 and 9.9 —
      // the same reason a present `warnings` list is never empty.
      notes: arbFieldString(1, MEAL_PLAN_BOUNDS.itemNote.max),
      notesPresent,
    })
    .map(({ name, portion, notes, notesPresent: present }) =>
      // The key is omitted entirely when absent — never set to '' (Req 9.4).
      present ? { name, portion, notes } : { name, portion },
    );
}

function arbMeal(optionality: Optionality): fc.Arbitrary<MealEntry> {
  return fc
    .record({
      mealName: arbFieldString(MEAL_PLAN_BOUNDS.mealName.min, MEAL_PLAN_BOUNDS.mealName.max),
      itemCount: arbBoundedCount(
        MEAL_PLAN_BOUNDS.itemsPerMeal.min,
        MEAL_PLAN_BOUNDS.itemsPerMeal.max,
      ),
    })
    .chain(({ mealName, itemCount }) =>
      fc
        .array(arbItem(optionality), { minLength: itemCount, maxLength: itemCount })
        .map((items) => ({ mealName, items })),
    );
}

function arbContent(optionality: Optionality): fc.Arbitrary<MealPlanContent> {
  const warningsPresent = optionality === 'warnings-only' || optionality === 'both';
  // "Absent" covers the zero-warnings boundary; a present list is never empty.
  const warningCount = warningsPresent
    ? arbBoundedCount(1, MEAL_PLAN_BOUNDS.warnings.max)
    : fc.constant(0);

  return fc
    .record({
      mealCount: arbBoundedCount(MEAL_PLAN_BOUNDS.meals.min, MEAL_PLAN_BOUNDS.meals.max),
      warningCount,
      summary: arbFieldString(MEAL_PLAN_BOUNDS.summary.min, MEAL_PLAN_BOUNDS.summary.max),
    })
    .chain(({ mealCount, warningCount: warnings, summary }) =>
      fc
        .tuple(
          fc.array(arbMeal(optionality), { minLength: mealCount, maxLength: mealCount }),
          fc.array(arbFieldString(MEAL_PLAN_BOUNDS.warning.min, MEAL_PLAN_BOUNDS.warning.max), {
            minLength: warnings,
            maxLength: warnings,
          }),
        )
        .map(([meals, warningList]) =>
          warningsPresent
            ? { meals, summary, warnings: warningList }
            : { meals, summary },
        ),
    );
}

/**
 * Generates a Meal_Plan_Record that satisfies every bound in Requirement 9.7.
 *
 * Biased toward the boundaries — 1 and 10 meals, 1 and 20 items, absent and 20
 * warnings, minimum- and maximum-length strings — and toward all four
 * present/absent combinations of `notes` and `warnings`, since those are the
 * combinations the round-trip and optionality properties turn on.
 *
 * `mealPlanId` is a 26-character ULID whose embedded millisecond timestamp
 * equals `createdAt`, and `updatedAt` is never earlier than `createdAt`.
 */
export function arbMealPlanRecord(): fc.Arbitrary<MealPlanRecord> {
  return arbOptionality.chain((optionality) =>
    fc
      .record({
        userId: arbUserId,
        createdAtMs: arbCreatedAtMs,
        // Weighted so an untouched record (updatedAt === createdAt) is common.
        updatedAfterMs: fc.oneof(
          { weight: 3, arbitrary: fc.constant(0) },
          { weight: 1, arbitrary: fc.integer({ min: 0, max: 400 * 24 * 60 * 60 * 1000 }) },
        ),
        idSeed: fc.integer({ min: 1, max: 0x7fff_ffff }),
        title: arbFieldString(MEAL_PLAN_BOUNDS.title.min, MEAL_PLAN_BOUNDS.title.max),
        content: arbContent(optionality),
      })
      .map(({ userId, createdAtMs, updatedAfterMs, idSeed, title, content }) => ({
        userId,
        mealPlanId: seededMealPlanId(createdAtMs, idSeed),
        title,
        createdAt: isoUtcMillis(createdAtMs),
        updatedAt: isoUtcMillis(createdAtMs + updatedAfterMs),
        content,
      })),
  );
}

// ─── arbInvalidMealPlanRecord ──────────────────────────────────────────────────

/** How a bound was broken, for the assertion message and for triage. */
export type BoundViolation = 'too-few' | 'too-many' | 'too-short' | 'too-long';

/**
 * A record violating exactly one bound, together with the field path the
 * Meal_Plan_Serializer is required to name in its error (Requirement 9.8).
 *
 * `brokenField` uses dotted paths with bracketed indices, e.g. `title`,
 * `content.meals`, `content.meals[2].items[5].portion`, `content.warnings[3]`.
 */
export interface InvalidMealPlanRecord {
  record: MealPlanRecord;
  brokenField: string;
  violation: BoundViolation;
}

/** Pads an ASCII base value to exactly `length` characters. */
function asciiOfLength(length: number): string {
  return 'x'.repeat(length);
}

const VIOLATION_KINDS = [
  'title-short',
  'title-long',
  'meals-few',
  'meals-many',
  'items-few',
  'items-many',
  'warnings-many',
  'meal-name-short',
  'meal-name-long',
  'item-name-short',
  'item-name-long',
  'portion-short',
  'portion-long',
  'note-long',
  'summary-long',
  'warning-short',
  'warning-long',
] as const;

type ViolationKind = (typeof VIOLATION_KINDS)[number];

/** Replaces one element of an array, leaving the rest untouched. */
function replaceAt<T>(items: readonly T[], index: number, value: T): T[] {
  const copy = items.slice();
  copy[index] = value;
  return copy;
}

/** Repeats `seed` values until the array holds exactly `length` entries. */
function grownTo<T>(seed: readonly T[], length: number): T[] {
  const out: T[] = [];
  for (let i = 0; i < length; i += 1) out.push(seed[i % seed.length]);
  return out;
}

/**
 * Generates a Meal_Plan_Record in which exactly one bound from Requirement 9.7
 * is violated, so a property can assert that the serializer names that specific
 * field and produces no item.
 *
 * Over-long values are pure ASCII of length `max + 1`, so the bound is exceeded
 * whether the serializer counts code units or code points; too-short values are
 * the empty string. Everything else in the record stays valid — over-full
 * collections are grown by repeating already-valid entries.
 */
export function arbInvalidMealPlanRecord(): fc.Arbitrary<InvalidMealPlanRecord> {
  return fc
    .record({
      base: arbMealPlanRecord(),
      kind: fc.constantFrom<ViolationKind[]>(...VIOLATION_KINDS),
      mealPick: fc.nat(),
      itemPick: fc.nat(),
      warningPick: fc.nat(),
      spareWarning: arbFieldString(MEAL_PLAN_BOUNDS.warning.min, MEAL_PLAN_BOUNDS.warning.max),
    })
    .map(({ base, kind, mealPick, itemPick, warningPick, spareWarning }) => {
      const { content } = base;
      const mealIndex = mealPick % content.meals.length;
      const meal = content.meals[mealIndex];
      const itemIndex = itemPick % meal.items.length;
      const warnings = content.warnings ?? [spareWarning];
      const warningIndex = warningPick % warnings.length;

      const withContent = (next: MealPlanContent): MealPlanRecord => ({ ...base, content: next });
      const withMeal = (next: MealEntry): MealPlanRecord =>
        withContent({ ...content, meals: replaceAt(content.meals, mealIndex, next) });
      const withItem = (next: MealPlanItemEntry): MealPlanRecord =>
        withMeal({ ...meal, items: replaceAt(meal.items, itemIndex, next) });
      const withWarnings = (next: string[]): MealPlanRecord =>
        withContent({ ...content, warnings: next });

      const B = MEAL_PLAN_BOUNDS;

      switch (kind) {
        case 'title-short':
          return { record: { ...base, title: '' }, brokenField: 'title', violation: 'too-short' as const };
        case 'title-long':
          return {
            record: { ...base, title: asciiOfLength(B.title.max + 1) },
            brokenField: 'title',
            violation: 'too-long' as const,
          };
        case 'meals-few':
          return {
            record: withContent({ ...content, meals: [] }),
            brokenField: 'content.meals',
            violation: 'too-few' as const,
          };
        case 'meals-many':
          return {
            record: withContent({ ...content, meals: grownTo(content.meals, B.meals.max + 1) }),
            brokenField: 'content.meals',
            violation: 'too-many' as const,
          };
        case 'items-few':
          return {
            record: withMeal({ ...meal, items: [] }),
            brokenField: `content.meals[${mealIndex}].items`,
            violation: 'too-few' as const,
          };
        case 'items-many':
          return {
            record: withMeal({
              ...meal,
              items: grownTo(meal.items, B.itemsPerMeal.max + 1),
            }),
            brokenField: `content.meals[${mealIndex}].items`,
            violation: 'too-many' as const,
          };
        case 'warnings-many':
          return {
            record: withWarnings(grownTo(warnings, B.warnings.max + 1)),
            brokenField: 'content.warnings',
            violation: 'too-many' as const,
          };
        case 'meal-name-short':
          return {
            record: withMeal({ ...meal, mealName: '' }),
            brokenField: `content.meals[${mealIndex}].mealName`,
            violation: 'too-short' as const,
          };
        case 'meal-name-long':
          return {
            record: withMeal({ ...meal, mealName: asciiOfLength(B.mealName.max + 1) }),
            brokenField: `content.meals[${mealIndex}].mealName`,
            violation: 'too-long' as const,
          };
        case 'item-name-short':
          return {
            record: withItem({ ...meal.items[itemIndex], name: '' }),
            brokenField: `content.meals[${mealIndex}].items[${itemIndex}].name`,
            violation: 'too-short' as const,
          };
        case 'item-name-long':
          return {
            record: withItem({
              ...meal.items[itemIndex],
              name: asciiOfLength(B.itemName.max + 1),
            }),
            brokenField: `content.meals[${mealIndex}].items[${itemIndex}].name`,
            violation: 'too-long' as const,
          };
        case 'portion-short':
          return {
            record: withItem({ ...meal.items[itemIndex], portion: '' }),
            brokenField: `content.meals[${mealIndex}].items[${itemIndex}].portion`,
            violation: 'too-short' as const,
          };
        case 'portion-long':
          return {
            record: withItem({
              ...meal.items[itemIndex],
              portion: asciiOfLength(B.portion.max + 1),
            }),
            brokenField: `content.meals[${mealIndex}].items[${itemIndex}].portion`,
            violation: 'too-long' as const,
          };
        case 'note-long':
          // The note bound has no minimum, so only an over-long value violates it.
          return {
            record: withItem({
              ...meal.items[itemIndex],
              notes: asciiOfLength(B.itemNote.max + 1),
            }),
            brokenField: `content.meals[${mealIndex}].items[${itemIndex}].notes`,
            violation: 'too-long' as const,
          };
        case 'summary-long':
          return {
            record: withContent({ ...content, summary: asciiOfLength(B.summary.max + 1) }),
            brokenField: 'content.summary',
            violation: 'too-long' as const,
          };
        case 'warning-short':
          return {
            record: withWarnings(replaceAt(warnings, warningIndex, '')),
            brokenField: `content.warnings[${warningIndex}]`,
            violation: 'too-short' as const,
          };
        case 'warning-long':
          return {
            record: withWarnings(
              replaceAt(warnings, warningIndex, asciiOfLength(B.warning.max + 1)),
            ),
            brokenField: `content.warnings[${warningIndex}]`,
            violation: 'too-long' as const,
          };
      }
    });
}

// ─── arbMarkedRecord ───────────────────────────────────────────────────────────

/**
 * A Meal_Plan_Record whose every Patient-authored string is a unique marker,
 * together with the complete list of those markers.
 *
 * Properties 13 and 18 both ask a question of the form "did this value reach a
 * place it must not reach?". Answering it by guessing at key names is fragile —
 * a redaction helper that renames a key, or an export that nests a record one
 * level deeper, would silently pass. Marking every field instead lets those
 * properties assert on the *values*: serialize whatever came out and confirm
 * that no marker appears anywhere in it, whatever shape it took.
 */
export interface MarkedMealPlanRecord {
  record: MealPlanRecord;
  /** Every marker planted in `record`, each one unique within the record. */
  markers: string[];
}

/** Leading segment of every marker, so a leak is obvious in a diff or a log. */
export const MARKER_PREFIX = 'MARKER';

/**
 * Generates a Meal_Plan_Record satisfying every bound in Requirement 9.7 whose
 * title, summary, meal names, item names, portions, notes, and warnings are all
 * distinct marker strings.
 *
 * Markers are tagged with a per-record seed and the tail of the record's
 * Meal_Plan_Id, so markers from two records generated in the same run do not
 * collide and a counterexample names which record leaked. Marker text is plain
 * ASCII: these records exist to be searched for, and `arbMealPlanRecord()`
 * already covers awkward Unicode.
 *
 * Counts are biased toward the collection boundaries, and `notes` and
 * `warnings` are drawn present and absent, so the marker set covers records
 * with and without the optional fields.
 */
export function arbMarkedRecord(): fc.Arbitrary<MarkedMealPlanRecord> {
  return fc
    .record({
      userId: arbUserId,
      createdAtMs: arbCreatedAtMs,
      updatedAfterMs: fc.oneof(
        { weight: 3, arbitrary: fc.constant(0) },
        { weight: 1, arbitrary: fc.integer({ min: 0, max: 400 * 24 * 60 * 60 * 1000 }) },
      ),
      idSeed: fc.integer({ min: 1, max: 0x7fff_ffff }),
      markerSeed: fc.integer({ min: 0, max: 0x7fff_ffff }),
      mealCount: arbBoundedCount(MEAL_PLAN_BOUNDS.meals.min, MEAL_PLAN_BOUNDS.meals.max),
      itemCount: arbBoundedCount(
        MEAL_PLAN_BOUNDS.itemsPerMeal.min,
        MEAL_PLAN_BOUNDS.itemsPerMeal.max,
      ),
      notesPresent: fc.boolean(),
      warningCount: arbBoundedCount(MEAL_PLAN_BOUNDS.warnings.min, MEAL_PLAN_BOUNDS.warnings.max),
    })
    .map(
      ({
        userId,
        createdAtMs,
        updatedAfterMs,
        idSeed,
        markerSeed,
        mealCount,
        itemCount,
        notesPresent,
        warningCount,
      }) => {
        const mealPlanId = seededMealPlanId(createdAtMs, idSeed);
        const tag = `${markerSeed.toString(16).padStart(8, '0')}${mealPlanId.slice(-6)}`;

        const markers: string[] = [];
        const marker = (label: string): string => {
          const value = `${MARKER_PREFIX}-${tag}-${label}`;
          markers.push(value);
          return value;
        };

        const title = marker('title');
        const summary = marker('summary');

        const meals: MealEntry[] = [];
        for (let m = 0; m < mealCount; m += 1) {
          const items: MealPlanItemEntry[] = [];
          for (let i = 0; i < itemCount; i += 1) {
            const base: MealPlanItemEntry = {
              name: marker(`m${m}i${i}-name`),
              portion: marker(`m${m}i${i}-portion`),
            };
            // Absent means the key is omitted, never '' — Requirement 9.4.
            items.push(notesPresent ? { ...base, notes: marker(`m${m}i${i}-notes`) } : base);
          }
          meals.push({ mealName: marker(`m${m}-mealName`), items });
        }

        const warnings: string[] = [];
        for (let w = 0; w < warningCount; w += 1) warnings.push(marker(`warning${w}`));

        const content: MealPlanContent =
          warningCount > 0 ? { meals, summary, warnings } : { meals, summary };

        return {
          record: {
            userId,
            mealPlanId,
            title,
            createdAt: isoUtcMillis(createdAtMs),
            updatedAt: isoUtcMillis(createdAtMs + updatedAfterMs),
            content,
          },
          markers,
        };
      },
    );
}
// ─── arbCorruptedItem ──────────────────────────────────────────────────────────

/**
 * How a stored item was broken, matching `MealPlanItemError.reason` exactly so a
 * property can compare the two without translating between vocabularies.
 */
export type ItemCorruption = 'missing' | 'wrong-type';

/**
 * A stored Meal_Plan item carrying exactly one defect, together with the logical
 * attribute path the Meal_Plan_Deserializer is required to name (Requirement 9.5).
 *
 * `attributePath` is the *logical* dotted path, with no DynamoDB type tags in it
 * — `schemaVersion`, `title`, `content.meals[0].items[1].portion` — because that
 * is the form `MealPlanItemError.attribute` uses. The physical item nests an `M`
 * or `L` wrapper at every level; the path deliberately does not mention them.
 */
export interface CorruptedMealPlanItem {
  /**
   * The corrupted item. Typed `unknown` on purpose: it no longer conforms to
   * `MealPlanItem`, and the deserializer's contract is to accept anything.
   */
  item: unknown;
  /** Logical dotted path of the single broken attribute. */
  attributePath: string;
  /** Whether that attribute was deleted or retyped. */
  mutation: ItemCorruption;
}

/** One attribute of a serialized item that can be corrupted, and how. */
interface CorruptionTarget {
  /** Logical dotted path, e.g. `content.meals[2].items[5].portion`. */
  path: string;
  /**
   * Whether deleting the attribute is a defect. False for `content.warnings`
   * and item `notes`, whose absence is legal (Requirements 9.4, 9.9), and false
   * for list *elements*, since removing one just yields a shorter list — also a
   * legal item, and one whose remaining paths would have shifted.
   */
  deletable: boolean;
}

/**
 * Values a well-formed item never holds at any attribute position.
 *
 * Every entry fails as an `S`, an `N`, an `L`, and an `M` alike, so one
 * replacement set covers every target. That rules out plausible-looking swaps
 * such as `{ N: '1' }` (valid at `schemaVersion`), `{ L: [] }` (valid at
 * `content.meals`, since bounds are not re-checked on read), and `{ M: {} }`
 * (valid at `content` until a *nested* read fails, which would name a different
 * path than the one reported).
 */
function wrongTypeReplacement(pick: number): unknown {
  switch (pick % 13) {
    case 0:
      return 42;
    case 1:
      return 'not-an-attribute-value';
    case 2:
      return true;
    case 3:
      return null;
    case 4:
      return [];
    case 5:
      return [{ S: 'a' }];
    case 6:
      return {};
    case 7:
      return { BOOL: true };
    case 8:
      return { NULL: true };
    case 9:
      return { SS: ['a', 'b'] }; // a set type the serializer never writes
    case 10:
      return { NS: ['1', '2'] };
    case 11:
      return { S: 42 }; // right tag, payload of the wrong type
    default:
      return { N: 'not-a-number' };
  }
}

/**
 * Converts a logical attribute path into the physical key sequence that reaches
 * it inside a serialized item, inserting the `M` and `L` wrappers the path omits:
 * `content.meals[1].mealName` becomes
 * `['content', 'M', 'meals', 'L', 1, 'M', 'mealName']`.
 */
function tokensForAttributePath(path: string): Array<string | number> {
  const tokens: Array<string | number> = [];
  path.split('.').forEach((segment, depth) => {
    if (depth > 0) tokens.push('M');
    tokens.push(segment.replace(/\[\d+\]/g, ''));
    for (const bracketed of segment.match(/\[\d+\]/g) ?? []) {
      tokens.push('L', Number(bracketed.slice(1, -1)));
    }
  });
  return tokens;
}

/** How many entries `corruptionTargets` places before the per-meal paths. */
const TOP_LEVEL_TARGET_COUNT = 9;

/** Every attribute of `item` whose corruption the deserializer must report. */
function corruptionTargets(item: MealPlanItem): CorruptionTarget[] {
  // Kept first in the returned array so the generator can bias toward them: a
  // uniform draw over a 10-meal record would reach `schemaVersion` rarely.
  const topLevel: CorruptionTarget[] = [
    { path: 'userId', deletable: true },
    { path: 'mealPlanId', deletable: true },
    { path: 'title', deletable: true },
    { path: 'createdAt', deletable: true },
    { path: 'updatedAt', deletable: true },
    { path: 'schemaVersion', deletable: true },
    { path: 'content', deletable: true },
    { path: 'content.meals', deletable: true },
    { path: 'content.summary', deletable: true },
  ];

  const nested: CorruptionTarget[] = [];
  item.content.M.meals.L.forEach((meal, m) => {
    nested.push({ path: `content.meals[${m}]`, deletable: false });
    nested.push({ path: `content.meals[${m}].mealName`, deletable: true });
    nested.push({ path: `content.meals[${m}].items`, deletable: true });
    meal.M.items.L.forEach((entry, i) => {
      const at = `content.meals[${m}].items[${i}]`;
      nested.push({ path: at, deletable: false });
      nested.push({ path: `${at}.name`, deletable: true });
      nested.push({ path: `${at}.portion`, deletable: true });
      // A present `notes` must still carry the right type, but its absence is legal.
      if (entry.M.notes !== undefined) nested.push({ path: `${at}.notes`, deletable: false });
    });
  });

  const warnings = item.content.M.warnings;
  if (warnings !== undefined) {
    nested.push({ path: 'content.warnings', deletable: false });
    warnings.L.forEach((_, w) =>
      nested.push({ path: `content.warnings[${w}]`, deletable: false }),
    );
  }

  return [...topLevel, ...nested];
}

/**
 * Applies one corruption to a deep copy of `item`, leaving the original intact so
 * a property can hold on to a pristine copy.
 *
 * A serialized item is pure JSON — strings, arrays, and plain objects, with no
 * lone surrogates, since the serializer rejects those — so a JSON round trip is a
 * faithful deep copy here.
 */
function corruptAt(
  item: MealPlanItem,
  path: string,
  mutation: ItemCorruption,
  replacement: unknown,
): unknown {
  const copy: unknown = JSON.parse(JSON.stringify(item));
  const tokens = tokensForAttributePath(path);

  let parent: unknown = copy;
  for (const token of tokens.slice(0, -1)) {
    parent =
      typeof token === 'number'
        ? (parent as unknown[])[token]
        : (parent as Record<string, unknown>)[token];
  }

  const leaf = tokens[tokens.length - 1];
  if (typeof leaf === 'number') {
    (parent as unknown[])[leaf] = replacement; // list elements are never deleted
  } else if (mutation === 'missing') {
    delete (parent as Record<string, unknown>)[leaf];
  } else {
    (parent as Record<string, unknown>)[leaf] = replacement;
  }

  return copy;
}

/**
 * Generates a stored Meal_Plan item that is valid apart from exactly one
 * attribute, which is either absent or of a type the serializer never writes,
 * together with the logical path of that attribute.
 *
 * The single-defect guarantee is what makes the reported path unambiguous: the
 * deserializer stops at the first defect it meets, so if a record could carry
 * two, a property asserting on `attributePath` would be asserting on read order
 * rather than on Requirement 9.5.
 *
 * Every required attribute is a candidate, including `schemaVersion`, and both
 * optional attributes (`content.warnings`, item `notes`) are candidates for
 * retyping though not for deletion, since absent is a legal value for them.
 */
export function arbCorruptedItem(): fc.Arbitrary<CorruptedMealPlanItem> {
  return fc
    .record({
      record: arbMealPlanRecord(),
      // Top-level attributes would otherwise be swamped by the nested paths of a
      // 10-meal, 20-item record.
      scope: fc.constantFrom<Array<'top-level' | 'anywhere'>>('top-level', 'anywhere'),
      targetPick: fc.nat(),
      replacementPick: fc.nat(),
      preferDeletion: fc.boolean(),
    })
    .map(({ record, scope, targetPick, replacementPick, preferDeletion }) => {
      const item = serializeMealPlanRecord(record);
      const targets = corruptionTargets(item);
      const pool = scope === 'top-level' ? targets.slice(0, TOP_LEVEL_TARGET_COUNT) : targets;
      const target = pool[targetPick % pool.length];
      const mutation: ItemCorruption =
        preferDeletion && target.deletable ? 'missing' : 'wrong-type';

      return {
        item: corruptAt(item, target.path, mutation, wrongTypeReplacement(replacementPick)),
        attributePath: target.path,
        mutation,
      };
    });
}

// ─── Shared pieces for the store generators ────────────────────────────────────

/**
 * Deep copy of a JSON-shaped value.
 *
 * Every record these generators hand out is a fresh copy, so a test that mutates
 * one record — or a repository that stores a reference — cannot reach back into
 * another command or another Account's seed.
 */
function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Title and content reused across many records, so a large store stays cheap to build. */
interface RecordTemplate {
  title: string;
  content: MealPlanContent;
}

/**
 * A small but well-formed title and content pair.
 *
 * Deliberately compact: the store and command generators build up to a few
 * hundred records per run, and the bound boundaries these records would
 * otherwise cover are already `arbMealPlanRecord()`'s job. Strings still come
 * from `arbTrickyString`, so awkward Unicode reaches the store paths too.
 */
const arbRecordTemplate: fc.Arbitrary<RecordTemplate> = fc
  .record({
    title: arbTrickyString(1, 40),
    meals: fc.array(
      fc.record({
        mealName: arbTrickyString(1, 24),
        items: fc.array(
          fc.record({
            name: arbTrickyString(1, 24),
            portion: arbTrickyString(1, 12),
            notes: fc.option(arbTrickyString(1, 24), { nil: undefined }),
          }),
          { minLength: 1, maxLength: 3 },
        ),
      }),
      { minLength: 1, maxLength: 2 },
    ),
    summary: arbTrickyString(0, 40),
    warnings: fc.option(fc.array(arbTrickyString(1, 24), { minLength: 1, maxLength: 2 }), {
      nil: undefined,
    }),
  })
  .map(({ title, meals, summary, warnings }) => ({
    title,
    content: {
      meals: meals.map((meal) => ({
        mealName: meal.mealName,
        items: meal.items.map(({ name, portion, notes }) =>
          // Absent means the key is omitted, never '' (Requirement 9.4).
          notes === undefined ? { name, portion } : { name, portion, notes },
        ),
      })),
      summary,
      ...(warnings === undefined ? {} : { warnings }),
    },
  }));

/**
 * A User_Id whose last two characters encode `index`, so distinct indices give
 * distinct ids however the bases were drawn. Length stays inside 20..36 and the
 * charset stays base-62, because a base-36 tag is digits and lowercase letters.
 */
function taggedUserId(base: string, index: number): string {
  const tag = index.toString(36).padStart(2, '0');
  return base.slice(0, base.length - tag.length) + tag;
}

/** An array of exactly `count` draws, for per-slot ingredient lists. */
function arbSlots<T>(count: number, arbitrary: fc.Arbitrary<T>): fc.Arbitrary<T[]> {
  return fc.array(arbitrary, { minLength: count, maxLength: count });
}

/** Largest seed `seededMealPlanId` is given; bumped on the rare id collision. */
const MAX_ID_SEED = 0x7fff_ffff;

/** Next seed to try when a generated Meal_Plan_Id is already taken. */
function bumpSeed(seed: number): number {
  return (seed % MAX_ID_SEED) + 1;
}

// ─── arbMultiAccountStore ──────────────────────────────────────────────────────

/** One stored record's location: which Account holds which Meal_Plan_Id, and when. */
export interface AccountPlacement {
  userId: string;
  mealPlanId: string;
  /** ISO-8601 UTC `createdAt` of that record, deliberately shared with others. */
  createdAt: string;
}

/**
 * A Meal_Plan_Store populated for two to five Accounts, together with everything
 * a confinement or pagination property needs to interrogate it.
 *
 * Two design choices carry the weight here:
 *
 * 1. **Meal_Plan_Ids overlap across Accounts.** Every non-empty Account holds the
 *    same first pool id, and the rest of each Account's ids are drawn from one
 *    shared pool at a rotating offset. So {@link sharedMealPlanIds} is normally
 *    non-empty, and an id valid in one partition is often valid in another with
 *    *different* content behind it. A read that leaked across partitions would
 *    therefore return a record rather than nothing, which is what makes
 *    Property 5's confinement assertion able to fail.
 * 2. **`createdAt` values collide inside an Account.** Records are stamped from a
 *    pool of only one to three instants, so several records in the same Account
 *    routinely share a creation millisecond while carrying different ULIDs.
 *    Ordering by timestamp alone is then ambiguous, and Property 11's "records
 *    sharing a creation timestamp are ordered by Meal_Plan_Id descending"
 *    tie-break is doing real work instead of being vacuously true.
 *
 * Record counts per Account are drawn from the page boundaries — 0, 1, 2, 3, 5,
 * 19, 20, 21 — so a traversal meets an empty Account, a single short page, an
 * exactly-full page, and a full page followed by a remainder.
 *
 * The record cap is not exercised here; that is {@link arbCommandSequence}'s job.
 * `storageAckAt` is present on most Accounts and absent on some, so a `create`
 * against a seeded Account reaches both sides of the acknowledgment gate.
 */
export interface MultiAccountStore {
  /** Ready to hand straight to the in-memory repository's `seed()`. */
  seeds: AccountSeed[];
  /** The seeded User_Ids in seed order: two to five, all distinct. */
  userIds: string[];
  /** A well-shaped User_Id that `seeds` does not populate. */
  absentUserId: string;
  /** Every (Account, Meal_Plan_Id) pair the seeds place, in seed order. */
  placements: AccountPlacement[];
  /** Meal_Plan_Ids held by more than one Account, sorted. */
  sharedMealPlanIds: string[];
  /** A well-shaped Meal_Plan_Id no Account holds. */
  absentMealPlanId: string;
}

const ACCOUNT_COUNT_MIN = 2;
const ACCOUNT_COUNT_MAX = 5;

/**
 * Record counts an Account may hold, chosen around the page boundary so a
 * traversal is exercised at 19, 20, and 21 records as well as at 0.
 */
const ACCOUNT_RECORD_COUNTS = [
  0,
  1,
  2,
  3,
  5,
  MEAL_PLAN_PAGE_SIZE - 1,
  MEAL_PLAN_PAGE_SIZE,
  MEAL_PLAN_PAGE_SIZE + 1,
] as const;

/** Ids in the shared pool: enough for the largest Account the generator builds. */
const ID_POOL_SIZE = Math.max(...ACCOUNT_RECORD_COUNTS);

/** Seed reserved for {@link MultiAccountStore.absentMealPlanId}. */
const ABSENT_ID_SEED = MAX_ID_SEED - 1;

/**
 * Generates a Meal_Plan_Store state spanning two to five Accounts, with
 * overlapping Meal_Plan_Ids and colliding `createdAt` values.
 *
 * The result's `seeds` are accepted as-is by the in-memory repository's `seed()`,
 * which writes them without evaluating the cap or the acknowledgment gate — so
 * the state a property starts from is exactly the state described here.
 */
export function arbMultiAccountStore(): fc.Arbitrary<MultiAccountStore> {
  return fc
    .record({
      accountCount: fc.oneof(
        { weight: 2, arbitrary: fc.constant(ACCOUNT_COUNT_MIN) },
        { weight: 2, arbitrary: fc.constant(ACCOUNT_COUNT_MAX) },
        {
          weight: 3,
          arbitrary: fc.integer({ min: ACCOUNT_COUNT_MIN, max: ACCOUNT_COUNT_MAX }),
        },
      ),
      // One base per Account plus one for `absentUserId`.
      userIdBases: arbSlots(ACCOUNT_COUNT_MAX + 1, arbUserId),
      // Few instants, many records: that is what forces the `createdAt` collisions.
      instants: fc.array(arbCreatedAtMs, { minLength: 1, maxLength: 3 }),
      idSeeds: arbSlots(ID_POOL_SIZE, fc.integer({ min: 1, max: MAX_ID_SEED })),
      updatedGaps: arbSlots(
        ID_POOL_SIZE,
        fc.oneof(
          { weight: 3, arbitrary: fc.constant(0) },
          { weight: 1, arbitrary: fc.integer({ min: 1, max: 30 * 24 * 60 * 60 * 1000 }) },
        ),
      ),
      templates: fc.array(arbRecordTemplate, { minLength: 1, maxLength: 3 }),
      recordCounts: arbSlots(ACCOUNT_COUNT_MAX, fc.constantFrom(...ACCOUNT_RECORD_COUNTS)),
      offsets: arbSlots(ACCOUNT_COUNT_MAX, fc.nat({ max: 0xffff })),
      ackFlags: arbSlots(
        ACCOUNT_COUNT_MAX,
        fc.oneof(
          { weight: 4, arbitrary: fc.constant(true) },
          { weight: 1, arbitrary: fc.constant(false) },
        ),
      ),
    })
    .map(
      ({
        accountCount,
        userIdBases,
        instants,
        idSeeds,
        updatedGaps,
        templates,
        recordCounts,
        offsets,
        ackFlags,
      }) => {
        // The shared id pool. Each entry pairs a Meal_Plan_Id with the instant its
        // ULID embeds, so any Account reusing the entry reuses both.
        const takenIds = new Set<string>();
        const pool: Array<{ mealPlanId: string; createdAtMs: number }> = [];
        for (let p = 0; p < ID_POOL_SIZE; p += 1) {
          const createdAtMs = instants[p % instants.length];
          let seed = idSeeds[p];
          let mealPlanId = seededMealPlanId(createdAtMs, seed);
          while (takenIds.has(mealPlanId)) {
            seed = bumpSeed(seed);
            mealPlanId = seededMealPlanId(createdAtMs, seed);
          }
          takenIds.add(mealPlanId);
          pool.push({ mealPlanId, createdAtMs });
        }

        const userIds: string[] = [];
        const seeds: AccountSeed[] = [];
        const placements: AccountPlacement[] = [];
        const ownerCounts = new Map<string, number>();

        for (let a = 0; a < accountCount; a += 1) {
          const userId = taggedUserId(userIdBases[a], a);
          userIds.push(userId);

          // Pool index 0 is in every non-empty Account, so an overlapping id
          // exists whenever two Accounts hold anything at all; the remaining
          // indices rotate by a per-Account offset.
          const indices: number[] = [];
          for (let k = 0; k < recordCounts[a]; k += 1) {
            const index = k === 0 ? 0 : (offsets[a] + k) % ID_POOL_SIZE;
            if (!indices.includes(index)) indices.push(index);
          }

          const records = indices.map<MealPlanRecord>((index) => {
            const { mealPlanId, createdAtMs } = pool[index];
            const createdAt = isoUtcMillis(createdAtMs);
            // Rotating the template by the Account index means the same shared id
            // carries different content in different Accounts, so a cross-partition
            // read would return visibly wrong content rather than a plausible one.
            const template = templates[(a + index) % templates.length];

            placements.push({ userId, mealPlanId, createdAt });
            ownerCounts.set(mealPlanId, (ownerCounts.get(mealPlanId) ?? 0) + 1);

            return {
              userId,
              mealPlanId,
              title: fitToBounds(
                `a${a}p${index}-${template.title}`,
                MEAL_PLAN_BOUNDS.title.min,
                MEAL_PLAN_BOUNDS.title.max,
              ),
              createdAt,
              updatedAt: isoUtcMillis(createdAtMs + updatedGaps[index]),
              content: deepCopy(template.content),
            };
          });

          seeds.push(
            ackFlags[a]
              ? { userId, records, storageAckAt: isoUtcMillis(instants[0]) }
              : { userId, records },
          );
        }

        // An id outside the pool, so it is absent from every Account whatever the
        // Accounts happened to draw.
        let absentSeed = ABSENT_ID_SEED;
        let absentMealPlanId = seededMealPlanId(instants[0], absentSeed);
        while (takenIds.has(absentMealPlanId)) {
          absentSeed = bumpSeed(absentSeed);
          absentMealPlanId = seededMealPlanId(instants[0], absentSeed);
        }

        return {
          seeds,
          userIds,
          // Tagged with `accountCount`, which no seeded Account used.
          absentUserId: taggedUserId(userIdBases[ACCOUNT_COUNT_MAX], accountCount),
          placements,
          sharedMealPlanIds: Array.from(ownerCounts.entries())
            .filter(([, owners]) => owners > 1)
            .map(([mealPlanId]) => mealPlanId)
            .sort(),
          absentMealPlanId,
        };
      },
    );
}

// ─── arbCommandSequence ────────────────────────────────────────────────────────

/** Whether a command names an id the sequence creates, or one it never creates. */
export type CommandTarget = 'known' | 'unknown';

/** Which repository method a command calls. */
export type StoreCommandKind = 'create' | 'update' | 'rename' | 'delete';

/**
 * A `create`. `intent` is `repeat` when the command re-issues an earlier create
 * verbatim, which is the resubmission Requirement 5.4 constrains.
 */
export interface CreateCommand {
  kind: 'create';
  atMs: number;
  record: MealPlanRecord;
  /**
   * Always `true`. The acknowledgment gate is Property 14's subject; leaving it
   * open here would turn nearly every create into `ack-required` and the cap
   * sequences would never reach the cap.
   */
  ackStorage: true;
  intent: 'fresh' | 'repeat';
}

/** An `update`, carrying replacement content for `record.mealPlanId`. */
export interface UpdateCommand {
  kind: 'update';
  atMs: number;
  record: MealPlanRecord;
  target: CommandTarget;
}

/** A `rename`, carrying a new title and the timestamp to stamp as `updatedAt`. */
export interface RenameCommand {
  kind: 'rename';
  atMs: number;
  mealPlanId: string;
  title: string;
  target: CommandTarget;
}

/** A `delete`. Repeats arise naturally, since targets include already-deleted ids. */
export interface DeleteCommand {
  kind: 'delete';
  atMs: number;
  mealPlanId: string;
  target: CommandTarget;
}

export type StoreCommand = CreateCommand | UpdateCommand | RenameCommand | DeleteCommand;

/**
 * Which region of the state space a sequence is aimed at.
 *
 * `fill-cap`, `over-cap`, and `cap-churn` exist because the cap is only
 * interesting at its edge: a uniformly mixed sequence of 300 commands deletes
 * often enough that it may never hold 100 records at once, so the 409 branch of
 * Requirement 5.9 would go untested.
 */
export type CommandSequenceShape = 'short' | 'mixed' | 'fill-cap' | 'over-cap' | 'cap-churn';

/** Longest sequence generated. */
export const MAX_COMMAND_SEQUENCE_LENGTH = 300;

/** A sequence of store commands issued by one Account, in order. */
export interface CommandSequence {
  /** The one Account issuing every command; no command names another. */
  userId: string;
  /** Which region of the state space this sequence targets, for triage. */
  shape: CommandSequenceShape;
  /** The commands, oldest first. `atMs` is non-decreasing across the list. */
  commands: StoreCommand[];
  /**
   * Every Meal_Plan_Id a `create` in this sequence introduces, in creation order.
   * A `known` target is one of these; an `unknown` target is never one of them.
   */
  createdMealPlanIds: string[];
}

/** Meal_Plan_Ids named by `unknown` targets predate `startMs` by this much. */
const PHANTOM_GAP_MS = 30 * 24 * 60 * 60 * 1000;

/** Length range per shape, capped at {@link MAX_COMMAND_SEQUENCE_LENGTH}. */
function arbSequenceLength(shape: CommandSequenceShape): fc.Arbitrary<number> {
  const cap = MEAL_PLAN_RECORD_CAP;
  switch (shape) {
    case 'short':
      return fc.integer({ min: 1, max: 20 });
    case 'mixed':
      return fc.integer({ min: 21, max: 120 });
    case 'fill-cap':
      return fc.integer({ min: cap, max: cap + 20 });
    case 'over-cap':
      return fc.integer({ min: cap + 5, max: cap + 60 });
    case 'cap-churn':
      return fc.integer({ min: cap + 40, max: MAX_COMMAND_SEQUENCE_LENGTH });
  }
}

/** Command mix for a sequence with no particular aim: creates dominate. */
function mixedKind(pick: number): StoreCommandKind {
  const p = pick % 100;
  if (p < 40) return 'create';
  if (p < 60) return 'update';
  if (p < 80) return 'rename';
  return 'delete';
}

/**
 * How many leading slots are reserved for creates of *fresh* ids.
 *
 * The cap shapes front-load creates so the Account is at or past 100 records
 * before anything else happens. Resubmissions are suppressed over these slots for
 * the same reason: a repeat create adds no record, so allowing them here would
 * leave a `fill-cap` sequence short of the cap and the 409 branch of
 * Requirement 5.9 unreached.
 */
function fillSlotCount(shape: CommandSequenceShape): number {
  switch (shape) {
    case 'fill-cap':
    case 'cap-churn':
      return MEAL_PLAN_RECORD_CAP;
    case 'over-cap':
      return MEAL_PLAN_RECORD_CAP + 5;
    default:
      return 0;
  }
}

/**
 * Which command occupies slot `slot`.
 *
 * After the fill phase, `cap-churn` alternates deletes and creates so the count
 * crosses the cap boundary repeatedly rather than once.
 */
function kindForSlot(
  shape: CommandSequenceShape,
  slot: number,
  pick: number,
  createdCount: number,
): StoreCommandKind {
  // Nothing to target yet.
  if (createdCount === 0) return 'create';
  if (slot < fillSlotCount(shape)) return 'create';
  if (shape === 'cap-churn') return pick % 2 === 0 ? 'delete' : 'create';
  return mixedKind(pick);
}

/**
 * A Meal_Plan_Id and `createdAt` for a record the sequence never creates.
 *
 * Placed 30 days before the sequence starts and offset by the slot, so a phantom
 * id can collide neither with a created id — every one of those embeds a
 * timestamp at or after `startMs` — nor with another phantom.
 */
function phantomTarget(
  startMs: number,
  slot: number,
  seed: number,
): { mealPlanId: string; createdAt: string } {
  const createdAtMs = startMs - PHANTOM_GAP_MS - slot;
  return {
    mealPlanId: seededMealPlanId(createdAtMs, seed),
    createdAt: isoUtcMillis(createdAtMs),
  };
}

/** Per-slot ingredients for {@link buildCommandSequence}. */
interface SequenceIngredients {
  userId: string;
  startMs: number;
  templates: RecordTemplate[];
  titles: string[];
  gaps: number[];
  kindPicks: number[];
  targetPicks: number[];
  repeatPicks: number[];
  idSeeds: number[];
}

/** Turns the drawn ingredients into the command list, tracking created ids as it goes. */
function buildCommandSequence(
  shape: CommandSequenceShape,
  length: number,
  raw: SequenceIngredients,
): CommandSequence {
  const { userId, startMs, templates, titles, gaps, kindPicks, targetPicks, repeatPicks, idSeeds } =
    raw;

  const commands: StoreCommand[] = [];
  /** Records as first created, in order — the pool every `known` target draws from. */
  const created: MealPlanRecord[] = [];
  const createdIds = new Set<string>();
  let clock = startMs;

  for (let slot = 0; slot < length; slot += 1) {
    // Non-decreasing, and often unchanged: two records created in the same
    // millisecond share a `createdAt` and differ only by ULID, which is the
    // tie-break case.
    clock += gaps[slot];

    const template = templates[slot % templates.length];
    // Slot-tagged so every title in the sequence is distinct, which makes a
    // rename or update that landed on the wrong record obvious.
    const title = fitToBounds(
      `c${slot}-${titles[slot % titles.length]}`,
      MEAL_PLAN_BOUNDS.title.min,
      MEAL_PLAN_BOUNDS.title.max,
    );
    const kind = kindForSlot(shape, slot, kindPicks[slot], created.length);

    if (kind === 'create') {
      const repeat =
        slot >= fillSlotCount(shape) && created.length > 0 && repeatPicks[slot] % 100 < 12;
      if (repeat) {
        commands.push({
          kind: 'create',
          atMs: clock,
          ackStorage: true,
          intent: 'repeat',
          record: deepCopy(created[targetPicks[slot] % created.length]),
        });
        continue;
      }

      let seed = idSeeds[slot];
      let mealPlanId = seededMealPlanId(clock, seed);
      while (createdIds.has(mealPlanId)) {
        seed = bumpSeed(seed);
        mealPlanId = seededMealPlanId(clock, seed);
      }
      createdIds.add(mealPlanId);

      const createdAt = isoUtcMillis(clock);
      const record: MealPlanRecord = {
        userId,
        mealPlanId,
        title,
        createdAt,
        // A created record has `updatedAt` equal to `createdAt` (Requirement 5.2).
        updatedAt: createdAt,
        content: deepCopy(template.content),
      };
      created.push(record);
      commands.push({
        kind: 'create',
        atMs: clock,
        ackStorage: true,
        intent: 'fresh',
        record: deepCopy(record),
      });
      continue;
    }

    // Most commands target a record the sequence created — possibly one it has
    // already deleted, which is how repeated deletes and updates of absent
    // records arise — and a minority target an id it never created at all.
    const unknown = created.length === 0 || targetPicks[slot] % 100 < 15;
    const target: CommandTarget = unknown ? 'unknown' : 'known';
    const chosen = unknown ? undefined : created[targetPicks[slot] % created.length];
    // `phantomTarget` is evaluated only when no created record was chosen.
    const { mealPlanId, createdAt } = chosen ?? phantomTarget(startMs, slot, idSeeds[slot]);

    if (kind === 'update') {
      commands.push({
        kind: 'update',
        atMs: clock,
        target,
        record: {
          userId,
          mealPlanId,
          title,
          // The store preserves its own `createdAt`; this one agrees with the id's
          // embedded timestamp so the record is well-formed on its own too.
          createdAt,
          updatedAt: isoUtcMillis(clock),
          content: deepCopy(template.content),
        },
      });
      continue;
    }

    if (kind === 'rename') {
      commands.push({ kind: 'rename', atMs: clock, target, mealPlanId, title });
      continue;
    }

    commands.push({ kind: 'delete', atMs: clock, target, mealPlanId });
  }

  return { userId, shape, commands, createdMealPlanIds: created.map((r) => r.mealPlanId) };
}

/**
 * Generates up to {@link MAX_COMMAND_SEQUENCE_LENGTH} create, update, rename, and
 * delete commands issued by one Account, including sequences that reach and
 * exceed the 100-record cap.
 *
 * What the sequence guarantees, so a model-based property can rely on it:
 *
 * - **One Account.** Every command carries the same `userId`, so a failure is
 *   about save/delete semantics and not about partition confinement, which is
 *   {@link arbMultiAccountStore}'s subject.
 * - **`atMs` is non-decreasing**, and often repeats, so `updatedAt` monotonicity
 *   is a real assertion and same-millisecond ids still occur.
 * - **Every record is well-formed**: bounds satisfied, `createdAt` equal to the
 *   millisecond embedded in its ULID, and `updatedAt` no earlier than `createdAt`.
 *   A command that fails does so because of a store condition, never because the
 *   serializer rejected the record.
 * - **Ids are classified statically.** A `known` target appears in
 *   {@link CommandSequence.createdMealPlanIds}; an `unknown` one never does. Whether
 *   a `known` target still exists when its command runs is up to the sequence —
 *   deletes and re-targets are exactly what makes the not-found paths reachable.
 * - **Resubmissions are verbatim.** A `repeat` create re-issues an earlier
 *   record unchanged, so Requirement 5.4's "one record under one id" is testable.
 */
export function arbCommandSequence(): fc.Arbitrary<CommandSequence> {
  return fc
    .constantFrom<CommandSequenceShape[]>('short', 'mixed', 'fill-cap', 'over-cap', 'cap-churn')
    .chain((shape) =>
      arbSequenceLength(shape).chain((length) =>
        fc
          .record({
            userId: arbUserId,
            startMs: arbCreatedAtMs,
            templates: fc.array(arbRecordTemplate, { minLength: 1, maxLength: 3 }),
            titles: fc.array(arbTrickyString(1, 40), { minLength: 1, maxLength: 4 }),
            gaps: arbSlots(
              length,
              fc.oneof(
                { weight: 2, arbitrary: fc.constant(0) },
                { weight: 3, arbitrary: fc.integer({ min: 1, max: 4000 }) },
              ),
            ),
            kindPicks: arbSlots(length, fc.nat({ max: 99 })),
            targetPicks: arbSlots(length, fc.nat({ max: 0xffff })),
            repeatPicks: arbSlots(length, fc.nat({ max: 99 })),
            idSeeds: arbSlots(length, fc.integer({ min: 1, max: MAX_ID_SEED })),
          })
          .map((raw) => buildCommandSequence(shape, length, raw)),
      ),
    );
}

// ─── arbUnusableToken ──────────────────────────────────────────────────────────

/**
 * Why an Auth_Token cannot be used, one entry per cause named in the design's
 * generator list. The set spans four requirements deliberately:
 *
 * - `absent`, `blank`, `wrong-scheme` — no credential reaches the verifier at
 *   all (Requirement 4.2).
 * - `garbage`, `wrong-key-signed`, `expired` — a credential that cannot be
 *   parsed, fails signature verification, or expired more than
 *   {@link CLOCK_TOLERANCE_SECONDS} seconds ago (Requirement 4.3).
 * - `over-length` — a credential past the 8,192-character guard, which must be
 *   rejected with no outbound request at all (Requirement 4.7).
 * - `revoked`, `disabled`, `deleted` — a structurally perfect credential whose
 *   Session or Account the Auth_Service reports as unusable (Requirement 4.6).
 */
export type UnusableTokenCause =
  | 'absent'
  | 'blank'
  | 'wrong-scheme'
  | 'garbage'
  | 'wrong-key-signed'
  | 'expired'
  | 'over-length'
  | 'revoked'
  | 'disabled'
  | 'deleted';

/** Every cause, in the order the verifier would reach them. */
export const UNUSABLE_TOKEN_CAUSES: readonly UnusableTokenCause[] = [
  'absent',
  'blank',
  'wrong-scheme',
  'garbage',
  'wrong-key-signed',
  'expired',
  'over-length',
  'revoked',
  'disabled',
  'deleted',
];

/** An `accounts:lookup` answer, ready to be turned into a `Response`. */
export interface AuthServiceLookupResponse {
  status: number;
  /** JSON body, exactly as Identity Toolkit would return it. */
  body: unknown;
}

/**
 * One unusable credential, together with everything a property needs to drive a
 * request with it and to say what must happen.
 *
 * The two tags are what make Property 7 assertable in both directions:
 *
 * - {@link expectedKind} records which `VerifyResult` the verifier owes this
 *   case. Requirement 4.2 (`missing`) and Requirements 4.3/4.6/4.7 (`invalid`)
 *   map to *one identical* 401 body, so a property asserts both that the kind is
 *   the expected one and that the response bytes are byte-identical across every
 *   cause in the set — the distinction survives inside the verifier and dies at
 *   the response boundary.
 * - {@link lookupResponse} makes the revoked, disabled, and deleted cases
 *   self-describing. Those three are only unusable because of what the
 *   Auth_Service says, so the case carries the answer the fake `accounts:lookup`
 *   endpoint must give rather than leaving the property test to infer it. Cases
 *   that never reach the lookup carry an *active-account* answer on purpose: if
 *   the credential somehow got that far it would be approved, so a rejection
 *   proves an earlier step did the rejecting.
 */
export interface UnusableToken {
  cause: UnusableTokenCause;
  /** The `VerifyResult` kind this case must produce. Both map to the same 401. */
  expectedKind: 'missing' | 'invalid';
  /** Header value to send, or `null` when the request must carry no header. */
  authorization: string | null;
  /** The credential itself, or `null` for the cases that carry none. */
  token: string | null;
  /** The `sub` the credential claims, or `null` when there is no credential. */
  userId: string | null;
  /** What `accounts:lookup` must answer if the verifier gets that far. */
  lookupResponse: AuthServiceLookupResponse;
  /**
   * Whether the verifier is permitted to make any outbound Auth_Service request
   * for this case. `false` for every pre-network rejection, and notably for
   * `over-length`, where Requirement 4.7 forbids the request outright.
   */
  reachesAuthService: boolean;
  /** Plain-language description, so a counterexample reads as a sentence. */
  detail: string;
}

/**
 * The signing material and project identity every generated credential is built
 * against. Creating it generates two RSA key pairs, so a suite builds one kit in
 * `beforeAll` and hands it to {@link arbUnusableToken} rather than paying that
 * cost per draw.
 */
export interface UnusableTokenKit {
  /** Firebase project id, used for the `iss` and `aud` claims. */
  projectId: string;
  /** Web API key the revocation lookup is called with. */
  apiKey: string;
  /** The `kid` under which {@link certificateDocument} publishes a certificate. */
  kid: string;
  /** `kid` → certificate PEM, the shape Google's x509 endpoint serves. */
  certificateDocument: Record<string, string>;
  /** The instant every credential is minted relative to. */
  nowMs: number;
  /** Signs credentials the published certificate verifies. */
  signingKey: KeyObject;
  /** Signs credentials nothing published verifies — the `wrong-key-signed` case. */
  wrongSigningKey: KeyObject;
}

export interface CreateUnusableTokenKitOptions {
  projectId?: string;
  apiKey?: string;
  kid?: string;
  /** Fix this to the same instant the suite sets on its fake clock. */
  nowMs?: number;
}

const DEFAULT_PROJECT_ID = 'crohns-buddy-test';
const DEFAULT_API_KEY = 'test-web-api-key';
const DEFAULT_KID = 'test-kid-1';
const DEFAULT_NOW_MS = Date.UTC(2025, 0, 15, 12, 0, 0);
const DEFAULT_EMAIL = 'patient@example.test';
const DEFAULT_NAME = 'Test Patient';

/** How long before `nowMs` the Patient authenticated, for `auth_time`. */
const DEFAULT_AUTH_AGE_MS = 60_000;

/** How long a non-expired generated credential stays valid. */
const DEFAULT_TOKEN_LIFETIME_MS = 60 * 60 * 1000;

/**
 * Builds the signing material for a run.
 *
 * Two key pairs are generated: one whose certificate is published under `kid`,
 * and one published nowhere. RSASSA-PKCS1-v1_5 is deterministic, so given a kit
 * the credentials {@link arbUnusableToken} mints are a pure function of the
 * seed and a reported counterexample replays exactly within the run. The key
 * material itself is fresh per kit, which is why a suite should build the kit
 * once and reuse it rather than rebuilding it between properties.
 */
export function createUnusableTokenKit(
  options: CreateUnusableTokenKitOptions = {},
): UnusableTokenKit {
  const kid = options.kid ?? DEFAULT_KID;
  const published = createTestSigningKeyPair(kid);
  const unpublished = createTestSigningKeyPair(`${kid}-unpublished`);

  return {
    projectId: options.projectId ?? DEFAULT_PROJECT_ID,
    apiKey: options.apiKey ?? DEFAULT_API_KEY,
    kid,
    certificateDocument: { [kid]: published.certificatePem },
    nowMs: options.nowMs ?? DEFAULT_NOW_MS,
    signingKey: published.privateKey,
    wrongSigningKey: unpublished.privateKey,
  };
}

/** Claims of a minted credential, in milliseconds where the JWT uses seconds. */
export interface AuthTokenClaims {
  sub: string;
  authTimeMs: number;
  issuedAtMs: number;
  expiresAtMs: number;
  email: string;
  name: string;
  issuer: string;
  audience: string;
  /** Filler claim, used only to push a credential past the length guard. */
  padding?: string;
}

export interface MintAuthTokenOptions {
  /** Overrides applied over the well-formed defaults. */
  claims?: Partial<AuthTokenClaims>;
  /** Header `kid`. `null` omits it entirely. Defaults to the kit's `kid`. */
  kid?: string | null;
  /** Header `alg`. Defaults to `RS256`. */
  alg?: string;
  /** Which key signs. Defaults to the published one. */
  signWith?: 'published' | 'wrong';
  /** Emits `header.payload` with no signature segment. */
  omitSignature?: boolean;
  /** Replaces the payload segment with raw text, valid base64url JSON or not. */
  payloadSegment?: string;
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/**
 * RS256 over the JWS signing input.
 *
 * Node's `sign` with an RSA key is RSASSA-PKCS1-v1_5, which is exactly what
 * RS256 names, and it is synchronous — so a credential can be minted inside a
 * `fast-check` `.map()` rather than forcing every property that uses these cases
 * to materialize them asynchronously.
 */
function signRs256(signingInput: string, privateKey: KeyObject): string {
  return signBytes('sha256', Buffer.from(signingInput, 'ascii'), privateKey).toString('base64url');
}

/**
 * Mints an Auth_Token. With no options it produces a credential that passes
 * every check the verifier makes: RS256, published `kid`, correct `iss` and
 * `aud`, an `auth_time` a minute in the past, and an hour of validity left.
 * Each option breaks exactly one of those, which is how the unusable cases are
 * built — and how a property test builds its usable control case.
 */
export function mintAuthToken(kit: UnusableTokenKit, options: MintAuthTokenOptions = {}): string {
  const authTimeMs = kit.nowMs - DEFAULT_AUTH_AGE_MS;
  const claims: AuthTokenClaims = {
    sub: 'unusable-token-subject',
    authTimeMs,
    issuedAtMs: authTimeMs,
    expiresAtMs: kit.nowMs + DEFAULT_TOKEN_LIFETIME_MS,
    email: DEFAULT_EMAIL,
    name: DEFAULT_NAME,
    issuer: `https://securetoken.google.com/${kit.projectId}`,
    audience: kit.projectId,
    ...options.claims,
  };

  const header: Record<string, unknown> = { alg: options.alg ?? 'RS256', typ: 'JWT' };
  const kid = options.kid === undefined ? kit.kid : options.kid;
  if (kid !== null) header.kid = kid;

  const payload: Record<string, unknown> = {
    iss: claims.issuer,
    aud: claims.audience,
    sub: claims.sub,
    auth_time: Math.floor(claims.authTimeMs / 1000),
    iat: Math.floor(claims.issuedAtMs / 1000),
    exp: Math.floor(claims.expiresAtMs / 1000),
    email: claims.email,
    name: claims.name,
    ...(claims.padding === undefined ? {} : { padding: claims.padding }),
  };

  const signingInput = `${base64urlJson(header)}.${options.payloadSegment ?? base64urlJson(payload)}`;
  if (options.omitSignature === true) return signingInput;

  const key = options.signWith === 'wrong' ? kit.wrongSigningKey : kit.signingKey;
  return `${signingInput}.${signRs256(signingInput, key)}`;
}

/**
 * Mints an otherwise-perfect credential of at least `minChars` characters, by
 * padding one claim.
 *
 * The credential is genuinely valid apart from its size, so the only thing that
 * can reject it is the length guard — which is what makes Requirement 4.7's "no
 * verification request at all" assertable rather than incidental. Base64url
 * expands its input by 4/3, so the first filler estimate overshoots and the loop
 * normally runs once.
 */
function mintTokenOfAtLeast(
  kit: UnusableTokenKit,
  userId: string,
  authTimeMs: number,
  minChars: number,
): string {
  let fillerChars = Math.max(1, Math.ceil((minChars * 3) / 4));

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const token = mintAuthToken(kit, {
      claims: {
        sub: userId,
        authTimeMs,
        issuedAtMs: authTimeMs,
        expiresAtMs: kit.nowMs + DEFAULT_TOKEN_LIFETIME_MS,
        padding: 'x'.repeat(fillerChars),
      },
    });
    if (token.length >= minChars) return token;
    fillerChars += Math.ceil(((minChars - token.length) * 3) / 4) + 8;
  }

  throw new Error(`arbUnusableToken: could not mint a credential of ${minChars} characters`);
}

/**
 * Header values that carry the Bearer scheme with nothing behind it. The Fetch
 * layer trims header values, so several of these arrive as the bare scheme —
 * which is the point: every one of them is a request with no credential.
 */
const BLANK_AUTHORIZATION_HEADERS = ['Bearer', 'Bearer ', 'Bearer   ', 'Bearer\t', ''];

/**
 * Schemes that are not `Bearer`. The scheme comparison is case-insensitive, so
 * `bearer` is *not* in this list — it is accepted, and putting it here would
 * make the generator assert the opposite of the verifier's contract.
 */
const WRONG_SCHEMES = ['Basic', 'Token', 'JWT', 'Digest', 'OAuth', 'Bearer-Token'];

/** A credential that is broken rather than merely unauthorized. */
interface GarbageCredential {
  token: string;
  reachesAuthService: boolean;
  detail: string;
}

/**
 * The `garbage` variants, spanning both sides of the certificate fetch.
 *
 * The first four are rejected before any outbound request — unreadable header,
 * wrong algorithm, absent `kid`. The last three get as far as resolving a
 * certificate and then fail, which is a different code path in the verifier
 * reaching the same indistinguishable `invalid`.
 */
function garbageCredential(
  kit: UnusableTokenKit,
  userId: string,
  authTimeMs: number,
  pick: number,
): GarbageCredential {
  const wellFormedClaims = {
    sub: userId,
    authTimeMs,
    issuedAtMs: authTimeMs,
    expiresAtMs: kit.nowMs + DEFAULT_TOKEN_LIFETIME_MS,
  };

  switch (pick % 7) {
    case 0:
      return { token: 'not-a-jwt', reachesAuthService: false, detail: 'not a JWT at all' };
    case 1:
      return {
        // Decodes to `hello`, which is not a JSON object, so the header read fails.
        token: 'aGVsbG8.d29ybGQ.c2ln',
        reachesAuthService: false,
        detail: 'three base64url segments whose header is not JSON',
      };
    case 2:
      return {
        token: mintAuthToken(kit, { claims: wellFormedClaims, alg: 'HS256' }),
        reachesAuthService: false,
        detail: 'header declares HS256 where RS256 is required',
      };
    case 3:
      return {
        token: mintAuthToken(kit, { claims: wellFormedClaims, kid: null }),
        reachesAuthService: false,
        detail: 'header carries no kid, so no certificate can be resolved',
      };
    case 4:
      return {
        token: mintAuthToken(kit, { claims: wellFormedClaims, kid: `${kit.kid}-rotated-away` }),
        reachesAuthService: true,
        detail: 'kid names a certificate the Auth_Service does not publish',
      };
    case 5:
      return {
        token: mintAuthToken(kit, { claims: wellFormedClaims, omitSignature: true }),
        reachesAuthService: true,
        detail: 'header and payload with no signature segment',
      };
    default:
      return {
        token: mintAuthToken(kit, {
          claims: wellFormedClaims,
          payloadSegment: 'not-base64url-json',
        }),
        reachesAuthService: true,
        detail: 'payload segment is not base64url JSON',
      };
  }
}

/**
 * The `accounts:lookup` answer for an Account in good standing: present, not
 * disabled, and last revoked before the credential was issued.
 */
function activeAccountLookup(userId: string, authTimeMs: number): AuthServiceLookupResponse {
  return {
    status: 200,
    body: {
      users: [
        {
          localId: userId,
          disabled: false,
          validSince: String(Math.floor(authTimeMs / 1000) - 60),
        },
      ],
    },
  };
}

/** The three ways Identity Toolkit reports an Account that no longer exists. */
function removedAccountLookup(pick: number): AuthServiceLookupResponse {
  switch (pick % 3) {
    case 0:
      return {
        status: 400,
        body: {
          error: {
            code: 400,
            message: 'USER_NOT_FOUND',
            errors: [{ message: 'USER_NOT_FOUND', domain: 'global', reason: 'invalid' }],
          },
        },
      };
    case 1:
      return { status: 200, body: { users: [] } };
    default:
      return { status: 200, body: {} };
  }
}

/** The raw draw behind one case, kept separate so the build step stays pure. */
interface UnusableTokenDraw {
  cause: UnusableTokenCause;
  userId: string;
  blankPick: number;
  schemePick: number;
  garbagePick: number;
  expiredBySeconds: number;
  overLengthChars: number;
  revokedAfterSeconds: number;
  removedShapePick: number;
}

function buildUnusableToken(kit: UnusableTokenKit, draw: UnusableTokenDraw): UnusableToken {
  const { cause, userId } = draw;
  const authTimeMs = kit.nowMs - DEFAULT_AUTH_AGE_MS;
  const activeAccount = activeAccountLookup(userId, authTimeMs);

  /** A credential with nothing at all wrong with it. */
  const usableToken = (): string =>
    mintAuthToken(kit, {
      claims: {
        sub: userId,
        authTimeMs,
        issuedAtMs: authTimeMs,
        expiresAtMs: kit.nowMs + DEFAULT_TOKEN_LIFETIME_MS,
      },
    });

  switch (cause) {
    case 'absent':
      return {
        cause,
        expectedKind: 'missing',
        authorization: null,
        token: null,
        userId: null,
        lookupResponse: activeAccount,
        reachesAuthService: false,
        detail: 'request carries no Authorization header',
      };

    case 'blank': {
      const authorization =
        BLANK_AUTHORIZATION_HEADERS[draw.blankPick % BLANK_AUTHORIZATION_HEADERS.length];
      return {
        cause,
        expectedKind: 'missing',
        authorization,
        token: null,
        userId: null,
        lookupResponse: activeAccount,
        reachesAuthService: false,
        detail: `Authorization header ${JSON.stringify(authorization)} carries no credential`,
      };
    }

    case 'wrong-scheme': {
      const scheme = WRONG_SCHEMES[draw.schemePick % WRONG_SCHEMES.length];
      const token = usableToken();
      return {
        cause,
        expectedKind: 'missing',
        authorization: `${scheme} ${token}`,
        token,
        userId,
        lookupResponse: activeAccount,
        reachesAuthService: false,
        detail: `a usable credential offered under the ${scheme} scheme`,
      };
    }

    case 'garbage': {
      const garbage = garbageCredential(kit, userId, authTimeMs, draw.garbagePick);
      return {
        cause,
        expectedKind: 'invalid',
        authorization: `Bearer ${garbage.token}`,
        token: garbage.token,
        userId,
        lookupResponse: activeAccount,
        reachesAuthService: garbage.reachesAuthService,
        detail: garbage.detail,
      };
    }

    case 'wrong-key-signed': {
      const token = mintAuthToken(kit, {
        claims: {
          sub: userId,
          authTimeMs,
          issuedAtMs: authTimeMs,
          expiresAtMs: kit.nowMs + DEFAULT_TOKEN_LIFETIME_MS,
        },
        signWith: 'wrong',
      });
      return {
        cause,
        expectedKind: 'invalid',
        authorization: `Bearer ${token}`,
        token,
        userId,
        lookupResponse: activeAccount,
        reachesAuthService: true,
        detail: 'every claim correct, signed by a key the Auth_Service never published',
      };
    }

    case 'expired': {
      const expiresAtMs = kit.nowMs - draw.expiredBySeconds * 1000;
      const expiredAuthTimeMs = expiresAtMs - DEFAULT_TOKEN_LIFETIME_MS;
      const token = mintAuthToken(kit, {
        claims: {
          sub: userId,
          authTimeMs: expiredAuthTimeMs,
          issuedAtMs: expiredAuthTimeMs,
          expiresAtMs,
        },
      });
      return {
        cause,
        expectedKind: 'invalid',
        authorization: `Bearer ${token}`,
        token,
        userId,
        lookupResponse: activeAccountLookup(userId, expiredAuthTimeMs),
        reachesAuthService: true,
        detail: `expired ${draw.expiredBySeconds}s ago, past the ${CLOCK_TOLERANCE_SECONDS}s tolerance`,
      };
    }

    case 'over-length': {
      const token = mintTokenOfAtLeast(kit, userId, authTimeMs, draw.overLengthChars);
      return {
        cause,
        expectedKind: 'invalid',
        authorization: `Bearer ${token}`,
        token,
        userId,
        lookupResponse: activeAccount,
        // Requirement 4.7: rejected on length alone, with no outbound request.
        reachesAuthService: false,
        detail: `${token.length} characters, over the ${AUTH_TOKEN_MAX_CHARS}-character guard`,
      };
    }

    case 'revoked': {
      const token = usableToken();
      const validSinceSeconds = Math.floor(authTimeMs / 1000) + draw.revokedAfterSeconds;
      return {
        cause,
        expectedKind: 'invalid',
        authorization: `Bearer ${token}`,
        token,
        userId,
        lookupResponse: {
          status: 200,
          body: {
            users: [{ localId: userId, disabled: false, validSince: String(validSinceSeconds) }],
          },
        },
        reachesAuthService: true,
        detail: `Session revoked ${draw.revokedAfterSeconds}s after the credential was issued`,
      };
    }

    case 'disabled': {
      const token = usableToken();
      return {
        cause,
        expectedKind: 'invalid',
        authorization: `Bearer ${token}`,
        token,
        userId,
        lookupResponse: {
          status: 200,
          body: {
            users: [
              {
                localId: userId,
                disabled: true,
                validSince: String(Math.floor(authTimeMs / 1000) - 60),
              },
            ],
          },
        },
        reachesAuthService: true,
        detail: 'Account reported as disabled',
      };
    }

    case 'deleted': {
      const token = usableToken();
      return {
        cause,
        expectedKind: 'invalid',
        authorization: `Bearer ${token}`,
        token,
        userId,
        lookupResponse: removedAccountLookup(draw.removedShapePick),
        reachesAuthService: true,
        detail: 'Account reported as removed',
      };
    }
  }
}

/**
 * Generates an unusable Auth_Token, drawn uniformly across all ten causes in
 * {@link UNUSABLE_TOKEN_CAUSES}.
 *
 * Every case is fully materialized: {@link UnusableToken.authorization} is the
 * header value to send, and {@link UnusableToken.lookupResponse} is the answer
 * the fake `accounts:lookup` endpoint must give. Nothing is left for the
 * property test to reconstruct, so a counterexample is reproducible from the
 * case alone.
 *
 * Three biases are deliberate:
 *
 * - **The expiry boundary is drawn often.** 61 seconds is the first instant
 *   Requirement 4.3 calls expired given the 60-second tolerance, so 61, 62, and
 *   the 10,000-second far end are drawn as constants alongside the range.
 * - **The length boundary likewise.** `AUTH_TOKEN_MAX_CHARS + 1` is drawn as a
 *   constant, since off-by-one is the failure mode a length guard actually has.
 * - **Cases that never reach the lookup still carry an active-account answer.**
 *   Each such credential is valid in every respect except the one under test, so
 *   nothing but the intended defect can be doing the rejecting.
 *
 * @param kit Signing material from {@link createUnusableTokenKit}, built once
 *   per suite. Two RSA key pairs per kit makes it too expensive to build per draw.
 */
export function arbUnusableToken(kit: UnusableTokenKit): fc.Arbitrary<UnusableToken> {
  return fc
    .record({
      cause: fc.constantFrom(...UNUSABLE_TOKEN_CAUSES),
      userId: arbUserId,
      blankPick: fc.nat(),
      schemePick: fc.nat(),
      garbagePick: fc.nat(),
      expiredBySeconds: fc.oneof(
        { weight: 3, arbitrary: fc.constantFrom(61, 62, 10_000) },
        { weight: 7, arbitrary: fc.integer({ min: 61, max: 10_000 }) },
      ),
      overLengthChars: fc.oneof(
        { weight: 3, arbitrary: fc.constant(AUTH_TOKEN_MAX_CHARS + 1) },
        {
          weight: 7,
          arbitrary: fc.integer({
            min: AUTH_TOKEN_MAX_CHARS + 1,
            max: AUTH_TOKEN_MAX_CHARS * 2,
          }),
        },
      ),
      revokedAfterSeconds: fc.integer({ min: 1, max: 3600 }),
      removedShapePick: fc.nat(),
    })
    .map((draw) => buildUnusableToken(kit, draw));
}
