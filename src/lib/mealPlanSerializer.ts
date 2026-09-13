/**
 * Meal_Plan_Serializer and Meal_Plan_Deserializer.
 *
 * Converts a {@link MealPlanRecord} to the DynamoDB item representation stored in the
 * Meal_Plan_Store and back again. Pure domain module: no I/O, no clock, no randomness.
 *
 * Four properties of the representation are load-bearing:
 *
 * 1. **Every collection is an `L` list.** Meal order, item order within a meal, and
 *    warning order all have to survive a round trip (Requirements 6.4, 9.3). DynamoDB's
 *    `SS`, `NS`, and `BS` set types are unordered and silently deduplicate, so no set
 *    type appears anywhere in a produced item.
 * 2. **`content` is a nested map, not a JSON blob string.** Requirement 9.5 requires the
 *    deserializer to name the specific attribute at fault, which needs per-attribute
 *    typing to report; a blob collapses every defect into "content failed to parse".
 * 3. **Absent means absent.** `notes` and `warnings` are omitted from the item entirely
 *    when the source value is absent, and the deserializer produces a record in which
 *    the key is absent rather than `''` or `[]` (Requirements 9.4, 9.9). A present
 *    `warnings: []` is treated as absent, so `serialize` of such a record produces an
 *    item with no `warnings` attribute — the one place the round trip canonicalizes
 *    rather than preserves.
 * 4. **Timestamps are ISO-8601 UTC strings with exactly three fractional digits.**
 *    Requirement 9.1 requires millisecond precision retained as UTC; a string keeps the
 *    same lexicographic ordering as the numeric value and stays self-describing.
 *
 * Character fidelity (Requirement 9.6) needs no escaping layer: strings are carried
 * through unchanged, with no Unicode normalization applied in either direction, so NFC
 * and NFD inputs each round-trip to themselves. The one genuine hazard is a lone
 * surrogate, which is not valid UTF-8; the serializer rejects it as a `wrong-type`
 * validation error naming the field rather than writing a value that would come back
 * altered.
 *
 * Lengths are measured in Unicode code points, matching `mealPlanTitle.ts`, so an
 * astral-plane character counts once rather than twice.
 */

import { isValidMealPlanId, mealPlanIdTimestampMs } from './mealPlanId';
import type {
  MealEntry,
  MealPlanContent,
  MealPlanItemEntry,
  MealPlanRecord,
} from './types';

// ─── Bounds and constants ──────────────────────────────────────────────────────

/**
 * Every bound Requirement 9.7 states, measured in Unicode code points for strings and
 * in entries for collections. The 1..10 meals bound is also what rejects a Meal_Plan
 * containing no meals (Requirement 5.15).
 *
 * The title bound is wider than the 1..100 the Meal_Plan_API accepts (Requirements 5.6,
 * 5.14) on purpose: the API narrows and truncates on input, while the serializer stays
 * able to read a record written by any caller honouring Requirement 9.7.
 */
export const SERIALIZER_BOUNDS = {
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

/** Longest User_Id accepted, matching the `sub` claim bound the token verifier enforces. */
const MAX_USER_ID_LENGTH = 128;

/** Schema version written on every item, so a future shape change is recognizable. */
export const MEAL_PLAN_SCHEMA_VERSION = 1;

/** The 100 kilobyte ceiling on a serialized Meal_Plan (Requirement 5.7). */
export const MAX_SERIALIZED_BYTES = 100 * 1024;

/** ISO-8601 UTC instant with exactly three fractional digits — `new Date(ms).toISOString()`. */
const ISO_UTC_MILLIS = /^-?\d{4,6}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// ─── Item representation ───────────────────────────────────────────────────────

/** A DynamoDB `S` (string) attribute value. */
export interface StringAttribute {
  S: string;
}

/** A DynamoDB `N` (number) attribute value. DynamoDB carries numbers as strings. */
export interface NumberAttribute {
  N: string;
}

/** A DynamoDB `L` (list) attribute value. Lists preserve order; sets would not. */
export interface ListAttribute<T> {
  L: T[];
}

/** A DynamoDB `M` (map) attribute value. */
export interface MapAttribute<T> {
  M: T;
}

/** One food item within a stored meal. `notes` is absent, never `{ S: '' }`, when unset. */
export type MealPlanItemAttribute = MapAttribute<{
  name: StringAttribute;
  portion: StringAttribute;
  notes?: StringAttribute;
}>;

/** One meal within a stored plan. Item order is significant, hence `L`. */
export type MealAttribute = MapAttribute<{
  mealName: StringAttribute;
  items: ListAttribute<MealPlanItemAttribute>;
}>;

/** The stored Meal_Plan content. `warnings` is absent, never `{ L: [] }`, when unset. */
export type MealPlanContentAttribute = MapAttribute<{
  meals: ListAttribute<MealAttribute>;
  summary: StringAttribute;
  warnings?: ListAttribute<StringAttribute>;
}>;

/**
 * The stored representation of one Meal_Plan_Record: `userId` is the partition key and
 * `mealPlanId` the sort key (Requirement 7.1).
 */
export interface MealPlanItem {
  userId: StringAttribute;
  mealPlanId: StringAttribute;
  title: StringAttribute;
  createdAt: StringAttribute;
  updatedAt: StringAttribute;
  schemaVersion: NumberAttribute;
  content: MealPlanContentAttribute;
}

// ─── Errors ────────────────────────────────────────────────────────────────────

/**
 * Signals that a Meal_Plan_Record violates a bound in Requirement 9.7, or carries a
 * value of the wrong type, and that no item was produced (Requirement 9.8).
 *
 * `field` is a dotted path with bracketed indices, naming the offending value exactly:
 * `title`, `content.meals`, `content.meals[2].items`, `content.meals[2].items[5].portion`,
 * `content.summary`, `content.warnings`, `content.warnings[3]`.
 */
export class MealPlanValidationError extends Error {
  constructor(
    readonly field: string,
    readonly bound: string
  ) {
    super(`Meal plan field "${field}" is not within its bound (${bound})`);
    this.name = 'MealPlanValidationError';
  }
}

/**
 * Signals that a stored item is missing an attribute the serializer writes, or holds an
 * attribute of a type the serializer never writes (Requirement 9.5). No Meal_Plan_Record
 * is returned, partially populated or otherwise, and the input item is left unmodified.
 *
 * `attribute` uses the same dotted-with-indices path format as
 * {@link MealPlanValidationError.field}, naming the attribute within the item.
 */
export class MealPlanItemError extends Error {
  constructor(
    readonly attribute: string,
    readonly reason: 'missing' | 'wrong-type'
  ) {
    super(
      `Stored meal plan attribute "${attribute}" is ${
        reason === 'missing' ? 'absent' : 'of an unexpected type'
      }`
    );
    this.name = 'MealPlanItemError';
  }
}

// ─── Shared string helpers ─────────────────────────────────────────────────────

/** Counts Unicode code points, so an astral-plane character counts once. */
function codePointLength(value: string): number {
  return Array.from(value).length;
}

/**
 * Reports whether a string contains an unpaired surrogate code unit.
 *
 * A lone surrogate has no UTF-8 encoding, so a store round trip would silently replace
 * it. The serializer rejects such a value rather than writing something that comes back
 * altered (Requirement 9.6).
 */
function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    const isHigh = unit >= 0xd800 && unit <= 0xdbff;
    const isLow = unit >= 0xdc00 && unit <= 0xdfff;
    if (!isHigh && !isLow) continue;
    if (isLow) return true; // a low surrogate not consumed by a preceding high one
    const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
    if (next < 0xdc00 || next > 0xdfff) return true;
    i += 1; // well-formed pair
  }
  return false;
}

/** UTF-8 byte length of a string, counting a surrogate pair as one 4-byte code point. */
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
        continue;
      }
      bytes += 3;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

// ─── Serialization ─────────────────────────────────────────────────────────────

/**
 * Validates that a value is a string free of lone surrogates and within its bound,
 * naming the field when it is not.
 */
function validString(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string') {
    throw new MealPlanValidationError(field, 'wrong-type');
  }
  if (hasLoneSurrogate(value)) {
    throw new MealPlanValidationError(field, 'wrong-type');
  }
  const length = codePointLength(value);
  if (length < min || length > max) {
    throw new MealPlanValidationError(field, `${min}..${max} characters`);
  }
  return value;
}

/** Validates that a value is an array holding `min` to `max` entries. */
function validArray(value: unknown, field: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value)) {
    throw new MealPlanValidationError(field, 'wrong-type');
  }
  if (value.length < min || value.length > max) {
    throw new MealPlanValidationError(field, `${min}..${max} entries`);
  }
  return value;
}

/** Validates an ISO-8601 UTC timestamp carrying exactly three fractional digits. */
function validTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new MealPlanValidationError(field, 'wrong-type');
  }
  if (!ISO_UTC_MILLIS.test(value)) {
    throw new MealPlanValidationError(field, 'ISO-8601 UTC with 3 fractional digits');
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms) || new Date(ms).toISOString() !== value) {
    throw new MealPlanValidationError(field, 'ISO-8601 UTC with 3 fractional digits');
  }
  return value;
}

function serializeItemEntry(value: unknown, field: string): MealPlanItemAttribute {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MealPlanValidationError(field, 'wrong-type');
  }
  const entry = value as Partial<MealPlanItemEntry>;
  const B = SERIALIZER_BOUNDS;

  const attributes: {
    name: StringAttribute;
    portion: StringAttribute;
    notes?: StringAttribute;
  } = {
    name: { S: validString(entry.name, `${field}.name`, B.itemName.min, B.itemName.max) },
    portion: {
      S: validString(entry.portion, `${field}.portion`, B.portion.min, B.portion.max),
    },
  };

  // Absent stays absent: the attribute is omitted rather than written as '' (Req 9.4).
  if (entry.notes !== undefined) {
    attributes.notes = {
      S: validString(entry.notes, `${field}.notes`, B.itemNote.min, B.itemNote.max),
    };
  }

  return { M: attributes };
}

function serializeMeal(value: unknown, field: string): MealAttribute {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MealPlanValidationError(field, 'wrong-type');
  }
  const meal = value as Partial<MealEntry>;
  const B = SERIALIZER_BOUNDS;

  const items = validArray(
    meal.items,
    `${field}.items`,
    B.itemsPerMeal.min,
    B.itemsPerMeal.max
  );

  return {
    M: {
      mealName: {
        S: validString(meal.mealName, `${field}.mealName`, B.mealName.min, B.mealName.max),
      },
      items: {
        L: items.map((item, index) => serializeItemEntry(item, `${field}.items[${index}]`)),
      },
    },
  };
}

function serializeContent(value: unknown): MealPlanContentAttribute {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MealPlanValidationError('content', 'wrong-type');
  }
  const content = value as Partial<MealPlanContent>;
  const B = SERIALIZER_BOUNDS;

  // A record carrying no meals fails this bound, which is what rejects a Meal_Plan with
  // no meals at all (Requirement 5.15).
  const meals = validArray(content.meals, 'content.meals', B.meals.min, B.meals.max);

  const attributes: {
    meals: ListAttribute<MealAttribute>;
    summary: StringAttribute;
    warnings?: ListAttribute<StringAttribute>;
  } = {
    meals: { L: meals.map((meal, index) => serializeMeal(meal, `content.meals[${index}]`)) },
    summary: {
      S: validString(content.summary, 'content.summary', B.summary.min, B.summary.max),
    },
  };

  if (content.warnings !== undefined) {
    const warnings = validArray(
      content.warnings,
      'content.warnings',
      B.warnings.min,
      B.warnings.max
    );
    // An empty list is stored as an absent attribute, not as `{ L: [] }`, so absent and
    // empty collapse to the same stored shape (Requirements 9.4, 9.9).
    if (warnings.length > 0) {
      attributes.warnings = {
        L: warnings.map((warning, index) => ({
          S: validString(
            warning,
            `content.warnings[${index}]`,
            B.warning.min,
            B.warning.max
          ),
        })),
      };
    }
  }

  return { M: attributes };
}

/**
 * Converts a Meal_Plan_Record into its stored DynamoDB item representation.
 *
 * Validates every bound in Requirement 9.7 first, so a record that violates one produces
 * no item at all. Also asserts that the millisecond timestamp embedded in the ULID
 * `mealPlanId` equals `createdAt`, which keeps the sort key's newest-first ordering
 * guarantee from silently drifting.
 *
 * @param record - The Meal_Plan_Record to store
 * @returns The item to write, in which every collection is an `L` list
 * @throws {MealPlanValidationError} Naming the field or collection at fault
 */
export function serializeMealPlanRecord(record: MealPlanRecord): MealPlanItem {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    throw new MealPlanValidationError('record', 'wrong-type');
  }

  const userId = validString(record.userId, 'userId', 1, MAX_USER_ID_LENGTH);
  const createdAt = validTimestamp(record.createdAt, 'createdAt');
  const updatedAt = validTimestamp(record.updatedAt, 'updatedAt');

  if (typeof record.mealPlanId !== 'string') {
    throw new MealPlanValidationError('mealPlanId', 'wrong-type');
  }
  if (!isValidMealPlanId(record.mealPlanId)) {
    throw new MealPlanValidationError('mealPlanId', 'letters, digits, and hyphens, 1..64');
  }
  let embeddedMs: number;
  try {
    embeddedMs = mealPlanIdTimestampMs(record.mealPlanId);
  } catch {
    throw new MealPlanValidationError('mealPlanId', '26-character ULID');
  }
  if (embeddedMs !== Date.parse(createdAt)) {
    throw new MealPlanValidationError('mealPlanId', 'embedded timestamp equal to createdAt');
  }

  const B = SERIALIZER_BOUNDS;
  return {
    userId: { S: userId },
    mealPlanId: { S: record.mealPlanId },
    title: { S: validString(record.title, 'title', B.title.min, B.title.max) },
    createdAt: { S: createdAt },
    updatedAt: { S: updatedAt },
    schemaVersion: { N: String(MEAL_PLAN_SCHEMA_VERSION) },
    content: serializeContent(record.content),
  };
}

/**
 * Measures the stored item in UTF-8 bytes, for the 100 kilobyte guard in Requirement 5.7.
 *
 * The measure is taken over the item's JSON form, which is what the AWS SDK puts on the
 * wire, so attribute names and DynamoDB type tags are counted along with the values. It
 * is therefore never an under-estimate of the stored item size.
 *
 * @param item - An item produced by {@link serializeMealPlanRecord}
 * @returns The number of UTF-8 bytes the item occupies
 */
export function serializedByteLength(item: MealPlanItem): number {
  return utf8ByteLength(JSON.stringify(item));
}

// ─── Deserialization ───────────────────────────────────────────────────────────

/** Reads a record-shaped attribute container, naming the attribute when it is not one. */
function readObject(value: unknown, attribute: string): Record<string, unknown> {
  if (value === undefined) {
    throw new MealPlanItemError(attribute, 'missing');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MealPlanItemError(attribute, 'wrong-type');
  }
  return value as Record<string, unknown>;
}

/** Reads an `S` attribute. */
function readString(value: unknown, attribute: string): string {
  const holder = readObject(value, attribute);
  const inner = holder.S;
  if (typeof inner !== 'string') {
    throw new MealPlanItemError(attribute, 'wrong-type');
  }
  return inner;
}

/** Reads an `L` attribute. */
function readList(value: unknown, attribute: string): unknown[] {
  const holder = readObject(value, attribute);
  if (!Array.isArray(holder.L)) {
    throw new MealPlanItemError(attribute, 'wrong-type');
  }
  return holder.L;
}

/** Reads an `M` attribute. */
function readMap(value: unknown, attribute: string): Record<string, unknown> {
  const holder = readObject(value, attribute);
  const inner = holder.M;
  if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) {
    throw new MealPlanItemError(attribute, 'wrong-type');
  }
  return inner as Record<string, unknown>;
}

/** Reads an `N` attribute, keeping DynamoDB's string carriage of the number. */
function readNumber(value: unknown, attribute: string): string {
  const holder = readObject(value, attribute);
  const inner = holder.N;
  if (typeof inner !== 'string' || !/^-?\d+(\.\d+)?$/.test(inner)) {
    throw new MealPlanItemError(attribute, 'wrong-type');
  }
  return inner;
}

function deserializeItemEntry(value: unknown, attribute: string): MealPlanItemEntry {
  const entry = readMap(value, attribute);
  const item: MealPlanItemEntry = {
    name: readString(entry.name, `${attribute}.name`),
    portion: readString(entry.portion, `${attribute}.portion`),
  };
  // Absent stays absent — never surfaced as '' (Requirements 9.4, 9.9).
  if (entry.notes !== undefined) {
    item.notes = readString(entry.notes, `${attribute}.notes`);
  }
  return item;
}

function deserializeMeal(value: unknown, attribute: string): MealEntry {
  const meal = readMap(value, attribute);
  return {
    mealName: readString(meal.mealName, `${attribute}.mealName`),
    items: readList(meal.items, `${attribute}.items`).map((item, index) =>
      deserializeItemEntry(item, `${attribute}.items[${index}]`)
    ),
  };
}

function deserializeContent(value: unknown): MealPlanContent {
  const content = readMap(value, 'content');
  const result: MealPlanContent = {
    meals: readList(content.meals, 'content.meals').map((meal, index) =>
      deserializeMeal(meal, `content.meals[${index}]`)
    ),
    summary: readString(content.summary, 'content.summary'),
  };
  if (content.warnings !== undefined) {
    result.warnings = readList(content.warnings, 'content.warnings').map((warning, index) =>
      readString(warning, `content.warnings[${index}]`)
    );
  }
  return result;
}

/**
 * Converts a stored DynamoDB item representation back into a Meal_Plan_Record.
 *
 * Every attribute the serializer writes must be present and carry the type the
 * serializer wrote; `notes` and `warnings` are the only optional ones, and an absent
 * attribute yields a record in which that key is absent rather than empty
 * (Requirements 9.2, 9.4, 9.9). Any other defect throws before a record is built, so
 * nothing partially populated is ever returned, and the input item is never mutated
 * (Requirement 9.5).
 *
 * Bounds are deliberately not re-checked on read: a record already in the store is
 * returned as stored, so a bound change can never make saved data unreadable.
 *
 * @param item - The stored item, of unknown shape until validated
 * @returns The Meal_Plan_Record the item holds
 * @throws {MealPlanItemError} Naming the attribute at fault and whether it was absent or
 *   of an unexpected type
 */
export function deserializeMealPlanItem(item: unknown): MealPlanRecord {
  const attributes = readObject(item, 'item');

  const userId = readString(attributes.userId, 'userId');
  const mealPlanId = readString(attributes.mealPlanId, 'mealPlanId');
  const title = readString(attributes.title, 'title');
  const createdAt = readString(attributes.createdAt, 'createdAt');
  const updatedAt = readString(attributes.updatedAt, 'updatedAt');
  readNumber(attributes.schemaVersion, 'schemaVersion');
  const content = deserializeContent(attributes.content);

  return { userId, mealPlanId, title, createdAt, updatedAt, content };
}
