/**
 * Unit tests for the pending-deletion sweep (Requirement 11.7).
 *
 * The store is the in-memory repository, which reimplements the pending-deletion partition
 * and the key-scoped delete rather than stubbing them, so what these tests observe about
 * partition confinement is a statement about production too. Property 21 covers bounded
 * retry and convergence exhaustively; these cover the credential surface, the counts, and
 * idempotency by example.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { newMealPlanId } from '../mealPlanId';
import type { MealPlanRecord } from '../types';
import { CREDENTIAL_ERROR_BODY } from './apiErrors';
import {
  createInMemoryMealPlanRepository,
  type InMemoryMealPlanRepository,
} from './inMemoryMealPlanRepository';
import { PENDING_DELETION_PARTITION, type MealPlanRepository } from './mealPlanRepository';
import {
  SWEEP_PURGE_ATTEMPTS,
  handleSweepRequest,
  isAuthorizedSweepRequest,
} from './pendingDeletionSweep';

const SECRET = 'cron-secret-value-long-enough-to-matter';
const BASE_MS = Date.parse('2025-04-02T03:00:00.000Z');

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', SECRET);
});

/** A valid record whose id carries `createdAtMs`, as the serializer requires. */
function makeRecord(userId: string, createdAtMs: number): MealPlanRecord {
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
  };
}

function makeRepository(): InMemoryMealPlanRepository {
  return createInMemoryMealPlanRepository({
    now: () => BASE_MS,
    newMealPlanId: () => newMealPlanId(BASE_MS),
  });
}

function depsFor(repository: MealPlanRepository) {
  return { repository, now: () => BASE_MS };
}

function sweepRequest(authorization?: string): Request {
  return new Request('https://example.test/api/internal/pending-deletion-sweep', {
    method: 'POST',
    ...(authorization === undefined ? {} : { headers: { Authorization: authorization } }),
  });
}

describe('cron credential', () => {
  it('rejects a request with no Authorization header with the frozen 401 body', async () => {
    const repo = makeRepository();

    const response = await handleSweepRequest(sweepRequest(), depsFor(repo));

    expect(response.status).toBe(401);
    expect(await response.json()).toStrictEqual(CREDENTIAL_ERROR_BODY);
    // The store is not reached at all for an unauthenticated caller.
    expect(repo.calls).toStrictEqual([]);
  });

  it.each([
    ['a wrong secret', 'Bearer not-the-secret'],
    ['a prefix of the secret', `Bearer ${SECRET.slice(0, -1)}`],
    ['the secret with trailing input', `Bearer ${SECRET}x`],
    ['the bare secret with no scheme', SECRET],
    ['a differently cased scheme', `bearer ${SECRET}`],
  ])('rejects %s', async (_label, header) => {
    const repo = makeRepository();

    const response = await handleSweepRequest(sweepRequest(header), depsFor(repo));

    expect(response.status).toBe(401);
    expect(repo.calls).toStrictEqual([]);
  });

  it('authorizes nothing when CRON_SECRET is absent or empty', async () => {
    vi.stubEnv('CRON_SECRET', '');
    expect(isAuthorizedSweepRequest(sweepRequest('Bearer '))).toBe(false);

    vi.stubEnv('CRON_SECRET', undefined);
    expect(isAuthorizedSweepRequest(sweepRequest('Bearer '))).toBe(false);
    expect(isAuthorizedSweepRequest(sweepRequest('Bearer undefined'))).toBe(false);
  });

  it('accepts the configured bearer secret', async () => {
    const repo = makeRepository();

    const response = await handleSweepRequest(sweepRequest(`Bearer ${SECRET}`), depsFor(repo));

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ processed: 0, cleared: 0, stillPending: 0 });
  });
});

describe('sweeping the pending-deletion list', () => {
  it('purges each listed User_Id, clears its entry, and reports the counts', async () => {
    const repo = makeRepository();
    repo.seed([
      { userId: 'user-a', records: [makeRecord('user-a', BASE_MS)] },
      { userId: 'user-b', records: [makeRecord('user-b', BASE_MS + 1)] },
    ]);
    await repo.enqueuePendingDeletion('user-a');
    await repo.enqueuePendingDeletion('user-b');

    const response = await handleSweepRequest(sweepRequest(`Bearer ${SECRET}`), depsFor(repo));

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ processed: 2, cleared: 2, stillPending: 0 });
    expect(await repo.listPendingDeletions(BASE_MS)).toStrictEqual([]);
    expect(repo.snapshotPartition('user-a')).toBe('[]');
    expect(repo.snapshotPartition('user-b')).toBe('[]');
  });

  it('takes no User_Id from the request and touches only listed partitions', async () => {
    const repo = makeRepository();
    repo.seed([
      { userId: 'user-a', records: [makeRecord('user-a', BASE_MS)] },
      { userId: 'bystander', records: [makeRecord('bystander', BASE_MS + 2)] },
    ]);
    await repo.enqueuePendingDeletion('user-a');
    const bystanderBefore = repo.snapshotPartition('bystander');
    repo.clearCalls();

    const request = new Request(
      'https://example.test/api/internal/pending-deletion-sweep?userId=bystander',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'bystander' }),
      }
    );

    const response = await handleSweepRequest(request, depsFor(repo));

    expect(await response.json()).toStrictEqual({ processed: 1, cleared: 1, stillPending: 0 });
    // Every partition reached is either the reserved one or a User_Id read from it.
    expect(
      repo.calls.every(
        (call) => call.userId === PENDING_DELETION_PARTITION || call.userId === 'user-a'
      )
    ).toBe(true);
    expect(repo.snapshotPartition('bystander')).toBe(bystanderBefore);
  });

  it('leaves an entry in place, boundedly retried, while records remain', async () => {
    const repo = makeRepository();
    repo.seed([{ userId: 'user-a', records: [makeRecord('user-a', BASE_MS)] }]);
    await repo.enqueuePendingDeletion('user-a');

    // A store that keeps reporting a survivor, as a throttled BatchWriteItem does.
    let purgeCalls = 0;
    const stalling: MealPlanRepository = {
      ...repo,
      purge: async () => {
        purgeCalls += 1;
        return { deletedCount: 0, remaining: 1 };
      },
    };

    const response = await handleSweepRequest(sweepRequest(`Bearer ${SECRET}`), depsFor(stalling));

    expect(await response.json()).toStrictEqual({ processed: 1, cleared: 0, stillPending: 1 });
    expect(purgeCalls).toBe(SWEEP_PURGE_ATTEMPTS);
    expect((await repo.listPendingDeletions(BASE_MS)).map((entry) => entry.userId)).toStrictEqual([
      'user-a',
    ]);
  });

  it('clears the entry when a retry within the run succeeds', async () => {
    const repo = makeRepository();
    repo.seed([{ userId: 'user-a', records: [makeRecord('user-a', BASE_MS)] }]);
    await repo.enqueuePendingDeletion('user-a');

    let attempt = 0;
    const flaky: MealPlanRepository = {
      ...repo,
      purge: async (userId) => {
        attempt += 1;
        if (attempt === 1) throw new Error('ProvisionedThroughputExceededException');
        return repo.purge(userId);
      },
    };

    const response = await handleSweepRequest(sweepRequest(`Bearer ${SECRET}`), depsFor(flaky));

    expect(await response.json()).toStrictEqual({ processed: 1, cleared: 1, stillPending: 0 });
    expect(await repo.listPendingDeletions(BASE_MS)).toStrictEqual([]);
  });

  it('reaches the same end state on a second run over the same list', async () => {
    const repo = makeRepository();
    repo.seed([{ userId: 'user-a', records: [makeRecord('user-a', BASE_MS)] }]);
    await repo.enqueuePendingDeletion('user-a');

    await handleSweepRequest(sweepRequest(`Bearer ${SECRET}`), depsFor(repo));
    const afterFirst = repo.snapshot();

    const second = await handleSweepRequest(sweepRequest(`Bearer ${SECRET}`), depsFor(repo));

    expect(await second.json()).toStrictEqual({ processed: 0, cleared: 0, stillPending: 0 });
    expect(repo.snapshot()).toBe(afterFirst);
  });

  it('reports 503 when the pending-deletion list cannot be read, leaving entries in place', async () => {
    const repo = makeRepository();
    await repo.enqueuePendingDeletion('user-a');
    const before = repo.snapshot();

    const unreachable: MealPlanRepository = {
      ...repo,
      listPendingDeletions: async () => {
        throw new Error('ServiceUnavailable');
      },
    };

    const response = await handleSweepRequest(sweepRequest(`Bearer ${SECRET}`), depsFor(unreachable));

    expect(response.status).toBe(503);
    expect(repo.snapshot()).toBe(before);
  });
});
