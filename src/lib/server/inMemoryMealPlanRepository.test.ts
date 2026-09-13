/**
 * Smoke tests for the in-memory Meal_Plan_Store.
 *
 * These cover the semantics the model-based properties depend on being real rather than
 * stubbed: the record cap, the acknowledgment gate, newest-first ordering with the ULID
 * tie-break, strictly-exclusive cursor advance, the create and update conditions,
 * idempotent delete, partition confinement, and the pending-deletion partition. The
 * exhaustive versions live in the property tests.
 */

import { describe, expect, it } from 'vitest';

import { newMealPlanId } from '../mealPlanId';
import type { MealPlanRecord } from '../types';
import {
  createInMemoryMealPlanRepository,
  type InMemoryMealPlanRepository,
} from './inMemoryMealPlanRepository';
import { MEAL_PLAN_RECORD_CAP, PENDING_DELETION_PARTITION } from './mealPlanRepository';

const ACK = '2025-03-01T00:00:00.000Z';
const BASE_MS = Date.parse('2025-03-14T09:12:33.481Z');

/** A valid record whose id carries `createdAtMs`, as the serializer requires. */
function makeRecord(
  userId: string,
  createdAtMs: number,
  overrides: Partial<MealPlanRecord> = {}
): MealPlanRecord {
  const createdAt = new Date(createdAtMs).toISOString();
  return {
    userId,
    mealPlanId: newMealPlanId(createdAtMs),
    title: 'Low-fiber week',
    createdAt,
    updatedAt: createdAt,
    content: {
      meals: [{ mealName: 'Breakfast', items: [{ name: 'Scrambled eggs', portion: '2 eggs' }] }],
      summary: 'Gentle low-residue day.',
    },
    ...overrides,
  };
}

/** A repository with a clock the test drives and the real ULID generator. */
function makeRepository(): { repo: InMemoryMealPlanRepository; setNow: (ms: number) => void } {
  let nowMs = BASE_MS;
  const repo = createInMemoryMealPlanRepository({
    now: () => nowMs,
    newMealPlanId: () => newMealPlanId(nowMs),
  });
  return { repo, setNow: (ms) => { nowMs = ms; } };
}

describe('storage acknowledgment gate', () => {
  it('writes nothing for a first save carrying no acknowledgment', async () => {
    const { repo } = makeRepository();
    const record = makeRecord('user-a', BASE_MS);

    const outcome = await repo.create('user-a', record, false);

    expect(outcome).toStrictEqual({ kind: 'ack-required' });
    expect(await repo.get('user-a', record.mealPlanId)).toBeNull();
    expect(repo.snapshotPartition('user-a')).toBe('[]');
  });

  it('requires the acknowledgment only once per Account', async () => {
    const { repo } = makeRepository();
    const first = makeRecord('user-a', BASE_MS);
    const second = makeRecord('user-a', BASE_MS + 1);

    expect(await repo.create('user-a', first, true)).toStrictEqual({
      kind: 'created',
      mealPlanId: first.mealPlanId,
    });
    expect(await repo.create('user-a', second, false)).toStrictEqual({
      kind: 'created',
      mealPlanId: second.mealPlanId,
    });
  });
});

describe('create conditions and the record cap', () => {
  it('rejects a save beyond the cap without touching stored records', async () => {
    const { repo } = makeRepository();
    // The cap gate reads the counter on the `#meta` item, so an Account can be placed at
    // the cap without materializing 100 records.
    repo.seed([{ userId: 'user-a', planCount: MEAL_PLAN_RECORD_CAP, storageAckAt: ACK }]);
    const before = repo.snapshotPartition('user-a');

    const outcome = await repo.create('user-a', makeRecord('user-a', BASE_MS), true);

    expect(outcome).toStrictEqual({ kind: 'cap-reached' });
    expect(repo.snapshotPartition('user-a')).toBe(before);
  });

  it('leaves one record and the original values when an identical create repeats', async () => {
    const { repo } = makeRepository();
    const record = makeRecord('user-a', BASE_MS);

    await repo.create('user-a', record, true);
    const resubmitted = await repo.create(
      'user-a',
      { ...record, title: 'Renamed by a retry' },
      true
    );

    expect(resubmitted).toStrictEqual({ kind: 'created', mealPlanId: record.mealPlanId });
    expect((await repo.listAll('user-a')).map((r) => r.title)).toStrictEqual(['Low-fiber week']);
  });

  it('stores under the derived User_Id even when the record claims another owner', async () => {
    const { repo } = makeRepository();
    const record = makeRecord('user-b', BASE_MS);

    await repo.create('user-a', record, true);

    expect((await repo.get('user-a', record.mealPlanId))?.userId).toBe('user-a');
    expect(await repo.get('user-b', record.mealPlanId)).toBeNull();
  });
});

describe('update and rename conditions', () => {
  it('preserves the id and creation timestamp, and reports not-found for an absent record', async () => {
    const { repo } = makeRepository();
    const record = makeRecord('user-a', BASE_MS);
    await repo.create('user-a', record, true);

    const updated = await repo.update('user-a', {
      ...record,
      createdAt: '2001-01-01T00:00:00.000Z', // a supplied value must not move it
      updatedAt: new Date(BASE_MS + 5_000).toISOString(),
      content: { meals: record.content.meals, summary: 'Revised.' },
    });
    const stored = await repo.get('user-a', record.mealPlanId);

    expect(updated).toStrictEqual({ kind: 'updated' });
    expect(stored?.createdAt).toBe(record.createdAt);
    expect(stored?.mealPlanId).toBe(record.mealPlanId);
    expect(stored?.content.summary).toBe('Revised.');

    expect(await repo.update('user-a', makeRecord('user-a', BASE_MS + 1))).toStrictEqual({
      kind: 'not-found',
    });
  });

  it('changes only the title and updatedAt on rename', async () => {
    const { repo } = makeRepository();
    const record = makeRecord('user-a', BASE_MS);
    await repo.create('user-a', record, true);

    const renamed = await repo.rename('user-a', record.mealPlanId, 'Flare week', BASE_MS + 1_000);
    const stored = await repo.get('user-a', record.mealPlanId);

    expect(renamed).toStrictEqual({ kind: 'updated' });
    expect(stored?.title).toBe('Flare week');
    expect(stored?.updatedAt).toBe(new Date(BASE_MS + 1_000).toISOString());
    expect(stored?.content).toStrictEqual(record.content);
    expect(await repo.rename('user-a', 'MISSING', 'x', BASE_MS)).toStrictEqual({
      kind: 'not-found',
    });
  });
});

describe('listing, ordering, and cursors', () => {
  it('returns records newest first, excludes #meta, and paginates without gaps', async () => {
    const { repo } = makeRepository();
    // 21 records over 3 distinct milliseconds, so several share a creation timestamp and
    // the id tie-break is exercised.
    const records = Array.from({ length: 21 }, (_, i) =>
      makeRecord('user-a', BASE_MS + (i % 3))
    );
    repo.seed([{ userId: 'user-a', records, storageAckAt: ACK }]);

    const first = await repo.list('user-a');
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).toBeDefined();

    const second = await repo.list('user-a', first.nextCursor);
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();

    const ids = [...first.items, ...second.items].map((s) => s.mealPlanId);
    expect(new Set(ids).size).toBe(21);
    expect(ids).toStrictEqual([...ids].sort().reverse());
    expect(ids).not.toContain('#meta');
  });

  it('emits a cursor for a page filled to the limit, then an empty final page', async () => {
    const { repo } = makeRepository();
    const records = Array.from({ length: 20 }, (_, i) => makeRecord('user-a', BASE_MS + i));
    repo.seed([{ userId: 'user-a', records, storageAckAt: ACK }]);

    const first = await repo.list('user-a');
    expect(first.nextCursor).toBeDefined();

    // DynamoDB returns a LastEvaluatedKey whenever Limit stopped the query, so the final
    // page of an Account holding exactly 20 records is an empty one.
    const second = await repo.list('user-a', first.nextCursor);
    expect(second.items).toStrictEqual([]);
    expect(second.nextCursor).toBeUndefined();
  });

  it('rejects a cursor that is not a valid continuation token', async () => {
    const { repo } = makeRepository();
    await expect(repo.list('user-a', 'not-a-cursor')).rejects.toThrow(RangeError);
  });
});

describe('delete and purge', () => {
  it('is idempotent and leaves the Account\u2019s other records untouched', async () => {
    const { repo } = makeRepository();
    const kept = makeRecord('user-a', BASE_MS);
    const removed = makeRecord('user-a', BASE_MS + 1);
    repo.seed([{ userId: 'user-a', records: [kept, removed], storageAckAt: ACK }]);

    await repo.delete('user-a', removed.mealPlanId);
    const afterFirst = repo.snapshotPartition('user-a');
    await repo.delete('user-a', removed.mealPlanId);

    expect(repo.snapshotPartition('user-a')).toBe(afterFirst);
    expect((await repo.listAll('user-a')).map((r) => r.mealPlanId)).toStrictEqual([
      kept.mealPlanId,
    ]);
  });

  it('frees cap headroom as records are deleted', async () => {
    const { repo } = makeRepository();
    const records = Array.from({ length: MEAL_PLAN_RECORD_CAP }, (_, i) =>
      makeRecord('user-a', BASE_MS + i)
    );
    repo.seed([{ userId: 'user-a', records, storageAckAt: ACK }]);
    const fresh = makeRecord('user-a', BASE_MS + 1_000);

    expect(await repo.create('user-a', fresh, true)).toStrictEqual({ kind: 'cap-reached' });
    await repo.delete('user-a', records[0].mealPlanId);

    expect(await repo.create('user-a', fresh, true)).toStrictEqual({
      kind: 'created',
      mealPlanId: fresh.mealPlanId,
    });
  });

  it('removes every record for one Account and leaves other Accounts unchanged', async () => {
    const { repo } = makeRepository();
    const mine = [makeRecord('user-a', BASE_MS), makeRecord('user-a', BASE_MS + 1)];
    const theirs = [makeRecord('user-b', BASE_MS)];
    repo.seed([
      { userId: 'user-a', records: mine, storageAckAt: ACK },
      { userId: 'user-b', records: theirs, storageAckAt: ACK },
    ]);
    const otherBefore = repo.snapshotPartition('user-b');

    const outcome = await repo.purge('user-a');

    expect(outcome).toStrictEqual({ deletedCount: 2, remaining: 0 });
    expect(repo.snapshotPartition('user-a')).toBe('[]');
    expect(repo.snapshotPartition('user-b')).toBe(otherBefore);
  });
});

describe('pending-deletion partition', () => {
  it('enqueues idempotently, lists the due entries, and clears through delete', async () => {
    const { repo, setNow } = makeRepository();
    setNow(BASE_MS);

    await repo.enqueuePendingDeletion('user-a');
    await repo.enqueuePendingDeletion('user-a');
    const listed = await repo.listPendingDeletions(BASE_MS);

    expect(listed).toStrictEqual([
      {
        userId: 'user-a',
        attempts: 0,
        enqueuedAt: new Date(BASE_MS).toISOString(),
        nextAttemptAt: new Date(BASE_MS).toISOString(),
      },
    ]);

    // The sweep clears an entry with the same key-scoped delete every other caller uses.
    await repo.delete(PENDING_DELETION_PARTITION, 'user-a');
    expect(await repo.listPendingDeletions(BASE_MS)).toStrictEqual([]);
  });
});

describe('operation ledger', () => {
  it('records every attempt with its partition key, rejected writes included', async () => {
    const { repo } = makeRepository();
    const record = makeRecord('user-a', BASE_MS);

    await repo.create('user-a', record, false); // rejected by the ack gate
    await repo.get('user-a', record.mealPlanId);

    expect(repo.calls).toStrictEqual([
      { op: 'create', access: 'write', userId: 'user-a', mealPlanId: record.mealPlanId },
      { op: 'get', access: 'read', userId: 'user-a', mealPlanId: record.mealPlanId },
    ]);
    expect(repo.calls.every((call) => call.userId.length > 0)).toBe(true);
  });
});
