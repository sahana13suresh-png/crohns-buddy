/**
 * Unit tests for `POST /api/account/purge` (Requirements 11.3, 11.7, 11.9).
 *
 * What these pin down is the ordering contract the browser half of the
 * Account_Deletion_Flow relies on: a `200` says how far the purge got, and only
 * a `200` permits the client to remove the Account. A `500` leaves everything —
 * the Account, the remaining records, the Session — untouched.
 *
 * The handler module is imported rather than `route.ts`, which asserts its
 * credential groups at module scope. No credential is needed here: every test
 * injects a repository, so the DynamoDB adapter is never constructed.
 */

import { describe, expect, it, vi } from 'vitest';

import { DELETION_INCOMPLETE_BODY, CREDENTIAL_ERROR_BODY } from '@/lib/server/apiErrors';
import type { AuthTokenVerifier, VerifiedIdentity, VerifyResult } from '@/lib/server/authTokenVerifier';
import {
  createInMemoryMealPlanRepository,
  type InMemoryMealPlanRepository,
} from '@/lib/server/inMemoryMealPlanRepository';
import type { MealPlanRepository } from '@/lib/server/mealPlanRepository';
import { newMealPlanId } from '@/lib/mealPlanId';
import type { MealPlanRecord } from '@/lib/types';
import { PURGE_ATTEMPTS, PURGE_BUDGET_MS, createPurgeRoute } from './accountPurge';

const BASE_MS = Date.parse('2025-03-14T09:12:33.481Z');
const ACK = '2025-03-01T00:00:00.000Z';

const IDENTITY: VerifiedIdentity = {
  userId: 'user-a',
  authTimeMs: BASE_MS,
  email: 'patient@example.com',
  displayName: 'Patient',
};

function verifierReturning(result: VerifyResult): AuthTokenVerifier {
  return { verifyAuthToken: vi.fn(async () => result) };
}

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

function seededRepository(): InMemoryMealPlanRepository {
  const repo = createInMemoryMealPlanRepository({
    now: () => BASE_MS,
    newMealPlanId: () => newMealPlanId(BASE_MS),
  });
  repo.seed([
    {
      userId: 'user-a',
      storageAckAt: ACK,
      records: [makeRecord('user-a', BASE_MS), makeRecord('user-a', BASE_MS + 1)],
    },
    { userId: 'user-b', storageAckAt: ACK, records: [makeRecord('user-b', BASE_MS + 2)] },
  ]);
  return repo;
}

function purgeRequest(): Request {
  return new Request('https://example.com/api/account/purge', { method: 'POST' });
}

describe('POST /api/account/purge', () => {
  it('removes every record for the derived User_Id and leaves other Accounts intact', async () => {
    const repo = seededRepository();
    const otherBefore = repo.snapshotPartition('user-b');

    const response = await createPurgeRoute({
      repository: repo,
      verifier: verifierReturning({ ok: true, identity: IDENTITY }),
      now: () => BASE_MS,
    })(purgeRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({
      deletedCount: 2,
      remaining: 0,
      pendingDeletion: false,
    });
    expect(repo.snapshotPartition('user-a')).toBe('[]');
    expect(repo.snapshotPartition('user-b')).toBe(otherBefore);
    // The purge is complete, so nothing is left for the sweep to pick up.
    expect(await repo.listPendingDeletions(BASE_MS)).toStrictEqual([]);
  });

  it('purges the derived User_Id even when the request supplies another one', async () => {
    const repo = seededRepository();

    const response = await createPurgeRoute({
      repository: repo,
      verifier: verifierReturning({ ok: true, identity: IDENTITY }),
      now: () => BASE_MS,
    })(
      new Request('https://example.com/api/account/purge?userId=user-b', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'user-b' }),
      }),
    );

    expect(response.status).toBe(200);
    expect(repo.snapshotPartition('user-a')).toBe('[]');
    expect(repo.calls.every((call) => call.userId !== 'user-b')).toBe(true);
  });

  it('enqueues a pending deletion and reports it when records remain after the retries', async () => {
    const enqueued: string[] = [];
    const repository = {
      purge: vi.fn(async () => ({ deletedCount: 1, remaining: 2 })),
      enqueuePendingDeletion: vi.fn(async (userId: string) => {
        enqueued.push(userId);
      }),
    } as unknown as MealPlanRepository;

    const response = await createPurgeRoute({
      repository,
      verifier: verifierReturning({ ok: true, identity: IDENTITY }),
      now: () => BASE_MS,
    })(purgeRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({
      // One attempt's worth of deletions per attempt, all three attempts spent.
      deletedCount: PURGE_ATTEMPTS,
      remaining: 2,
      pendingDeletion: true,
    });
    expect(repository.purge).toHaveBeenCalledTimes(PURGE_ATTEMPTS);
    expect(enqueued).toStrictEqual(['user-a']);
  });

  it('stops retrying once the 60-second budget is spent', async () => {
    const repository = {
      purge: vi.fn(async () => ({ deletedCount: 0, remaining: 1 })),
      enqueuePendingDeletion: vi.fn(async () => {}),
    } as unknown as MealPlanRepository;

    // First reading opens the budget; the second is already past its deadline,
    // so the first attempt is also the last.
    let call = 0;
    const now = (): number => {
      call += 1;
      return call === 1 ? BASE_MS : BASE_MS + PURGE_BUDGET_MS + 1;
    };

    const response = await createPurgeRoute({
      repository,
      verifier: verifierReturning({ ok: true, identity: IDENTITY }),
      now,
    })(purgeRequest());

    expect(response.status).toBe(200);
    expect(repository.purge).toHaveBeenCalledTimes(1);
    expect(await response.json()).toStrictEqual({
      deletedCount: 0,
      remaining: 1,
      pendingDeletion: true,
    });
  });

  it('returns 500 with restart guidance and removes nothing further when the purge fails', async () => {
    const repo = seededRepository();
    const before = repo.snapshot();
    // The real store, with a purge that fails before removing anything — the
    // position Requirement 11.9 describes.
    const repository: MealPlanRepository = {
      ...repo,
      purge: vi.fn(async () => {
        throw new Error('store unreachable');
      }),
      enqueuePendingDeletion: vi.fn(async () => {}),
    };

    const response = await createPurgeRoute({
      repository,
      verifier: verifierReturning({ ok: true, identity: IDENTITY }),
      now: () => BASE_MS,
    })(purgeRequest());

    expect(response.status).toBe(500);
    expect(await response.json()).toStrictEqual(DELETION_INCOMPLETE_BODY);
    // Requirement 11.9: every remaining record is left as it was, and no
    // pending-deletion entry is written for an Account that still exists.
    expect(repo.snapshot()).toBe(before);
    expect(repository.enqueuePendingDeletion).not.toHaveBeenCalled();
  });

  it('returns 500 when the remainder cannot be recorded for the sweep', async () => {
    const repository = {
      purge: vi.fn(async () => ({ deletedCount: 4, remaining: 1 })),
      enqueuePendingDeletion: vi.fn(async () => {
        throw new Error('store unreachable');
      }),
    } as unknown as MealPlanRepository;

    const response = await createPurgeRoute({
      repository,
      verifier: verifierReturning({ ok: true, identity: IDENTITY }),
      now: () => BASE_MS,
    })(purgeRequest());

    // A 200 here would tell the client to remove the Account while records
    // remain with nothing scheduled to remove them.
    expect(response.status).toBe(500);
    expect(await response.json()).toStrictEqual(DELETION_INCOMPLETE_BODY);
  });

  it('returns the frozen 401 and touches no store when the credential is unusable', async () => {
    const repo = seededRepository();
    const before = repo.snapshot();

    const response = await createPurgeRoute({
      repository: repo,
      verifier: verifierReturning({ ok: false, kind: 'invalid' }),
      now: () => BASE_MS,
    })(purgeRequest());

    expect(response.status).toBe(401);
    expect(await response.json()).toStrictEqual(CREDENTIAL_ERROR_BODY);
    expect(repo.calls).toStrictEqual([]);
    expect(repo.snapshot()).toBe(before);
  });

  it('requests a fresh revocation check before removing anything', async () => {
    const verifier = verifierReturning({ ok: true, identity: IDENTITY });

    await createPurgeRoute({
      repository: seededRepository(),
      verifier,
      now: () => BASE_MS,
    })(purgeRequest());

    expect(verifier.verifyAuthToken).toHaveBeenCalledWith(expect.any(Request), {
      requireFreshRevocationCheck: true,
    });
  });
});
