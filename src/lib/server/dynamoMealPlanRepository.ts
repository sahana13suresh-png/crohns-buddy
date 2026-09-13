/**
 * DynamoDB {@link MealPlanRepository} — the production Meal_Plan_Store adapter.
 *
 * This is the only module in the project that imports the AWS DynamoDB SDK. Route
 * handlers depend on the port in `mealPlanRepository.ts`, so nothing above this layer
 * knows a table exists (design: Adapters layer).
 *
 * Every condition here mirrors `inMemoryMealPlanRepository.ts` attribute for attribute,
 * because that repository is the *model* in the model-based ordering, pagination, and cap
 * properties: a property that holds against the model is a statement about production
 * only while the two agree. Where the two could drift, the drift is called out in a
 * comment below.
 *
 * Design choices worth stating:
 *
 * - **Raw `AttributeValue` items, not the document client.** `mealPlanSerializer.ts`
 *   already produces the tagged DynamoDB form (`{S:…}`, `{L:[…]}`, `{M:{…}}`) and the
 *   deserializer reads it back, naming the exact attribute at fault (Requirement 9.5).
 *   Marshalling through `lib-dynamodb` would convert twice and lose that fidelity, so
 *   commands from `@aws-sdk/client-dynamodb` carry the serializer's output verbatim.
 * - **No `ScanCommand` anywhere.** The IAM user has no `dynamodb:Scan` permission either
 *   (Requirement 7.5), but the absence of the import is the reviewable guarantee that no
 *   operation reads across more than one User_Id (Requirement 7.2). Every command below
 *   pins `userId` as the partition key.
 * - **`TransactionCanceledException` is never retried blindly** (design: Server-side
 *   resilience). Its `CancellationReasons` are inspected, and the `#meta` item returned
 *   under `ReturnValuesOnConditionCheckFailure` tells `cap-reached` (409) apart from
 *   `ack-required` (428) in one round trip.
 * - **`maxAttempts: 3`** on the client covers `ThrottlingException` and
 *   `ProvisionedThroughputExceededException` with the SDK's exponential backoff.
 * - **Every outcome goes through `logStoreOp`.** This module never calls `console.*`;
 *   `storeLog.ts` is the single sink, and its closed parameter type is what keeps
 *   Meal_Plan content, quiz answers, and identities out of the log (Requirement 7.6).
 *   Store operations without a single subject id — listings, purges, sweep reads — log an
 *   empty `mealPlanId`, since the only id available for those is a User_Id and that field
 *   deliberately does not exist.
 */

import {
  BatchWriteItemCommand,
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  TransactionCanceledException,
  UpdateItemCommand,
  type AttributeValue,
  type WriteRequest,
} from '@aws-sdk/client-dynamodb';

import { mealPlanIdTimestampMs } from '../mealPlanId';
import {
  MAX_SERIALIZED_BYTES,
  deserializeMealPlanItem,
  serializeMealPlanRecord,
  serializedByteLength,
  type MealPlanItem,
} from '../mealPlanSerializer';
import { decodeCursor, encodeCursor } from '../pagination';
import type { MealPlanRecord, MealPlanSummary, PendingDeletion } from '../types';
import { assertServerEnv } from './env';
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
import { logStoreOp, type StoreFailureCategory, type StoreOp } from './storeLog';

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Attempts the SDK makes per command, covering throttling with exponential backoff. */
export const DYNAMO_MAX_ATTEMPTS = 3;

/** `BatchWriteItem` accepts at most 25 requests per call. */
const BATCH_WRITE_SIZE = 25;

/** Attempts a single delete batch gets, including its first (Requirement 11.7). */
const PURGE_BATCH_ATTEMPTS = 3;

/** Wall-clock budget for the whole purge retry loop, in ms (Requirement 11.7). */
const PURGE_BUDGET_MS = 60_000;

/**
 * Safety bound on paged reads. At most 100 records exist per Account (Requirement 5.8)
 * and a `Query` page carries up to 1 MB, so a full read needs a handful of pages; this
 * only stops an unexpected non-terminating `LastEvaluatedKey` from looping forever.
 */
const MAX_QUERY_PAGES = 200;

// ─── Errors ────────────────────────────────────────────────────────────────────

/**
 * Signals that a serialized Meal_Plan exceeds the 100 kilobyte ceiling
 * (Requirement 5.7), and that nothing was written.
 *
 * The Meal_Plan_API runs the same check before delegating, so this is defense in depth
 * against a future caller that forgets; reaching it means a bug above this layer rather
 * than a Patient-visible condition.
 */
export class MealPlanTooLargeError extends Error {
  constructor(
    readonly byteLength: number,
    readonly maxBytes: number = MAX_SERIALIZED_BYTES
  ) {
    super(`Serialized meal plan is ${byteLength} bytes, over the ${maxBytes} byte ceiling`);
    this.name = 'MealPlanTooLargeError';
  }
}

// ─── Construction ──────────────────────────────────────────────────────────────

/** Seams for tests and for callers that already hold a client. */
export interface DynamoMealPlanRepositoryOptions {
  /** Pre-built client. Absent builds one from the `MEAL_PLAN_AWS_*` variables. */
  client?: DynamoDBClient;
  /** Table name override. Absent reads `MEAL_PLAN_TABLE_NAME`. */
  tableName?: string;
}

/**
 * Builds the DynamoDB client from the `MEAL_PLAN_AWS_*` variables.
 *
 * `MEAL_PLAN_TABLE_NAME` and `MEAL_PLAN_AWS_REGION` are required. An explicit
 * access-key pair remains supported for local or non-AWS hosting, but AWS-hosted
 * compute omits both values and uses the SDK's default credential provider to
 * assume its least-privilege execution role.
 */
export function createDynamoClientFromEnv(): DynamoDBClient {
  assertServerEnv(['MEAL_PLAN_STORE']);

  const accessKeyId = process.env.MEAL_PLAN_AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.MEAL_PLAN_AWS_SECRET_ACCESS_KEY;
  const credentials =
    accessKeyId && secretAccessKey
      ? { accessKeyId, secretAccessKey }
      : undefined;

  return new DynamoDBClient({
    region: process.env.MEAL_PLAN_AWS_REGION as string,
    ...(credentials === undefined ? {} : { credentials }),
    maxAttempts: DYNAMO_MAX_ATTEMPTS,
  });
}

/** Reads the table name, asserting the credential group first. */
export function resolveTableNameFromEnv(): string {
  assertServerEnv(['MEAL_PLAN_STORE']);
  return process.env.MEAL_PLAN_TABLE_NAME as string;
}

// ─── Attribute helpers ─────────────────────────────────────────────────────────

/** One item as the SDK carries it. */
type Item = Record<string, AttributeValue>;

/** A primary key, always naming both the partition and the sort key. */
interface PrimaryKey extends Item {
  userId: AttributeValue;
  mealPlanId: AttributeValue;
}

/**
 * The serializer's output as an SDK attribute map. The two shapes agree tag for tag —
 * `MealPlanItem` is a narrower spelling of the same wire form — so this is a re-typing
 * rather than a conversion.
 */
function toItem(item: MealPlanItem): Item {
  return item as unknown as Item;
}

function keyOf(userId: string, mealPlanId: string): PrimaryKey {
  return { userId: { S: userId }, mealPlanId: { S: mealPlanId } };
}

/** Reads an `S` attribute, yielding `''` when absent or of another type. */
function readString(item: Item | undefined, attribute: string): string {
  const value = item?.[attribute] as { S?: unknown } | undefined;
  return typeof value?.S === 'string' ? value.S : '';
}

/** Reads an `N` attribute as a number, yielding `0` when absent or unparsable. */
function readNumber(item: Item | undefined, attribute: string): number {
  const value = item?.[attribute] as { N?: unknown } | undefined;
  if (typeof value?.N !== 'string') return 0;
  const parsed = Number.parseInt(value.N, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Whether an `S` attribute is present. */
function hasString(item: Item | undefined, attribute: string): boolean {
  const value = item?.[attribute] as { S?: unknown } | undefined;
  return typeof value?.S === 'string';
}

/** ISO-8601 UTC with exactly three fractional digits, matching every stored timestamp. */
function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

/** The metadata-only projection a listing returns (Requirement 6.1). */
function summaryOf(item: Item): MealPlanSummary {
  return {
    mealPlanId: readString(item, 'mealPlanId'),
    title: readString(item, 'title'),
    createdAt: readString(item, 'createdAt'),
    updatedAt: readString(item, 'updatedAt'),
  };
}

// ─── Failure classification ────────────────────────────────────────────────────

/** Throttling and capacity errors the SDK has already retried to exhaustion. */
const THROTTLE_NAMES = new Set([
  'ProvisionedThroughputExceededException',
  'ThrottlingException',
  'RequestLimitExceeded',
  'TooManyRequestsException',
]);

/**
 * Classifies a thrown error for the log's `failureCategory`. Nothing from the error
 * reaches the log beyond this category, so a message carrying stored values cannot leak
 * through it (Requirement 7.6).
 */
function categorize(error: unknown): StoreFailureCategory {
  if (error instanceof MealPlanTooLargeError) return 'size';
  if (error instanceof ConditionalCheckFailedException) return 'not-found';
  const name = (error as { name?: unknown } | null)?.name;
  if (typeof name === 'string') {
    if (THROTTLE_NAMES.has(name)) return 'throttled';
    if (name === 'MealPlanValidationError' || name === 'MealPlanItemError') return 'validation';
  }
  return 'unavailable';
}

// ─── Factory ───────────────────────────────────────────────────────────────────

/**
 * Builds the production Meal_Plan_Store.
 *
 * @param deps - Injected clock and id generator. The clock stamps the storage
 *   acknowledgment, the pending-deletion entries, and every log line; the id generator is
 *   used only when a `create` arrives with no `mealPlanId`, which the Meal_Plan_API never
 *   does (it assigns the id itself, Requirement 5.2).
 * @param options - Client and table-name seams for tests
 */
export function createDynamoMealPlanRepository(
  deps: MealPlanRepositoryDeps,
  options: DynamoMealPlanRepositoryOptions = {}
): MealPlanRepository {
  const client = options.client ?? createDynamoClientFromEnv();
  const table = options.tableName ?? resolveTableNameFromEnv();

  function log(
    op: StoreOp,
    outcome: 'success' | 'failure',
    mealPlanId: string,
    failureCategory?: StoreFailureCategory
  ): void {
    logStoreOp({
      mealPlanId,
      op,
      outcome,
      ...(failureCategory === undefined ? {} : { failureCategory }),
      atMs: deps.now(),
    });
  }

  /** Runs an operation, logging its outcome exactly once whichever way it goes. */
  async function tracked<T>(op: StoreOp, mealPlanId: string, run: () => Promise<T>): Promise<T> {
    try {
      const result = await run();
      log(op, 'success', mealPlanId);
      return result;
    } catch (error) {
      log(op, 'failure', mealPlanId, categorize(error));
      throw error;
    }
  }

  // ── Paged reads ────────────────────────────────────────────────────────────

  /**
   * Walks every page of one Account's Meal_Plan_Records, newest first, with `#meta`
   * excluded in the key condition rather than by a post-filter.
   *
   * @param projection - `ProjectionExpression` to apply, or `undefined` for whole items
   */
  async function queryAllRecordPages(
    userId: string,
    projection?: { expression: string; names: Record<string, string> }
  ): Promise<Item[]> {
    const collected: Item[] = [];
    let startKey: Item | undefined;
    let pages = 0;

    do {
      const response = await client.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: '#userId = :uid AND #mealPlanId > :low',
          ExpressionAttributeNames: {
            '#userId': 'userId',
            '#mealPlanId': 'mealPlanId',
            ...(projection?.names ?? {}),
          },
          ExpressionAttributeValues: {
            ':uid': { S: userId },
            ':low': { S: META_SORT_KEY },
          },
          ...(projection === undefined ? {} : { ProjectionExpression: projection.expression }),
          ScanIndexForward: false,
          ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
        })
      );

      collected.push(...((response.Items ?? []) as Item[]));
      startKey = response.LastEvaluatedKey as Item | undefined;
      pages += 1;
    } while (startKey !== undefined && pages < MAX_QUERY_PAGES);

    return collected;
  }

  /** Every primary key under one partition, `#meta` included — the purge reads all of it. */
  async function queryAllKeys(partitionKey: string): Promise<PrimaryKey[]> {
    const keys: PrimaryKey[] = [];
    let startKey: Item | undefined;
    let pages = 0;

    do {
      const response = await client.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: '#userId = :uid',
          ExpressionAttributeNames: { '#userId': 'userId', '#mealPlanId': 'mealPlanId' },
          ExpressionAttributeValues: { ':uid': { S: partitionKey } },
          ProjectionExpression: '#userId, #mealPlanId',
          ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
        })
      );

      for (const item of (response.Items ?? []) as Item[]) {
        keys.push(keyOf(partitionKey, readString(item, 'mealPlanId')));
      }
      startKey = response.LastEvaluatedKey as Item | undefined;
      pages += 1;
    } while (startKey !== undefined && pages < MAX_QUERY_PAGES);

    return keys;
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  /**
   * The record as it will be written: owned by `userId` whatever it claims, which is the
   * confinement guarantee of Requirements 7.1 and 7.7 rather than an error a caller could
   * swallow. A `create` arriving with no id gets one, with `createdAt` taken from the
   * id's own embedded millisecond timestamp so the two cannot disagree.
   */
  function prepareForCreate(userId: string, source: MealPlanRecord): MealPlanRecord {
    const owned: MealPlanRecord = { ...source, userId };
    const supplied = typeof owned.mealPlanId === 'string' ? owned.mealPlanId : '';
    if (supplied.length > 0) return owned;

    const assigned = deps.newMealPlanId();
    const createdAt = isoOf(mealPlanIdTimestampMs(assigned));
    return { ...owned, mealPlanId: assigned, createdAt, updatedAt: createdAt };
  }

  /** Serializes and enforces the 100 kilobyte ceiling before any command is built. */
  function serializeForWrite(record: MealPlanRecord): MealPlanItem {
    const item = serializeMealPlanRecord(record);
    const bytes = serializedByteLength(item);
    if (bytes > MAX_SERIALIZED_BYTES) throw new MealPlanTooLargeError(bytes);
    return item;
  }

  /**
   * Reads the cancellation reason for one transaction item.
   *
   * `CancellationReasons` is positional: index 0 is the first `TransactItems` entry.
   */
  function reasonAt(
    error: TransactionCanceledException,
    index: number
  ): { code: string; item?: Item } {
    const reason = (error.CancellationReasons ?? [])[index];
    return {
      code: typeof reason?.Code === 'string' ? reason.Code : 'None',
      item: reason?.Item as Item | undefined,
    };
  }

  async function createRecord(
    userId: string,
    source: MealPlanRecord,
    ackStorage: boolean
  ): Promise<SaveOutcome> {
    const prepared = prepareForCreate(userId, source);
    const mealPlanId = prepared.mealPlanId;

    // Validation and the size guard run before any command exists, so a rejected record
    // never becomes a `Put` (Requirements 5.7, 9.8).
    const item = serializeForWrite(prepared);
    const nowIso = isoOf(deps.now());

    try {
      await client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              // Requirement 5.4: a resubmitted identical save neither overwrites the
              // stored record nor moves the counter.
              Put: {
                TableName: table,
                Item: toItem(item),
                ConditionExpression: 'attribute_not_exists(#mealPlanId)',
                ExpressionAttributeNames: { '#mealPlanId': 'mealPlanId' },
              },
            },
            {
              // The counter and the acknowledgment move in the same transaction as the
              // record, so the cap holds under concurrent saves and a declined notice
              // rolls the whole write back (Requirements 5.8, 5.9, 12.3, 12.5).
              Update: {
                TableName: table,
                Key: keyOf(userId, META_SORT_KEY),
                UpdateExpression:
                  'SET #planCount = if_not_exists(#planCount, :zero) + :one, ' +
                  '#storageAckAt = if_not_exists(#storageAckAt, :nowIso)',
                ConditionExpression:
                  '(attribute_exists(#storageAckAt) OR :ackNow = :true) AND ' +
                  '(attribute_not_exists(#planCount) OR #planCount < :cap)',
                ExpressionAttributeNames: {
                  '#planCount': 'planCount',
                  '#storageAckAt': 'storageAckAt',
                },
                ExpressionAttributeValues: {
                  ':zero': { N: '0' },
                  ':one': { N: '1' },
                  ':cap': { N: String(MEAL_PLAN_RECORD_CAP) },
                  ':nowIso': { S: nowIso },
                  ':ackNow': { S: ackStorage ? 'true' : 'false' },
                  ':true': { S: 'true' },
                },
                // The rolled-back `#meta` item comes back with the failure, which is what
                // separates `cap-reached` from `ack-required` without a second read and
                // without retrying a condition that cannot start passing on its own.
                ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
              },
            },
          ],
        })
      );
    } catch (error) {
      if (!(error instanceof TransactionCanceledException)) throw error;

      const put = reasonAt(error, 0);
      const meta = reasonAt(error, 1);

      if (meta.code === 'ConditionalCheckFailed') {
        // Same precedence the in-memory model applies: acknowledgment, then the
        // already-stored record, then the cap.
        if (!hasString(meta.item, 'storageAckAt') && !ackStorage) {
          return { kind: 'ack-required' };
        }
        if (readNumber(meta.item, 'planCount') >= MEAL_PLAN_RECORD_CAP) {
          return { kind: 'cap-reached' };
        }
      }

      if (put.code === 'ConditionalCheckFailed') {
        // The record is already stored under this id and was left exactly as the first
        // save left it, which is the success the client saw then (Requirement 5.4).
        return { kind: 'created', mealPlanId };
      }

      throw error;
    }

    return { kind: 'created', mealPlanId };
  }

  // ── Repository ─────────────────────────────────────────────────────────────

  return {
    async create(userId, source, ackStorage): Promise<SaveOutcome> {
      const attemptedId = typeof source.mealPlanId === 'string' ? source.mealPlanId : '';
      try {
        const outcome = await createRecord(userId, source, ackStorage);
        const id = outcome.kind === 'created' ? outcome.mealPlanId : attemptedId;
        if (outcome.kind === 'created') {
          log('create', 'success', id);
        } else {
          // `cap-reached` has its own category; `ack-required` is a rejected write with no
          // category of its own, and `validation` is the closest of the six permitted
          // values — the log deliberately cannot say more than that.
          log('create', 'failure', id, outcome.kind === 'cap-reached' ? 'cap' : 'validation');
        }
        return outcome;
      } catch (error) {
        log('create', 'failure', attemptedId, categorize(error));
        throw error;
      }
    },

    async update(userId, source): Promise<SaveOutcome> {
      const mealPlanId = typeof source.mealPlanId === 'string' ? source.mealPlanId : '';

      // `SET content, title, updatedAt` leaves `mealPlanId` and `createdAt` untouched, so
      // both are preserved structurally rather than by a rule this code has to apply
      // (Requirements 5.3, 5.4). `createdAt` is derived from the id's embedded timestamp,
      // which the serializer guarantees equals the stored value, so a caller passing a
      // stale `createdAt` cannot turn a valid update into a validation error.
      let createdAt = source.createdAt;
      try {
        createdAt = isoOf(mealPlanIdTimestampMs(mealPlanId));
      } catch {
        // Not a ULID — serialization below reports it, naming `mealPlanId`.
      }

      const item = serializeForWrite({ ...source, userId, mealPlanId, createdAt });

      try {
        await client.send(
          new UpdateItemCommand({
            TableName: table,
            Key: keyOf(userId, mealPlanId),
            UpdateExpression:
              'SET #content = :content, #title = :title, #updatedAt = :updatedAt, ' +
              '#schemaVersion = :schemaVersion',
            ConditionExpression: 'attribute_exists(#mealPlanId)',
            ExpressionAttributeNames: {
              '#mealPlanId': 'mealPlanId',
              '#content': 'content',
              '#title': 'title',
              '#updatedAt': 'updatedAt',
              '#schemaVersion': 'schemaVersion',
            },
            ExpressionAttributeValues: {
              ':content': item.content as unknown as AttributeValue,
              ':title': item.title as unknown as AttributeValue,
              ':updatedAt': item.updatedAt as unknown as AttributeValue,
              ':schemaVersion': item.schemaVersion as unknown as AttributeValue,
            },
          })
        );
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) {
          log('update', 'failure', mealPlanId, 'not-found');
          return { kind: 'not-found' };
        }
        log('update', 'failure', mealPlanId, categorize(error));
        throw error;
      }

      log('update', 'success', mealPlanId);
      return { kind: 'updated' };
    },

    async rename(userId, mealPlanId, title, nowMs): Promise<SaveOutcome> {
      try {
        await client.send(
          new UpdateItemCommand({
            TableName: table,
            Key: keyOf(userId, mealPlanId),
            // Content is untouched (Requirement 8.4).
            UpdateExpression: 'SET #title = :title, #updatedAt = :updatedAt',
            ConditionExpression: 'attribute_exists(#mealPlanId)',
            ExpressionAttributeNames: {
              '#mealPlanId': 'mealPlanId',
              '#title': 'title',
              '#updatedAt': 'updatedAt',
            },
            ExpressionAttributeValues: {
              ':title': { S: title },
              ':updatedAt': { S: isoOf(nowMs) },
            },
          })
        );
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) {
          log('rename', 'failure', mealPlanId, 'not-found');
          return { kind: 'not-found' };
        }
        log('rename', 'failure', mealPlanId, categorize(error));
        throw error;
      }

      log('rename', 'success', mealPlanId);
      return { kind: 'updated' };
    },

    async get(userId, mealPlanId): Promise<MealPlanRecord | null> {
      // Requirement 7.8's charset check already rejects `#meta` before any store access;
      // this is defense in depth against a future caller that forgets to validate.
      if (mealPlanId === META_SORT_KEY) return null;

      return tracked('get', mealPlanId, async () => {
        const response = await client.send(
          new GetItemCommand({
            TableName: table,
            Key: keyOf(userId, mealPlanId),
            // Eventually consistent: half the read cost, and a record is never read back
            // in the same request that wrote it.
            ConsistentRead: false,
          })
        );

        // A record owned by another Account gives exactly this answer, because the read
        // cannot leave this partition (Requirements 7.3, 7.4, 7.7).
        if (response.Item === undefined) return null;
        return deserializeMealPlanItem(response.Item);
      });
    },

    async list(userId, cursor): Promise<ListPage> {
      let startKey: PrimaryKey | undefined;
      if (cursor !== undefined) {
        const decoded = decodeCursor(cursor);
        // The Meal_Plan_API rejects a bad cursor with 400 before reaching the store, so
        // this is unreachable through a request; it throws rather than silently
        // restarting the traversal, which would hide the caller's mistake.
        if (!decoded.ok) {
          throw new RangeError('list: cursor is not a valid continuation token');
        }
        startKey = keyOf(userId, decoded.sk);
      }

      return tracked('list', '', async () => {
        const response = await client.send(
          new QueryCommand({
            TableName: table,
            // `#meta` is excluded by the key condition, not a post-filter: `#` is 0x23 and
            // every Crockford base-32 character sorts strictly above it (Requirement 6.1).
            KeyConditionExpression: '#userId = :uid AND #mealPlanId > :low',
            ExpressionAttributeNames: {
              '#userId': 'userId',
              '#mealPlanId': 'mealPlanId',
              '#title': 'title',
              '#createdAt': 'createdAt',
              '#updatedAt': 'updatedAt',
            },
            ExpressionAttributeValues: {
              ':uid': { S: userId },
              ':low': { S: META_SORT_KEY },
            },
            // Metadata only — a page costs a fraction of an RRU instead of 20 full plans.
            ProjectionExpression: '#mealPlanId, #title, #createdAt, #updatedAt',
            // Descending sort key is descending creation time, with ids sharing a
            // millisecond broken by id descending (Requirement 6.2).
            ScanIndexForward: false,
            Limit: MEAL_PLAN_PAGE_SIZE,
            ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
          })
        );

        const items = ((response.Items ?? []) as Item[]).map(summaryOf);
        const last = response.LastEvaluatedKey as Item | undefined;
        const lastSortKey = readString(last, 'mealPlanId');

        // `nextCursor` is present exactly when DynamoDB reports more to read. A page
        // filled to the limit carries one whether or not a record remains, so an Account
        // holding exactly 20 records yields a full page with a cursor and then an empty
        // final page without one — which is the page Requirement 6.8 is met by.
        return lastSortKey.length === 0 ? { items } : { items, nextCursor: encodeCursor(lastSortKey) };
      });
    },

    async listAll(userId): Promise<MealPlanRecord[]> {
      // No page limit (Requirement 10.2); bounded by the record cap regardless.
      return tracked('list', '', async () => {
        const items = await queryAllRecordPages(userId);
        return items.map((item) => deserializeMealPlanItem(item));
      });
    },

    async delete(userId, mealPlanId): Promise<void> {
      if (mealPlanId === META_SORT_KEY) return;

      try {
        await client.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              {
                Delete: {
                  TableName: table,
                  Key: keyOf(userId, mealPlanId),
                  ConditionExpression: 'attribute_exists(#mealPlanId)',
                  ExpressionAttributeNames: { '#mealPlanId': 'mealPlanId' },
                },
              },
              {
                // `if_not_exists(planCount, :one) - :one` floors an absent counter at
                // zero. A record can only exist through `create`, which writes the
                // counter, so an absent one means drift rather than a reachable state.
                Update: {
                  TableName: table,
                  Key: keyOf(userId, META_SORT_KEY),
                  UpdateExpression: 'SET #planCount = if_not_exists(#planCount, :one) - :one',
                  ExpressionAttributeNames: { '#planCount': 'planCount' },
                  ExpressionAttributeValues: { ':one': { N: '1' } },
                },
              },
            ],
          })
        );
      } catch (error) {
        // `attribute_exists` failing means the record is already gone: a silent success,
        // and the transaction rolled back so the counter never moved for a record it never
        // counted (Requirement 8.3 — an already-absent record still yields 204).
        if (
          error instanceof TransactionCanceledException &&
          reasonAt(error, 0).code === 'ConditionalCheckFailed'
        ) {
          log('delete', 'success', mealPlanId);
          return;
        }
        log('delete', 'failure', mealPlanId, categorize(error));
        throw error;
      }

      log('delete', 'success', mealPlanId);
    },

    async purge(userId): Promise<{ deletedCount: number; remaining: number }> {
      try {
        // Everything under the partition goes, the `#meta` item included — it holds the
        // acknowledgment timestamp, which is data belonging to the removed Account
        // (Requirement 11.3). Only Meal_Plan_Records are counted.
        const keys = await queryAllKeys(userId);
        const deadlineMs = deps.now() + PURGE_BUDGET_MS;

        let deletedCount = 0;
        let remaining = 0;

        for (let offset = 0; offset < keys.length; offset += BATCH_WRITE_SIZE) {
          const batch = keys.slice(offset, offset + BATCH_WRITE_SIZE);
          let pending: WriteRequest[] = batch.map((key) => ({ DeleteRequest: { Key: key } }));

          for (let attempt = 0; attempt < PURGE_BATCH_ATTEMPTS && pending.length > 0; attempt += 1) {
            if (deps.now() > deadlineMs) break;

            const response = await client.send(
              new BatchWriteItemCommand({ RequestItems: { [table]: pending } })
            );
            pending = (response.UnprocessedItems?.[table] ?? []) as WriteRequest[];
          }

          const unfinished = new Set(
            pending.map((request) => readString(request.DeleteRequest?.Key as Item, 'mealPlanId'))
          );
          for (const key of batch) {
            const sortKey = readString(key, 'mealPlanId');
            // The `#meta` item is removed but is not a Meal_Plan_Record, so it is counted
            // in neither total.
            if (sortKey <= META_SORT_KEY) continue;
            if (unfinished.has(sortKey)) remaining += 1;
            else deletedCount += 1;
          }
        }

        log('purge', remaining === 0 ? 'success' : 'failure', '', remaining === 0 ? undefined : 'throttled');
        return { deletedCount, remaining };
      } catch (error) {
        log('purge', 'failure', '', categorize(error));
        throw error;
      }
    },

    async enqueuePendingDeletion(userId): Promise<void> {
      const enqueuedAt = isoOf(deps.now());

      try {
        await client.send(
          new PutItemCommand({
            TableName: table,
            Item: {
              userId: { S: PENDING_DELETION_PARTITION },
              mealPlanId: { S: userId },
              attempts: { N: '0' },
              enqueuedAt: { S: enqueuedAt },
              // Due at once, so the next sweep picks it up rather than skipping a day.
              nextAttemptAt: { S: enqueuedAt },
            },
            // Idempotent: a User_Id already on the list keeps the entry it has, so a
            // repeated enqueue leaves the same end state (Requirement 11.7).
            ConditionExpression: 'attribute_not_exists(#mealPlanId)',
            ExpressionAttributeNames: { '#mealPlanId': 'mealPlanId' },
          })
        );
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) {
          log('purge', 'success', '');
          return;
        }
        log('purge', 'failure', '', categorize(error));
        throw error;
      }

      log('purge', 'success', '');
    },

    async listPendingDeletions(nowMs): Promise<PendingDeletion[]> {
      // Touches nothing outside the reserved partition and accepts no request-controlled
      // User_Id (Requirement 11.7).
      return tracked('list', '', async () => {
        const items = await queryAllRecordPages(PENDING_DELETION_PARTITION);
        return items
          .map<PendingDeletion>((item) => ({
            userId: readString(item, 'mealPlanId'),
            attempts: readNumber(item, 'attempts'),
            enqueuedAt: readString(item, 'enqueuedAt'),
            nextAttemptAt: readString(item, 'nextAttemptAt'),
          }))
          .filter((entry) => Date.parse(entry.nextAttemptAt) <= nowMs)
          .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
      });
    },
  };
}
