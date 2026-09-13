/**
 * In-memory {@link MealPlanRepository} for tests.
 *
 * This is deliberately not a loose mock. It reimplements the semantics the DynamoDB
 * adapter gets from the table itself, so it can serve as the *model* in the model-based
 * ordering, pagination, and cap properties: a property that holds here is a meaningful
 * statement about production only because the two implementations enforce the same
 * conditions.
 *
 * What is reimplemented rather than stubbed:
 *
 * - **One table, keyed the way the real one is.** State is a map of partition key
 *   (`userId`) to a map of sort key (`mealPlanId`) to a stored item, and every operation
 *   reaches exactly one partition. The pending-deletion entries live in the reserved
 *   {@link PENDING_DELETION_PARTITION} partition of that same map, exactly as they do in
 *   the table (Requirements 7.1, 7.2, 7.7, 11.7).
 * - **Items are the serialized form.** Records are stored by running them through
 *   `serializeMealPlanRecord` and read back through `deserializeMealPlanItem`, so the
 *   canonicalization the real store applies — an empty `warnings` list coming back absent,
 *   for instance — happens here too instead of being papered over by holding the original
 *   object (Requirements 9.4, 9.9).
 * - **The record cap is a counter on the `#meta` item**, not the size of the map, because
 *   that is what the adapter's transaction condition tests (Requirements 5.8, 5.9).
 * - **The storage acknowledgment is `storageAckAt` on that same `#meta` item**, and a
 *   first save without it writes nothing at all — the gate is checked before any record
 *   is stored, mirroring the transaction rolling back as a whole (Requirements 12.3,
 *   12.4, 12.5).
 * - **The create condition is `attribute_not_exists(mealPlanId)`;** update, rename, and
 *   delete carry `attribute_exists(mealPlanId)`. So a repeated create neither overwrites
 *   the stored record nor increments the counter, and a delete of an already-absent
 *   record is a silent success that does *not* decrement (Requirements 5.4, 8.1, 8.3).
 * - **Listings order by sort key descending and exclude `#meta` in the key condition**
 *   (`mealPlanId > '#meta'`) rather than by a post-filter, and a cursor advances strictly
 *   exclusively (Requirements 6.2, 6.3, 6.8).
 *
 * Two behaviors are worth calling out because they are easy to get subtly wrong:
 *
 * 1. `nextCursor` is emitted whenever a page fills to {@link MEAL_PLAN_PAGE_SIZE}, even
 *    when no record happens to remain. That is what DynamoDB does — a `Query` stopped by
 *    `Limit` returns a `LastEvaluatedKey` regardless — so an Account holding exactly 20
 *    records yields a full page with a cursor followed by an empty final page without
 *    one. Requirement 6.8 is met by that empty page, and modelling it any other way would
 *    make this repository disagree with the adapter.
 * 2. The `userId` argument always wins over `record.userId`. A record claiming a different
 *    owner still lands in the caller's partition, which is the confinement guarantee
 *    Requirements 7.1 and 7.7 ask for, rather than an error a caller might swallow.
 *
 * The repository performs no logging: `logStoreOp` is the adapter's job, and emitting log
 * lines from thousands of property-test runs would only be noise. The {@link StoreCall}
 * ledger below exists instead, so a test can assert what was attempted.
 */

import { mealPlanIdTimestampMs } from '../mealPlanId';
import {
  deserializeMealPlanItem,
  serializeMealPlanRecord,
  type MealPlanItem,
} from '../mealPlanSerializer';
import { decodeCursor, encodeCursor } from '../pagination';
import type { MealPlanRecord, MealPlanSummary, PendingDeletion } from '../types';
import {
  MEAL_PLAN_PAGE_SIZE,
  MEAL_PLAN_RECORD_CAP,
  META_SORT_KEY,
  PENDING_DELETION_PARTITION,
  type ListPage,
  type MealPlanRepository,
  type MealPlanRepositoryDeps,
  type SaveOutcome,
} from './mealPlanRepository';

// ─── Stored shapes ─────────────────────────────────────────────────────────────

/** A stored attribute value, in the same tagged form the serializer produces. */
type Attribute = { S: string } | { N: string } | Record<string, unknown>;

/** One stored item: a bag of tagged attributes, as DynamoDB holds it. */
type StoredItem = Record<string, Attribute>;

/** The record counter and acknowledgment carried by the per-Account `#meta` item. */
interface MetaState {
  planCount: number;
  storageAckAt?: string;
}

// ─── Test seams ────────────────────────────────────────────────────────────────

/** Whether an attempted operation would read or write. */
export type StoreAccess = 'read' | 'write';

/**
 * One attempted repository operation, recorded before its conditions are evaluated so a
 * rejected write still appears. `userId` is always present, which is what lets a test
 * assert that no operation omitted the partition key or scanned the table.
 */
export interface StoreCall {
  op:
    | 'create'
    | 'update'
    | 'rename'
    | 'get'
    | 'list'
    | 'listAll'
    | 'delete'
    | 'purge'
    | 'enqueuePendingDeletion'
    | 'listPendingDeletions';
  access: StoreAccess;
  userId: string;
  mealPlanId?: string;
}

/** Initial state for one Account, written without evaluating the cap or the ack gate. */
export interface AccountSeed {
  userId: string;
  /** Records to store. Each is keyed by its own `mealPlanId` within `userId`. */
  records?: MealPlanRecord[];
  /**
   * Value for `storageAckAt`. Absent leaves the Account unacknowledged, so its next
   * `create` without `ackStorage` yields `ack-required` (Requirement 12.3).
   */
  storageAckAt?: string;
  /**
   * Value for the record counter. Defaults to the number of seeded records; set it
   * explicitly to place an Account at the cap without materializing 100 records.
   */
  planCount?: number;
}

/** The repository plus the seams a test needs to seed, inspect, and compare state. */
export interface InMemoryMealPlanRepository extends MealPlanRepository {
  /** Writes initial state for one or more Accounts, bypassing the cap and ack gates. */
  seed(seeds: AccountSeed[]): void;
  /** Stable serialization of the whole table, for byte-for-byte comparison. */
  snapshot(): string;
  /** Stable serialization of one partition, for byte-for-byte comparison. */
  snapshotPartition(userId: string): string;
  /** Every operation attempted so far, oldest first. */
  readonly calls: readonly StoreCall[];
  /** Empties the {@link calls} ledger. */
  clearCalls(): void;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** ISO-8601 UTC with exactly three fractional digits, matching every stored timestamp. */
function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

/** Deep copy of a JSON-shaped value, so no caller can reach into stored state. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Reads an `S` attribute that the stored shape guarantees is present. */
function stringAttribute(item: StoredItem, attribute: string): string {
  const value = item[attribute] as { S?: unknown } | undefined;
  return typeof value?.S === 'string' ? value.S : '';
}

/** Reads an `N` attribute, which DynamoDB carries as a string. */
function numberAttribute(item: StoredItem, attribute: string): number {
  const value = item[attribute] as { N?: unknown } | undefined;
  if (typeof value?.N !== 'string') return 0;
  const parsed = Number.parseInt(value.N, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** The serialized record as a stored item; the two shapes agree attribute for attribute. */
function toStoredItem(item: MealPlanItem): StoredItem {
  return clone(item) as unknown as StoredItem;
}

/** Stable JSON with keys in sorted order, so two equal states serialize identically. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

// ─── Factory ───────────────────────────────────────────────────────────────────

/**
 * Builds an in-memory Meal_Plan_Store.
 *
 * @param deps - Injected clock and id generator. The clock stamps the acknowledgment and
 *   the pending-deletion entries; the id generator is used only when a `create` supplies
 *   no `mealPlanId`, in which case `createdAt` is derived from the generated ULID so the
 *   id and the timestamp cannot disagree.
 */
export function createInMemoryMealPlanRepository(
  deps: MealPlanRepositoryDeps
): InMemoryMealPlanRepository {
  /** partition key → sort key → item. Empty partitions are pruned, never left behind. */
  const table = new Map<string, Map<string, StoredItem>>();
  const calls: StoreCall[] = [];

  function record(call: StoreCall): void {
    calls.push({ ...call });
  }

  function partitionOf(userId: string): Map<string, StoredItem> | undefined {
    return table.get(userId);
  }

  /** Creates the partition on first write; reads never materialize one. */
  function writablePartition(userId: string): Map<string, StoredItem> {
    const existing = table.get(userId);
    if (existing !== undefined) return existing;
    const created = new Map<string, StoredItem>();
    table.set(userId, created);
    return created;
  }

  function pruneIfEmpty(userId: string): void {
    const partition = table.get(userId);
    if (partition !== undefined && partition.size === 0) table.delete(userId);
  }

  function readMeta(userId: string): MetaState {
    const item = partitionOf(userId)?.get(META_SORT_KEY);
    if (item === undefined) return { planCount: 0 };
    const planCount = numberAttribute(item, 'planCount');
    const ack = (item.storageAckAt as { S?: unknown } | undefined)?.S;
    return typeof ack === 'string' ? { planCount, storageAckAt: ack } : { planCount };
  }

  function writeMeta(userId: string, state: MetaState): void {
    const partition = writablePartition(userId);
    const item: StoredItem = {
      userId: { S: userId },
      mealPlanId: { S: META_SORT_KEY },
      planCount: { N: String(state.planCount) },
    };
    if (state.storageAckAt !== undefined) {
      item.storageAckAt = { S: state.storageAckAt };
    }
    partition.set(META_SORT_KEY, item);
  }

  /**
   * The stored record at a key, or `undefined` when the Account holds none there — which
   * is also the answer for a record owned by another Account, since the lookup cannot
   * leave this partition (Requirements 7.3, 7.4).
   *
   * `#meta` is treated as absent. Requirement 7.8's charset check already rejects it
   * before any store access, so this is defense in depth against a future caller that
   * forgets to validate.
   */
  function recordItem(userId: string, mealPlanId: string): StoredItem | undefined {
    if (mealPlanId === META_SORT_KEY) return undefined;
    return partitionOf(userId)?.get(mealPlanId);
  }

  /**
   * Sort keys of an Account's Meal_Plan_Records, newest first.
   *
   * The `> '#meta'` comparison is the adapter's key condition, not a post-filter: `#` is
   * `0x23` and every Crockford base-32 character is a digit or an uppercase letter, so
   * every Meal_Plan_Id sorts strictly above it. Descending lexicographic order over
   * ULIDs is descending creation time, with ids sharing a millisecond broken by id
   * descending (Requirement 6.2).
   */
  function recordKeysNewestFirst(userId: string): string[] {
    const partition = partitionOf(userId);
    if (partition === undefined) return [];
    return Array.from(partition.keys())
      .filter((sk) => sk > META_SORT_KEY)
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  }

  /** One partition as sorted key/item pairs, the basis of both snapshot seams. */
  function snapshotPartitionOf(userId: string): unknown[] {
    const partition = partitionOf(userId);
    if (partition === undefined) return [];
    return Array.from(partition.keys()).sort().map((sk) => [sk, partition.get(sk)]);
  }

  /** The metadata-only projection a listing returns (Requirement 6.1). */
  function summaryOf(item: StoredItem): MealPlanSummary {
    return {
      mealPlanId: stringAttribute(item, 'mealPlanId'),
      title: stringAttribute(item, 'title'),
      createdAt: stringAttribute(item, 'createdAt'),
      updatedAt: stringAttribute(item, 'updatedAt'),
    };
  }

  /**
   * The record as it will be stored: owned by `userId` whatever the record claims, and
   * carrying a generated id when the caller supplied none.
   */
  function prepareForCreate(userId: string, source: MealPlanRecord): MealPlanRecord {
    const owned: MealPlanRecord = { ...source, userId };
    const supplied = typeof owned.mealPlanId === 'string' ? owned.mealPlanId : '';
    if (supplied.length > 0) return owned;

    // The Meal_Plan_API assigns the id (Requirement 5.2); this path exists so a test may
    // let the store do it. `createdAt` comes from the id's own embedded millisecond
    // timestamp, which keeps the serializer's id/timestamp agreement check satisfied.
    const assigned = deps.newMealPlanId();
    const createdAt = isoOf(mealPlanIdTimestampMs(assigned));
    return { ...owned, mealPlanId: assigned, createdAt, updatedAt: createdAt };
  }

  return {
    // ── Writes ────────────────────────────────────────────────────────────────

    async create(userId, source, ackStorage): Promise<SaveOutcome> {
      const prepared = prepareForCreate(userId, source);
      record({ op: 'create', access: 'write', userId, mealPlanId: prepared.mealPlanId });

      // Validation happens before any condition, as it does in the adapter: an invalid
      // record never becomes a `Put` at all.
      const item: MealPlanItem = serializeMealPlanRecord(prepared);
      const meta = readMeta(userId);

      // `attribute_exists(storageAckAt) OR :ackNow = :true` — the whole transaction
      // rolls back, so nothing is written and no counter moves (Requirements 12.3, 12.5).
      if (meta.storageAckAt === undefined && !ackStorage) {
        return { kind: 'ack-required' };
      }

      // `attribute_not_exists(mealPlanId)` on the `Put`. A resubmitted identical save
      // leaves the stored record and the counter exactly as the first save left them, and
      // still reports success, so the client sees one record under one id
      // (Requirement 5.4).
      if (recordItem(userId, prepared.mealPlanId) !== undefined) {
        return { kind: 'created', mealPlanId: prepared.mealPlanId };
      }

      // `planCount < 100` on the `#meta` update (Requirements 5.8, 5.9).
      if (meta.planCount >= MEAL_PLAN_RECORD_CAP) {
        return { kind: 'cap-reached' };
      }

      writablePartition(userId).set(prepared.mealPlanId, toStoredItem(item));
      writeMeta(userId, {
        planCount: meta.planCount + 1,
        // `storageAckAt = if_not_exists(storageAckAt, :nowIso)` — first acknowledgment
        // wins, so the notice is required at most once per Account (Requirement 12.4).
        storageAckAt: meta.storageAckAt ?? isoOf(deps.now()),
      });

      return { kind: 'created', mealPlanId: prepared.mealPlanId };
    },

    async update(userId, source): Promise<SaveOutcome> {
      const mealPlanId = typeof source.mealPlanId === 'string' ? source.mealPlanId : '';
      record({ op: 'update', access: 'write', userId, mealPlanId });

      // `attribute_exists(mealPlanId)`.
      const existing = recordItem(userId, mealPlanId);
      if (existing === undefined) return { kind: 'not-found' };

      // The adapter is `SET content, title, updatedAt`, so `mealPlanId` and `createdAt`
      // are preserved structurally — a supplied `createdAt` cannot move them
      // (Requirements 5.3, 5.4).
      const next = serializeMealPlanRecord({
        ...source,
        userId,
        mealPlanId,
        createdAt: stringAttribute(existing, 'createdAt'),
      });
      writablePartition(userId).set(mealPlanId, toStoredItem(next));

      return { kind: 'updated' };
    },

    async rename(userId, mealPlanId, title, nowMs): Promise<SaveOutcome> {
      record({ op: 'rename', access: 'write', userId, mealPlanId });

      // `attribute_exists(mealPlanId)`.
      const existing = recordItem(userId, mealPlanId);
      if (existing === undefined) return { kind: 'not-found' };

      // `SET title, updatedAt` — content is untouched (Requirement 8.4).
      const next: StoredItem = { ...clone(existing) };
      next.title = { S: title };
      next.updatedAt = { S: isoOf(nowMs) };
      writablePartition(userId).set(mealPlanId, next);

      return { kind: 'updated' };
    },

    async delete(userId, mealPlanId): Promise<void> {
      record({ op: 'delete', access: 'write', userId, mealPlanId });

      const partition = partitionOf(userId);
      if (partition === undefined) return;
      if (mealPlanId === META_SORT_KEY) return;
      // `attribute_exists(mealPlanId)` failing means the record is already gone: a silent
      // success, and no decrement of a counter that never counted it (Requirement 8.3).
      if (!partition.has(mealPlanId)) return;

      partition.delete(mealPlanId);
      const meta = readMeta(userId);
      if (partition.has(META_SORT_KEY)) {
        writeMeta(userId, { ...meta, planCount: Math.max(0, meta.planCount - 1) });
      }
      pruneIfEmpty(userId);
    },

    async purge(userId): Promise<{ deletedCount: number; remaining: number }> {
      record({ op: 'purge', access: 'write', userId });

      const partition = partitionOf(userId);
      if (partition === undefined) return { deletedCount: 0, remaining: 0 };

      // Everything under the partition goes, the `#meta` item included — it holds the
      // acknowledgment timestamp, which is data belonging to the removed Account
      // (Requirement 11.3). Only Meal_Plan_Records are counted.
      let deletedCount = 0;
      for (const sk of Array.from(partition.keys())) {
        if (sk > META_SORT_KEY) deletedCount += 1;
        partition.delete(sk);
      }
      table.delete(userId);

      return { deletedCount, remaining: 0 };
    },

    async enqueuePendingDeletion(userId): Promise<void> {
      record({
        op: 'enqueuePendingDeletion',
        access: 'write',
        userId: PENDING_DELETION_PARTITION,
        mealPlanId: userId,
      });

      const partition = writablePartition(PENDING_DELETION_PARTITION);
      // Idempotent: a User_Id already on the list keeps the entry it has, so a repeated
      // enqueue leaves the same end state (Requirement 11.7).
      if (partition.has(userId)) return;

      const enqueuedAt = isoOf(deps.now());
      partition.set(userId, {
        userId: { S: PENDING_DELETION_PARTITION },
        mealPlanId: { S: userId },
        attempts: { N: '0' },
        enqueuedAt: { S: enqueuedAt },
        // Due at once, so the next sweep picks it up rather than skipping a day.
        nextAttemptAt: { S: enqueuedAt },
      });
    },

    // ── Reads ─────────────────────────────────────────────────────────────────

    async get(userId, mealPlanId): Promise<MealPlanRecord | null> {
      record({ op: 'get', access: 'read', userId, mealPlanId });

      const item = recordItem(userId, mealPlanId);
      return item === undefined ? null : deserializeMealPlanItem(clone(item));
    },

    async list(userId, cursor): Promise<ListPage> {
      record({ op: 'list', access: 'read', userId });

      let after: string | undefined;
      if (cursor !== undefined) {
        const decoded = decodeCursor(cursor);
        // The Meal_Plan_API decodes and rejects a bad cursor with 400 before reaching the
        // store, so this is unreachable through a request; it throws rather than silently
        // restarting the traversal, which would hide the caller's mistake.
        if (!decoded.ok) {
          throw new RangeError('list: cursor is not a valid continuation token');
        }
        after = decoded.sk;
      }

      const partition = partitionOf(userId) ?? new Map<string, StoredItem>();
      // Strictly exclusive advance, in the descending direction the query runs
      // (Requirements 6.3, 6.8).
      const keys = recordKeysNewestFirst(userId).filter((sk) => after === undefined || sk < after);
      const page = keys.slice(0, MEAL_PLAN_PAGE_SIZE);
      const items = page.flatMap((sk) => {
        const item = partition.get(sk);
        return item === undefined ? [] : [summaryOf(item)];
      });

      // A page filled to the limit carries a cursor, whether or not a record remains —
      // DynamoDB returns `LastEvaluatedKey` whenever `Limit` stopped the query, so the
      // final page of an Account holding a multiple of 20 records is an empty one.
      return page.length === MEAL_PLAN_PAGE_SIZE
        ? { items, nextCursor: encodeCursor(page[page.length - 1]) }
        : { items };
    },

    async listAll(userId): Promise<MealPlanRecord[]> {
      record({ op: 'listAll', access: 'read', userId });

      const partition = partitionOf(userId);
      if (partition === undefined) return [];
      // No page limit (Requirement 10.2); bounded by the record cap regardless.
      return recordKeysNewestFirst(userId).flatMap((sk) => {
        const item = partition.get(sk);
        return item === undefined ? [] : [deserializeMealPlanItem(clone(item))];
      });
    },

    async listPendingDeletions(nowMs): Promise<PendingDeletion[]> {
      record({
        op: 'listPendingDeletions',
        access: 'read',
        userId: PENDING_DELETION_PARTITION,
      });

      const partition = partitionOf(PENDING_DELETION_PARTITION);
      if (partition === undefined) return [];

      return Array.from(partition.keys())
        .filter((sk) => sk > META_SORT_KEY)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .flatMap<PendingDeletion>((sk) => {
          const item = partition.get(sk);
          if (item === undefined) return [];
          return [
            {
              userId: sk,
              attempts: numberAttribute(item, 'attempts'),
              enqueuedAt: stringAttribute(item, 'enqueuedAt'),
              nextAttemptAt: stringAttribute(item, 'nextAttemptAt'),
            },
          ];
        })
        .filter((entry) => Date.parse(entry.nextAttemptAt) <= nowMs);
    },

    // ── Test seams ────────────────────────────────────────────────────────────

    seed(seeds): void {
      for (const seed of seeds) {
        const records = seed.records ?? [];
        for (const source of records) {
          const item = serializeMealPlanRecord({ ...source, userId: seed.userId });
          writablePartition(seed.userId).set(source.mealPlanId, toStoredItem(item));
        }
        const planCount = seed.planCount ?? records.length;
        if (planCount > 0 || seed.storageAckAt !== undefined) {
          writeMeta(seed.userId, { planCount, storageAckAt: seed.storageAckAt });
        }
      }
    },

    snapshot(): string {
      return stableStringify(
        Array.from(table.keys()).sort().map((userId) => [userId, snapshotPartitionOf(userId)])
      );
    },

    snapshotPartition(userId): string {
      return stableStringify(snapshotPartitionOf(userId));
    },

    get calls(): readonly StoreCall[] {
      return calls;
    },

    clearCalls(): void {
      calls.length = 0;
    },
  };
}
