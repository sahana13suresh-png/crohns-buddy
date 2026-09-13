/**
 * Command-shape tests for the DynamoDB Meal_Plan_Store adapter (task 4.11).
 *
 * These tests assert what the adapter *emits*, not what a table would do with it. The
 * design's guarantees for this layer are all properties of the command shapes — the key
 * condition that excludes `#meta` (Requirement 6.2), the transaction conditions that hold
 * the cap and the acknowledgment gate (Requirements 5.9, 12.3), the `attribute_exists`
 * guards, the `SET` clause that structurally cannot touch `mealPlanId` or `createdAt`, and
 * the absence of any cross-partition read (Requirement 7.2) — so `aws-sdk-client-mock`
 * intercepting `send` is the right level to check them at.
 *
 * The 4-case smoke suite that previously lived in `dynamoMealPlanRepository.smoke.test.ts`
 * is folded in here, so this file is the single suite for the adapter.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
} from '@aws-sdk/client-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newMealPlanId } from '../mealPlanId';
import { serializeMealPlanRecord } from '../mealPlanSerializer';
import { decodeCursor } from '../pagination';
import type { MealPlanRecord } from '../types';
import {
  createDynamoClientFromEnv,
  createDynamoMealPlanRepository,
  DYNAMO_MAX_ATTEMPTS,
} from './dynamoMealPlanRepository';
import {
  MEAL_PLAN_PAGE_SIZE,
  MEAL_PLAN_RECORD_CAP,
  META_SORT_KEY,
  PENDING_DELETION_PARTITION,
  type MealPlanRepository,
} from './mealPlanRepository';

const TABLE = 'crohns-buddy-meal-plans';
const NOW_MS = Date.UTC(2025, 2, 14, 9, 12, 33, 481);
const NOW_ISO = new Date(NOW_MS).toISOString();
const OWNER = 'uid-1';

const ddb = mockClient(DynamoDBClient);

// ─── Fixtures ──────────────────────────────────────────────────────────────────

function repository(): MealPlanRepository {
  return createDynamoMealPlanRepository(
    { now: () => NOW_MS, newMealPlanId: () => newMealPlanId(NOW_MS) },
    {
      client: new DynamoDBClient({ region: 'us-east-1', maxAttempts: DYNAMO_MAX_ATTEMPTS }),
      tableName: TABLE,
    }
  );
}

function record(overrides: Partial<MealPlanRecord> = {}): MealPlanRecord {
  return {
    userId: OWNER,
    mealPlanId: newMealPlanId(NOW_MS),
    title: 'Low-fiber week',
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    content: {
      meals: [{ mealName: 'Breakfast', items: [{ name: 'Scrambled eggs', portion: '2 eggs' }] }],
      summary: 'Gentle low-residue day.',
    },
    ...overrides,
  };
}

/** A stored item as DynamoDB would return it, produced by the real serializer. */
function storedItem(source: MealPlanRecord): Record<string, AttributeValue> {
  return serializeMealPlanRecord(source) as unknown as Record<string, AttributeValue>;
}

/** A metadata-only projection row, as the listing `Query` returns. */
function summaryRow(mealPlanId: string, title: string): Record<string, AttributeValue> {
  return {
    mealPlanId: { S: mealPlanId },
    title: { S: title },
    createdAt: { S: NOW_ISO },
    updatedAt: { S: NOW_ISO },
  };
}

/** Sort keys as `queryAllKeys` reads them: the `#meta` item plus `count` records. */
function keyRows(count: number): Record<string, AttributeValue>[] {
  const rows = [{ userId: { S: OWNER }, mealPlanId: { S: META_SORT_KEY } }];
  for (let index = 0; index < count; index += 1) {
    rows.push({ userId: { S: OWNER }, mealPlanId: { S: `PLAN${String(index).padStart(4, '0')}` } });
  }
  return rows;
}

function cancelled(
  reasons: { Code: string; Item?: Record<string, AttributeValue> }[]
): TransactionCanceledException {
  return new TransactionCanceledException({
    message: 'Transaction cancelled',
    $metadata: {},
    CancellationReasons: reasons,
  });
}

beforeEach(() => {
  ddb.reset();
  // `storeLog` is the adapter's only output sink; silence it rather than assert on it.
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ─── Client configuration ──────────────────────────────────────────────────────

describe('client configuration', () => {
  it('builds a client with maxAttempts 3 from the MEAL_PLAN_AWS_* variables', async () => {
    vi.stubEnv('MEAL_PLAN_TABLE_NAME', TABLE);
    vi.stubEnv('MEAL_PLAN_AWS_REGION', 'us-east-1');
    vi.stubEnv('MEAL_PLAN_AWS_ACCESS_KEY_ID', 'AKIAEXAMPLE');
    vi.stubEnv('MEAL_PLAN_AWS_SECRET_ACCESS_KEY', 'secret-example');

    const client = createDynamoClientFromEnv();

    const maxAttempts = client.config.maxAttempts;
    const resolved = typeof maxAttempts === 'function' ? await maxAttempts() : maxAttempts;
    expect(resolved).toBe(3);
    expect(DYNAMO_MAX_ATTEMPTS).toBe(3);
    expect(await client.config.region()).toBe('us-east-1');
  });

  it('names the credential group instead of signing with an absent credential', () => {
    vi.stubEnv('MEAL_PLAN_TABLE_NAME', TABLE);
    vi.stubEnv('MEAL_PLAN_AWS_REGION', 'us-east-1');
    vi.stubEnv('MEAL_PLAN_AWS_ACCESS_KEY_ID', '');
    vi.stubEnv('MEAL_PLAN_AWS_SECRET_ACCESS_KEY', 'secret-example');

    expect(() => createDynamoClientFromEnv()).toThrow(/MEAL_PLAN_STORE/);
  });

  it('uses the AWS default credential provider when static keys are absent', async () => {
    vi.stubEnv('MEAL_PLAN_TABLE_NAME', TABLE);
    vi.stubEnv('MEAL_PLAN_AWS_REGION', 'us-east-1');
    vi.stubEnv('MEAL_PLAN_AWS_ACCESS_KEY_ID', undefined);
    vi.stubEnv('MEAL_PLAN_AWS_SECRET_ACCESS_KEY', undefined);

    const client = createDynamoClientFromEnv();

    expect(await client.config.region()).toBe('us-east-1');
    expect(client.config.credentials).toBeTypeOf('function');
  });
});

// ─── list ──────────────────────────────────────────────────────────────────────

describe('list', () => {
  it('excludes #meta in the key condition, reads newest first, and projects metadata only', async () => {
    ddb.on(QueryCommand).resolves({ Items: [], $metadata: {} });

    await repository().list(OWNER);

    const input = ddb.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.TableName).toBe(TABLE);
    expect(input.KeyConditionExpression).toBe('#userId = :uid AND #mealPlanId > :low');
    expect(input.ExpressionAttributeValues?.[':uid']).toEqual({ S: OWNER });
    expect(input.ExpressionAttributeValues?.[':low']).toEqual({ S: META_SORT_KEY });
    expect(input.ScanIndexForward).toBe(false);
    expect(input.Limit).toBe(MEAL_PLAN_PAGE_SIZE);
    expect(input.ProjectionExpression).toBe('#mealPlanId, #title, #createdAt, #updatedAt');
    // A metadata-only projection cannot carry content, so a listing can never return it.
    expect(input.ProjectionExpression).not.toMatch(/content/);
    expect(input.FilterExpression).toBeUndefined();
    expect(input.IndexName).toBeUndefined();
  });

  it('starts a continued page from the cursor position inside the derived partition', async () => {
    ddb.on(QueryCommand).resolves({ Items: [], $metadata: {} });
    const first = newMealPlanId(NOW_MS);

    ddb.reset();
    ddb.on(QueryCommand).resolves({
      Items: [summaryRow(first, 'Newest')],
      LastEvaluatedKey: { userId: { S: OWNER }, mealPlanId: { S: first } },
      $metadata: {},
    });

    const page = await repository().list(OWNER);
    expect(page.nextCursor).toBeDefined();

    ddb.reset();
    ddb.on(QueryCommand).resolves({ Items: [], $metadata: {} });
    await repository().list(OWNER, page.nextCursor as string);

    const input = ddb.commandCalls(QueryCommand)[0].args[0].input;
    // The cursor names only a sort-key position; the partition is always the derived one.
    expect(input.ExclusiveStartKey).toEqual({ userId: { S: OWNER }, mealPlanId: { S: first } });
    expect(decodeCursor(page.nextCursor as string)).toEqual({ ok: true, sk: first });
  });

  it('omits nextCursor on the final page', async () => {
    ddb.on(QueryCommand).resolves({
      Items: [summaryRow(newMealPlanId(NOW_MS), 'Only')],
      $metadata: {},
    });

    const page = await repository().list(OWNER);

    expect(page.items).toHaveLength(1);
    expect('nextCursor' in page).toBe(false);
  });

  it('reads a record with an eventually consistent GetItem keyed by both attributes', async () => {
    const stored = record();
    ddb.on(GetItemCommand).resolves({ Item: storedItem(stored), $metadata: {} });

    const found = await repository().get(OWNER, stored.mealPlanId);

    const input = ddb.commandCalls(GetItemCommand)[0].args[0].input;
    expect(input.Key).toEqual({ userId: { S: OWNER }, mealPlanId: { S: stored.mealPlanId } });
    expect(input.ConsistentRead).toBe(false);
    expect(found?.mealPlanId).toBe(stored.mealPlanId);
  });

  it('never reaches the store for the reserved #meta sort key', async () => {
    expect(await repository().get(OWNER, META_SORT_KEY)).toBeNull();
    expect(ddb.calls()).toHaveLength(0);
  });
});

// ─── create ────────────────────────────────────────────────────────────────────

describe('create', () => {
  it('guards the Put with attribute_not_exists and the #meta Update with the cap and ack conditions', async () => {
    ddb.on(TransactWriteItemsCommand).resolves({ $metadata: {} });
    const source = record();

    await repository().create(OWNER, source, true);

    const items = ddb.commandCalls(TransactWriteItemsCommand)[0].args[0].input.TransactItems ?? [];
    expect(items).toHaveLength(2);

    const put = items[0].Put;
    expect(put?.TableName).toBe(TABLE);
    expect(put?.ConditionExpression).toBe('attribute_not_exists(#mealPlanId)');
    expect(put?.Item?.mealPlanId).toEqual({ S: source.mealPlanId });

    const meta = items[1].Update;
    expect(meta?.Key).toEqual({ userId: { S: OWNER }, mealPlanId: { S: META_SORT_KEY } });
    expect(meta?.ConditionExpression).toContain('attribute_exists(#storageAckAt)');
    expect(meta?.ConditionExpression).toContain('#planCount < :cap');
    expect(meta?.ExpressionAttributeValues?.[':cap']).toEqual({ N: String(MEAL_PLAN_RECORD_CAP) });
    expect(meta?.ExpressionAttributeValues?.[':ackNow']).toEqual({ S: 'true' });
    expect(meta?.UpdateExpression).toContain('#planCount = if_not_exists(#planCount, :zero) + :one');
    // The rolled-back item is what separates cap-reached from ack-required in one trip.
    expect(meta?.ReturnValuesOnConditionCheckFailure).toBe('ALL_OLD');
  });

  it('writes the record under the derived User_Id whatever the record claims', async () => {
    ddb.on(TransactWriteItemsCommand).resolves({ $metadata: {} });

    await repository().create(OWNER, record({ userId: 'someone-else' }), true);

    const items = ddb.commandCalls(TransactWriteItemsCommand)[0].args[0].input.TransactItems ?? [];
    expect(items[0].Put?.Item?.userId).toEqual({ S: OWNER });
    expect(items[1].Update?.Key?.userId).toEqual({ S: OWNER });
  });

  it('passes :ackNow false when the request carries no acknowledgment', async () => {
    ddb.on(TransactWriteItemsCommand).resolves({ $metadata: {} });

    await repository().create(OWNER, record(), false);

    const items = ddb.commandCalls(TransactWriteItemsCommand)[0].args[0].input.TransactItems ?? [];
    expect(items[1].Update?.ExpressionAttributeValues?.[':ackNow']).toEqual({ S: 'false' });
  });

  it('maps a cancelled #meta condition with the cap reached to cap-reached', async () => {
    ddb.on(TransactWriteItemsCommand).rejects(
      cancelled([
        { Code: 'None' },
        {
          Code: 'ConditionalCheckFailed',
          Item: {
            storageAckAt: { S: '2025-03-01T00:00:00.000Z' },
            planCount: { N: String(MEAL_PLAN_RECORD_CAP) },
          },
        },
      ])
    );

    await expect(repository().create(OWNER, record(), false)).resolves.toEqual({
      kind: 'cap-reached',
    });
  });

  it('maps a cancelled #meta condition with no recorded acknowledgment to ack-required', async () => {
    ddb.on(TransactWriteItemsCommand).rejects(
      cancelled([{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }])
    );

    await expect(repository().create(OWNER, record(), false)).resolves.toEqual({
      kind: 'ack-required',
    });
  });

  it('prefers ack-required over cap-reached when both conditions could explain the failure', async () => {
    ddb.on(TransactWriteItemsCommand).rejects(
      cancelled([
        { Code: 'None' },
        { Code: 'ConditionalCheckFailed', Item: { planCount: { N: String(MEAL_PLAN_RECORD_CAP) } } },
      ])
    );

    await expect(repository().create(OWNER, record(), false)).resolves.toEqual({
      kind: 'ack-required',
    });
  });

  it('reports a resubmitted identical save as created without a second write', async () => {
    ddb.on(TransactWriteItemsCommand).rejects(
      cancelled([{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }])
    );
    const source = record();

    await expect(repository().create(OWNER, source, true)).resolves.toEqual({
      kind: 'created',
      mealPlanId: source.mealPlanId,
    });
    expect(ddb.commandCalls(TransactWriteItemsCommand)).toHaveLength(1);
  });

  it('rethrows a cancellation it cannot classify rather than reporting a save outcome', async () => {
    ddb.on(TransactWriteItemsCommand).rejects(
      cancelled([{ Code: 'None' }, { Code: 'ItemCollectionSizeLimitExceeded' }])
    );

    await expect(repository().create(OWNER, record(), true)).rejects.toBeInstanceOf(
      TransactionCanceledException
    );
  });
});

// ─── update and rename ─────────────────────────────────────────────────────────

describe('update', () => {
  it('guards with attribute_exists and sets neither mealPlanId nor createdAt', async () => {
    ddb.on(UpdateItemCommand).resolves({ $metadata: {} });
    const source = record();

    await repository().update(OWNER, source);

    const input = ddb.commandCalls(UpdateItemCommand)[0].args[0].input;
    expect(input.Key).toEqual({ userId: { S: OWNER }, mealPlanId: { S: source.mealPlanId } });
    expect(input.ConditionExpression).toBe('attribute_exists(#mealPlanId)');
    // Preservation is structural: the SET clause has no clause for either attribute, so
    // no rule has to remember to leave them alone (Requirements 5.3, 5.4).
    expect(input.UpdateExpression).not.toMatch(/createdAt/);
    expect(input.UpdateExpression).not.toMatch(/SET[^;]*#mealPlanId\s*=/);
    expect(Object.keys(input.ExpressionAttributeValues ?? {}).sort()).toEqual([
      ':content',
      ':schemaVersion',
      ':title',
      ':updatedAt',
    ]);
  });

  it('reports not-found when the guard fails, without a retry', async () => {
    ddb.on(UpdateItemCommand).rejects(
      new ConditionalCheckFailedException({ message: 'condition failed', $metadata: {} })
    );

    await expect(repository().update(OWNER, record())).resolves.toEqual({ kind: 'not-found' });
    expect(ddb.commandCalls(UpdateItemCommand)).toHaveLength(1);
  });
});

describe('rename', () => {
  it('sets only the title and updatedAt, guarded by attribute_exists', async () => {
    ddb.on(UpdateItemCommand).resolves({ $metadata: {} });
    const mealPlanId = newMealPlanId(NOW_MS);

    await repository().rename(OWNER, mealPlanId, 'Renamed plan', NOW_MS);

    const input = ddb.commandCalls(UpdateItemCommand)[0].args[0].input;
    expect(input.Key).toEqual({ userId: { S: OWNER }, mealPlanId: { S: mealPlanId } });
    expect(input.ConditionExpression).toBe('attribute_exists(#mealPlanId)');
    expect(input.UpdateExpression).toBe('SET #title = :title, #updatedAt = :updatedAt');
    expect(input.UpdateExpression).not.toMatch(/content/);
    expect(input.ExpressionAttributeValues).toEqual({
      ':title': { S: 'Renamed plan' },
      ':updatedAt': { S: NOW_ISO },
    });
  });

  it('reports not-found when the guard fails', async () => {
    ddb.on(UpdateItemCommand).rejects(
      new ConditionalCheckFailedException({ message: 'condition failed', $metadata: {} })
    );

    await expect(
      repository().rename(OWNER, newMealPlanId(NOW_MS), 'Renamed plan', NOW_MS)
    ).resolves.toEqual({ kind: 'not-found' });
  });
});

// ─── delete ────────────────────────────────────────────────────────────────────

describe('delete', () => {
  it('deletes and decrements #meta in one transaction guarded by attribute_exists', async () => {
    ddb.on(TransactWriteItemsCommand).resolves({ $metadata: {} });
    const mealPlanId = newMealPlanId(NOW_MS);

    await repository().delete(OWNER, mealPlanId);

    const items = ddb.commandCalls(TransactWriteItemsCommand)[0].args[0].input.TransactItems ?? [];
    expect(items).toHaveLength(2);
    expect(items[0].Delete?.Key).toEqual({ userId: { S: OWNER }, mealPlanId: { S: mealPlanId } });
    expect(items[0].Delete?.ConditionExpression).toBe('attribute_exists(#mealPlanId)');
    expect(items[1].Update?.Key).toEqual({
      userId: { S: OWNER },
      mealPlanId: { S: META_SORT_KEY },
    });
    expect(items[1].Update?.UpdateExpression).toBe(
      'SET #planCount = if_not_exists(#planCount, :one) - :one'
    );
  });

  it('treats an already-absent record as a silent success with the counter unmoved', async () => {
    ddb.on(TransactWriteItemsCommand).rejects(
      cancelled([{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }])
    );

    await expect(repository().delete(OWNER, newMealPlanId(NOW_MS))).resolves.toBeUndefined();
    // The transaction rolled back, so the decrement never applied and nothing was retried.
    expect(ddb.commandCalls(TransactWriteItemsCommand)).toHaveLength(1);
  });

  it('rethrows a cancellation whose first reason is not the missing record', async () => {
    ddb.on(TransactWriteItemsCommand).rejects(
      cancelled([{ Code: 'None' }, { Code: 'ValidationError' }])
    );

    await expect(repository().delete(OWNER, newMealPlanId(NOW_MS))).rejects.toBeInstanceOf(
      TransactionCanceledException
    );
  });

  it('never issues a command for the reserved #meta sort key', async () => {
    await repository().delete(OWNER, META_SORT_KEY);
    expect(ddb.calls()).toHaveLength(0);
  });
});

// ─── purge ─────────────────────────────────────────────────────────────────────

describe('purge', () => {
  it('deletes in batches of 25 and retries UnprocessedItems', async () => {
    ddb.on(QueryCommand).resolves({ Items: keyRows(30), $metadata: {} });
    ddb
      .on(BatchWriteItemCommand)
      .resolvesOnce({
        UnprocessedItems: {
          [TABLE]: [
            { DeleteRequest: { Key: { userId: { S: OWNER }, mealPlanId: { S: 'PLAN0005' } } } },
          ],
        },
        $metadata: {},
      })
      .resolves({ $metadata: {} });

    const result = await repository().purge(OWNER);

    const batches = ddb.commandCalls(BatchWriteItemCommand);
    // 31 keys — the `#meta` item plus 30 records — split at 25, with one retry of the
    // single unprocessed delete from the first batch.
    expect(batches).toHaveLength(3);
    expect(batches[0].args[0].input.RequestItems?.[TABLE]).toHaveLength(25);
    expect(batches[1].args[0].input.RequestItems?.[TABLE]).toHaveLength(1);
    expect(batches[2].args[0].input.RequestItems?.[TABLE]).toHaveLength(6);
    // `#meta` is removed but is not a Meal_Plan_Record, so it is counted in neither total.
    expect(result).toEqual({ deletedCount: 30, remaining: 0 });
  });

  it('reads keys only, confined to the derived partition', async () => {
    ddb.on(QueryCommand).resolves({ Items: keyRows(1), $metadata: {} });
    ddb.on(BatchWriteItemCommand).resolves({ $metadata: {} });

    await repository().purge(OWNER);

    const input = ddb.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.KeyConditionExpression).toBe('#userId = :uid');
    expect(input.ExpressionAttributeValues?.[':uid']).toEqual({ S: OWNER });
    expect(input.ProjectionExpression).toBe('#userId, #mealPlanId');
  });

  it('stops after 3 attempts per batch and reports what remains', async () => {
    ddb.on(QueryCommand).resolves({ Items: keyRows(2), $metadata: {} });
    ddb.on(BatchWriteItemCommand).resolves({
      UnprocessedItems: {
        [TABLE]: [
          { DeleteRequest: { Key: { userId: { S: OWNER }, mealPlanId: { S: 'PLAN0001' } } } },
        ],
      },
      $metadata: {},
    });

    const result = await repository().purge(OWNER);

    expect(ddb.commandCalls(BatchWriteItemCommand)).toHaveLength(3);
    expect(result).toEqual({ deletedCount: 1, remaining: 1 });
  });
});

// ─── pending deletions ─────────────────────────────────────────────────────────

describe('pending deletions', () => {
  it('enqueues idempotently into the reserved partition', async () => {
    ddb.on(PutItemCommand).resolves({ $metadata: {} });

    await repository().enqueuePendingDeletion(OWNER);

    const input = ddb.commandCalls(PutItemCommand)[0].args[0].input;
    expect(input.Item?.userId).toEqual({ S: PENDING_DELETION_PARTITION });
    expect(input.Item?.mealPlanId).toEqual({ S: OWNER });
    expect(input.ConditionExpression).toBe('attribute_not_exists(#mealPlanId)');
  });

  it('treats an already-listed User_Id as a success', async () => {
    ddb.on(PutItemCommand).rejects(
      new ConditionalCheckFailedException({ message: 'condition failed', $metadata: {} })
    );

    await expect(repository().enqueuePendingDeletion(OWNER)).resolves.toBeUndefined();
  });

  it('reads only entries due now, from the reserved partition', async () => {
    ddb.on(QueryCommand).resolves({
      Items: [
        {
          mealPlanId: { S: 'uid-due' },
          attempts: { N: '1' },
          enqueuedAt: { S: NOW_ISO },
          nextAttemptAt: { S: new Date(NOW_MS - 1_000).toISOString() },
        },
        {
          mealPlanId: { S: 'uid-later' },
          attempts: { N: '0' },
          enqueuedAt: { S: NOW_ISO },
          nextAttemptAt: { S: new Date(NOW_MS + 60_000).toISOString() },
        },
      ],
      $metadata: {},
    });

    const due = await repository().listPendingDeletions(NOW_MS);

    expect(due.map((entry) => entry.userId)).toEqual(['uid-due']);
    expect(ddb.commandCalls(QueryCommand)[0].args[0].input.ExpressionAttributeValues?.[':uid']).toEqual(
      { S: PENDING_DELETION_PARTITION }
    );
  });
});

// ─── No cross-partition read (Requirement 7.2) ─────────────────────────────────

describe('no Scan', () => {
  const modulePath = resolve(process.cwd(), 'src/lib/server/dynamoMealPlanRepository.ts');

  /** The module's executable text, with comments removed so prose cannot match. */
  function code(): string {
    return readFileSync(modulePath, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  it('neither imports nor constructs a Scan command', () => {
    const source = code();

    expect(source).toMatch(/from '@aws-sdk\/client-dynamodb'/);
    expect(source).not.toMatch(/\bScanCommand\b/);
    expect(source).not.toMatch(/\bnew\s+Scan/);
    expect(source).not.toMatch(/\bExecuteStatementCommand\b/);
    // The one `Scan`-shaped token that legitimately appears is the query direction flag.
    expect(source).toMatch(/ScanIndexForward/);
  });

  it('sends no Scan command while exercising every repository method', async () => {
    const stored = record();
    ddb.on(QueryCommand).resolves({ Items: [], $metadata: {} });
    ddb.on(GetItemCommand).resolves({ Item: storedItem(stored), $metadata: {} });
    ddb.on(PutItemCommand).resolves({ $metadata: {} });
    ddb.on(UpdateItemCommand).resolves({ $metadata: {} });
    ddb.on(TransactWriteItemsCommand).resolves({ $metadata: {} });
    ddb.on(BatchWriteItemCommand).resolves({ $metadata: {} });

    const repo = repository();
    await repo.create(OWNER, stored, true);
    await repo.update(OWNER, stored);
    await repo.rename(OWNER, stored.mealPlanId, 'Renamed', NOW_MS);
    await repo.get(OWNER, stored.mealPlanId);
    await repo.list(OWNER);
    await repo.listAll(OWNER);
    await repo.delete(OWNER, stored.mealPlanId);
    await repo.purge(OWNER);
    await repo.enqueuePendingDeletion(OWNER);
    await repo.listPendingDeletions(NOW_MS);

    const commandNames = ddb.calls().map((call) => (call.args[0] as object).constructor.name);
    expect(commandNames.length).toBeGreaterThan(0);
    expect(commandNames.filter((name) => name.includes('Scan'))).toEqual([]);
    // Every partition key the adapter ever names is the derived User_Id or the reserved
    // pending-deletion partition — never a request-supplied one.
    for (const call of ddb.commandCalls(QueryCommand)) {
      const uid = call.args[0].input.ExpressionAttributeValues?.[':uid'] as { S?: string };
      expect([OWNER, PENDING_DELETION_PARTITION]).toContain(uid.S);
    }
  });
});
