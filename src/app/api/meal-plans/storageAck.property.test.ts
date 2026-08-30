/**
 * Property-based test for the storage-acknowledgment gate on `POST /api/meal-plans`.
 *
 * The save handler is driven for real — `withAuth` in front of
 * `createSaveMealPlanHandler`, over the in-memory Meal_Plan_Store — because the gate is
 * not one branch in one place. It is a condition inside the store's write transaction plus
 * the 428 mapping in the route, and the claim being checked is about the two together:
 * nothing is written unless the acknowledgment is already recorded for that Account or the
 * request carries it.
 *
 * Only the Auth_Token verifier is stubbed. That boundary is deliberate: the acknowledgment
 * is recorded against the *derived* User_Id, so the property needs to choose which Account
 * is calling, and it does that by choosing what the verifier returns. Everything else runs
 * — title normalization, the serializer's bounds, the size check, the `#meta` transaction.
 *
 * Three things are asserted, matching the three clauses of Property 14:
 *
 * 1. **The gate.** A save on an Account holding no `storageAckAt` and carrying no
 *    acknowledgment answers 428 with the frozen `STORAGE_ACK_REQUIRED` body and leaves the
 *    Account's partition byte-for-byte unchanged — no record, and no counter movement
 *    either (Requirements 12.3, 12.5).
 * 2. **At most once per Account.** Once an acknowledged save succeeds, no later save by
 *    that Account answers 428, including saves that carry no `acknowledgeStorage` field at
 *    all. An absent field is how a browser that has discarded every trace of the
 *    acknowledgment presents itself, so those draws are the "after browser-held state is
 *    discarded" clause rather than a separate scenario (Requirement 12.4).
 * 3. **Per-Account.** One Account's acknowledgment does not satisfy another's: a second
 *    Account's first unacknowledged save still answers 428 with nothing written.
 *
 * "Nothing written" is checked by comparing the partition snapshot before and after, not by
 * counting records. A rolled-back transaction that nonetheless bumped `planCount` would
 * pass a record count and fail the snapshot, which is the failure worth catching.
 */

import fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';

import { newMealPlanId } from '@/lib/mealPlanId';
import {
  MAX_SERIALIZED_BYTES,
  serializeMealPlanRecord,
  serializedByteLength,
} from '@/lib/mealPlanSerializer';
import type { MealPlanRecord } from '@/lib/types';
import { STORAGE_ACK_REQUIRED_BODY } from '@/lib/server/apiErrors';
import type { AuthTokenVerifier, VerifiedIdentity } from '@/lib/server/authTokenVerifier';
import {
  createInMemoryMealPlanRepository,
  type InMemoryMealPlanRepository,
} from '@/lib/server/inMemoryMealPlanRepository';
import { createSaveMealPlanHandler } from '@/lib/server/mealPlansRouteHandlers';
import { withAuth } from '@/lib/server/withAuth';
import { arbMealPlanRecord } from '@/test/arbitraries';

// ─── Fixture ───────────────────────────────────────────────────────────────────

/** The exact bytes a gated save is allowed to answer with (Requirements 12.3, 12.5). */
const ACK_REQUIRED_BYTES = JSON.stringify(STORAGE_ACK_REQUIRED_BODY);

/** Base instant for the injected clock. Each request advances it, so ids differ. */
const BASE_MS = Date.parse('2025-04-01T08:00:00.000Z');

let store: InMemoryMealPlanRepository;
let clockMs: number;

/**
 * Fresh state for one property run.
 *
 * `beforeEach` below is not sufficient on its own: fast-check executes the predicate many
 * times — once per run, then again for every shrink attempt — inside a single `it`, so a
 * store built once per test carries one run's recorded acknowledgment into the next. The
 * model each run starts from is "this Account has never acknowledged", so an inherited
 * `storageAckAt` makes a first `absent` save answer 201 where the run expects 428. That is
 * the property's own bookkeeping leaking, not the gate misbehaving, so the store is rebuilt
 * per run via the property's `beforeEach` hook as well.
 */
function freshStore(): void {
  clockMs = BASE_MS;
  store = createInMemoryMealPlanRepository({
    now: () => clockMs,
    newMealPlanId: () => newMealPlanId(clockMs),
  });
}

beforeEach(freshStore);

/** The route's collaborators, resolved per request exactly as production resolves them. */
function deps() {
  return {
    repository: store,
    now: () => clockMs,
    newMealPlanId: (ms: number) => newMealPlanId(ms),
  };
}

/** A verifier that derives `userId`, which is what decides whose acknowledgment applies. */
function verifierFor(userId: string): AuthTokenVerifier {
  const identity: VerifiedIdentity = {
    userId,
    authTimeMs: BASE_MS - 60_000,
    email: 'patient@example.com',
    displayName: 'Patient',
  };
  return { verifyAuthToken: async () => ({ ok: true, identity }) };
}

// ─── Staying inside the gate's input space ─────────────────────────────────────

/** Serialized size of a record, the quantity the route's 100 kilobyte check measures. */
function serializedBytesOf(record: MealPlanRecord): number {
  return serializedByteLength(serializeMealPlanRecord(record));
}

/**
 * Shrinks a drawn record until its serialized form fits under the 100 kilobyte ceiling.
 *
 * `arbMealPlanRecord()` is biased toward the boundaries of every bound in Requirement 9.7,
 * so a sizeable share of its draws — 10 meals of 20 items with maximum-length notes — are
 * over that ceiling. Those draws are answered 413 by the save handler before the store is
 * called at all, which is Requirement 5.7 working correctly and is what Property 12 checks.
 * They say nothing about the acknowledgment gate, so this mapping keeps them out of the
 * input space instead of letting them masquerade as gate failures.
 *
 * Halving rather than truncating to a fixed shape keeps large-but-legal plans in play.
 */
function fitToSizeCeiling(record: MealPlanRecord): MealPlanRecord {
  let candidate = record;

  while (serializedBytesOf(candidate) > MAX_SERIALIZED_BYTES) {
    const meals = candidate.content.meals;

    if (meals.length > 1) {
      candidate = {
        ...candidate,
        content: { ...candidate.content, meals: meals.slice(0, Math.ceil(meals.length / 2)) },
      };
      continue;
    }

    const items = meals[0].items;
    if (items.length > 1) {
      candidate = {
        ...candidate,
        content: {
          ...candidate.content,
          meals: [{ ...meals[0], items: items.slice(0, Math.ceil(items.length / 2)) }],
        },
      };
      continue;
    }

    if (candidate.content.warnings !== undefined) {
      const { warnings: _dropped, ...rest } = candidate.content;
      candidate = { ...candidate, content: rest };
      continue;
    }

    // Unreachable: a single one-item meal with no warnings maxes out around 67 kilobytes
    // even with four-byte code points throughout. Thrown rather than looped forever so a
    // future change to the bounds surfaces here instead of hanging the suite.
    throw new RangeError('fitToSizeCeiling: a minimal plan exceeded the size ceiling');
  }

  return candidate;
}

/** A record the save handler will not reject for size, so only the gate can reject it. */
function arbSaveablePlan(): fc.Arbitrary<MealPlanRecord> {
  return arbMealPlanRecord().map(fitToSizeCeiling);
}

/**
 * How a save request presents the acknowledgment.
 *
 * `absent` is not the same draw as `false` with respect to what it models: `false` is a
 * Patient who saw the notice and declined it, while `absent` is a client with no notion of
 * the notice at all — a fresh browser, or one whose stored state was cleared. Both must be
 * gated before an acknowledgment is recorded, and both must succeed after one is.
 */
type AckFlag = 'absent' | 'false' | 'true';

const ACK_FLAGS: readonly AckFlag[] = ['absent', 'false', 'true'];

/** The save body. Only `title` and `mealPlan` come from the drawn record. */
function saveBody(record: MealPlanRecord, ack: AckFlag): Record<string, unknown> {
  const body: Record<string, unknown> = { title: record.title, mealPlan: record.content };
  if (ack === 'true') body.acknowledgeStorage = true;
  if (ack === 'false') body.acknowledgeStorage = false;
  return body;
}

/**
 * Sends one save request as `userId`.
 *
 * The wrapper and the handler are built per call, so a request cannot inherit anything from
 * the one before it — no cached identity, no cached deps. The only thing carried across
 * requests is the store, which is the point.
 */
async function save(
  userId: string,
  record: MealPlanRecord,
  ack: AckFlag,
): Promise<{ status: number; body: string }> {
  clockMs += 1;
  const route = withAuth(createSaveMealPlanHandler(deps), {
    verifier: verifierFor(userId),
    freshRevocationCheck: true,
  });

  const response = await route(
    new Request('https://crohns-buddy.test/api/meal-plans', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer token' },
      body: JSON.stringify(saveBody(record, ack)),
    }),
  );

  return { status: response.status, body: await response.text() };
}

/** How many Meal_Plan_Records the Account holds. */
async function recordCount(userId: string): Promise<number> {
  return (await store.listAll(userId)).length;
}

// ─── Property 14 ───────────────────────────────────────────────────────────────

/**
 * **Property 14: No record is written before the storage notice is acknowledged, and the
 * notice appears at most once per Account**
 *
 * *For any* Meal_Plan and any prior acknowledgment state of an Account, the Meal_Plan_API
 * writes a Meal_Plan_Record if and only if that Account already holds a recorded
 * acknowledgment or the request carries one, and *for any* sequence of save requests by one
 * Account the storage notice is required at most once across the whole sequence, including
 * after all browser-held state for that Account is discarded.
 *
 * **Validates: Requirements 12.3, 12.4, 12.5**
 */
describe('Property 14: the storage notice gates the first write and appears at most once per Account', () => {
  it('writes exactly when the acknowledgment is recorded or carried, and never asks twice', async () => {
    /** Every status observed, so a vacuous run is visible. */
    const observedStatuses = new Set<number>();
    /** Every acknowledgment presentation drawn. */
    const observedFlags = new Set<AckFlag>();
    /** Whether a post-acknowledgment save carrying no field at all was exercised. */
    let sawSaveAfterStateDiscarded = false;
    /** Whether the cross-Account clause was exercised. */
    let sawForeignAccountGated = false;

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(arbSaveablePlan(), fc.constantFrom(...ACK_FLAGS)), {
          minLength: 1,
          maxLength: 3,
        }),
        arbSaveablePlan(),
        async (sequence, foreignPlan) => {
          // The Account issuing the sequence, and a second one that never acknowledges.
          // Both User_Ids come from generated records, so both satisfy the serializer's
          // partition-key bound without this test inventing its own charset.
          const userId = sequence[0][0].userId;
          const foreignUserId =
            foreignPlan.userId === userId ? `${foreignPlan.userId}z` : foreignPlan.userId;

          // The model: has this Account had an acknowledgment recorded against it yet?
          let acked = false;
          /** Index of the request after which the acknowledgment stands recorded. */
          let ackedAt: number | null = null;
          const statuses: number[] = [];
          let expectedRecords = 0;

          for (const [index, [record, ack]] of sequence.entries()) {
            observedFlags.add(ack);
            if (acked && ack === 'absent') sawSaveAfterStateDiscarded = true;

            const before = store.snapshotPartition(userId);
            const { status, body } = await save(userId, record, ack);
            statuses.push(status);

            // The "if and only if": a write happens exactly when the acknowledgment is
            // already recorded or this request carries one (Requirement 12.3).
            const shouldWrite = acked || ack === 'true';
            observedStatuses.add(status);

            if (shouldWrite) {
              expect(status, `request ${index} (${ack})`).toBe(201);
              expectedRecords += 1;
              acked = true;
              if (ackedAt === null) ackedAt = index;
            } else {
              // Requirement 12.5 — the notice was not acknowledged, so nothing at all
              // moved: no record, and no counter bump on the `#meta` item either.
              expect(status, `request ${index} (${ack})`).toBe(428);
              expect(body, `request ${index} (${ack})`).toBe(ACK_REQUIRED_BYTES);
              expect(store.snapshotPartition(userId), `request ${index} (${ack})`).toBe(before);
            }

            expect(await recordCount(userId), `request ${index} (${ack})`).toBe(expectedRecords);
          }

          // Requirement 12.4 — once recorded, the acknowledgment is never asked for again,
          // whatever the later requests carry or omit.
          if (ackedAt !== null) {
            expect(statuses.slice(ackedAt + 1)).not.toContain(428);
            expect(statuses.slice(ackedAt + 1).every((s) => s === 201)).toBe(true);
          }

          // The gate is per-Account: the acknowledgment lives on the caller's own `#meta`
          // item, so a second Account is still gated on its first save.
          if (acked) {
            sawForeignAccountGated = true;

            const beforeForeign = store.snapshotPartition(foreignUserId);
            const gated = await save(foreignUserId, foreignPlan, 'absent');

            expect(gated.status).toBe(428);
            expect(gated.body).toBe(ACK_REQUIRED_BYTES);
            expect(store.snapshotPartition(foreignUserId)).toBe(beforeForeign);
            expect(await recordCount(foreignUserId)).toBe(0);

            // And its own acknowledgment then admits it, leaving the first Account's
            // records untouched.
            const ownRecords = await recordCount(userId);
            const admitted = await save(foreignUserId, foreignPlan, 'true');

            expect(admitted.status).toBe(201);
            expect(await recordCount(foreignUserId)).toBe(1);
            expect(await recordCount(userId)).toBe(ownRecords);
          }
        },
      ).beforeEach(freshStore),
      { numRuns: 60 },
    );

    // Not vacuous: both sides of the gate were reached, every presentation was drawn, and
    // the two clauses that need a specific history actually occurred.
    expect(Array.from(observedStatuses).sort()).toEqual([201, 428]);
    expect(Array.from(observedFlags).sort()).toEqual([...ACK_FLAGS].sort());
    expect(sawSaveAfterStateDiscarded).toBe(true);
    expect(sawForeignAccountGated).toBe(true);
  });
});
