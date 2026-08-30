/**
 * The pending-deletion sweep (Requirement 11.7).
 *
 * This module holds the whole endpoint behind `POST /api/internal/pending-deletion-sweep`:
 * the cron credential check, the bounded retry loop, and the counts it reports. The route
 * file is a thin adapter, because a Next.js route module may only export the HTTP methods
 * and its segment config — so the sweep lives here, where the convergence and idempotency
 * property can drive it directly over the in-memory repository with no HTTP layer between.
 *
 * The sweep is the one part of the server exempt from Requirement 4, and the reason is
 * structural: it runs *after* the Account has been removed from the Auth_Service, so no
 * Auth_Token for the User_Ids it processes can exist. It therefore does not use `withAuth`;
 * it authenticates with a `Bearer ${CRON_SECRET}` header instead.
 *
 * Three properties of the design carry the safety of that exemption:
 *
 * 1. **The comparison is constant time and has no length-dependent branch.** Both the
 *    presented header and the expected value are reduced to a fixed-width SHA-256 digest
 *    before {@link timingSafeEqual} sees them, so the two buffers are always 32 bytes and
 *    the comparison never short-circuits on a length mismatch — which a `timingSafeEqual`
 *    over the raw strings would have to do, leaking the secret's length. An absent or empty
 *    `CRON_SECRET` authorizes nothing, and there is no development bypass.
 * 2. **No User_Id is request-controlled.** Nothing is read from the body, the query, or any
 *    header other than `Authorization`. Every User_Id touched comes from
 *    `listPendingDeletions`, which reads only the reserved `PENDING#DELETION` partition, so
 *    there is no path here that could be steered at another Account's records.
 * 3. **The response carries counts and nothing else.** `{processed, cleared, stillPending}`
 *    holds no User_Id, no Meal_Plan content, and no timestamp, so a leaked `CRON_SECRET`
 *    yields no stored data.
 *
 * Convergence (Requirement 11.7's "until no Meal_Plan_Record for that User_Id remains"):
 * each entry gets at most {@link SWEEP_PURGE_ATTEMPTS} purge attempts inside a
 * {@link SWEEP_ENTRY_BUDGET_MS} budget, and its entry is removed exactly when a purge
 * reports no remaining record. An entry with records left over stays on the list untouched,
 * so the next daily run retries it. Both steps are idempotent — `purge` over an empty
 * partition removes nothing and `delete` over an absent item is a silent success — so a
 * second run over the same list produces the same end state.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import { newMealPlanId } from '../mealPlanId';
import { credentialErrorResponse, serviceUnavailableResponse } from './apiErrors';
import { createDynamoMealPlanRepository } from './dynamoMealPlanRepository';
import {
  PENDING_DELETION_PARTITION,
  type Clock,
  type MealPlanRepository,
} from './mealPlanRepository';

// ─── Bounds ────────────────────────────────────────────────────────────────────

/** Purge attempts one pending entry gets per sweep, including its first. */
export const SWEEP_PURGE_ATTEMPTS = 3;

/** Wall-clock budget for one entry's retries, in milliseconds. */
export const SWEEP_ENTRY_BUDGET_MS = 60_000;

// ─── Result ────────────────────────────────────────────────────────────────────

/**
 * What one sweep run did. Counts only: nothing here identifies an Account.
 *
 * - `processed` — entries that were due at the start of the run
 * - `cleared` — entries removed because no Meal_Plan_Record remains for that User_Id
 * - `stillPending` — entries left in place for the next run
 */
export interface PendingDeletionSweepResult {
  processed: number;
  cleared: number;
  stillPending: number;
}

/** The collaborators a sweep needs. Injected so the sweep is testable over any store. */
export interface PendingDeletionSweepDeps {
  repository: MealPlanRepository;
  now: Clock;
}

// ─── Authentication ────────────────────────────────────────────────────────────

/**
 * Compares two strings without a data-dependent branch.
 *
 * Hashing first is what makes this safe for values of differing length: the digests are
 * always 32 bytes, so {@link timingSafeEqual} is reached unconditionally and no early
 * return reveals how long the expected value is. Two distinct inputs colliding under
 * SHA-256 is not a threat model this endpoint needs to answer.
 */
function constantTimeEquals(presented: string, expected: string): boolean {
  const presentedDigest = createHash('sha256').update(presented, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(presentedDigest, expectedDigest);
}

/**
 * Whether the request carries the configured cron credential.
 *
 * An absent or empty `CRON_SECRET` authorizes nothing, so a deployment that forgot to
 * configure the secret has a sweep that refuses every caller rather than one open to all of
 * them.
 */
export function isAuthorizedSweepRequest(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (secret === undefined || secret === '') return false;

  return constantTimeEquals(request.headers.get('authorization') ?? '', `Bearer ${secret}`);
}

// ─── Sweep ─────────────────────────────────────────────────────────────────────

/**
 * Retries one User_Id's purge within the per-entry bound.
 *
 * @returns `true` when a purge reported no remaining Meal_Plan_Record, which is the only
 *   condition under which the caller removes the pending entry
 */
async function purgeUntilEmpty(deps: PendingDeletionSweepDeps, userId: string): Promise<boolean> {
  const deadlineMs = deps.now() + SWEEP_ENTRY_BUDGET_MS;

  for (let attempt = 0; attempt < SWEEP_PURGE_ATTEMPTS; attempt += 1) {
    // The first attempt always runs; a retry only inside the budget, so one slow entry
    // cannot consume the whole run.
    if (attempt > 0 && deps.now() > deadlineMs) return false;

    try {
      const { remaining } = await deps.repository.purge(userId);
      if (remaining === 0) return true;
    } catch {
      // A throwing purge is indistinguishable here from one reporting remaining records:
      // either way records may survive, so the entry stays and the next attempt — or the
      // next daily sweep — tries again. The repository has already logged the failure
      // through `logStoreOp`; nothing is logged here, where no field could carry an
      // Account's data safely.
    }
  }

  return false;
}

/** Runs one sweep over the entries due at the injected clock's time. */
export async function runPendingDeletionSweep(
  deps: PendingDeletionSweepDeps
): Promise<PendingDeletionSweepResult> {
  const entries = await deps.repository.listPendingDeletions(deps.now());

  let cleared = 0;
  let stillPending = 0;

  for (const entry of entries) {
    if (await purgeUntilEmpty(deps, entry.userId)) {
      // Removed exactly when no record remains for that User_Id. The delete is key-scoped
      // to the reserved partition and is idempotent, so a repeated run is a no-op.
      await deps.repository.delete(PENDING_DELETION_PARTITION, entry.userId);
      cleared += 1;
    } else {
      stillPending += 1;
    }
  }

  return { processed: entries.length, cleared, stillPending };
}

// ─── Handler ───────────────────────────────────────────────────────────────────

/** Built once per instance; the sweep runs at most daily, so nothing here is hot. */
let cachedRepository: MealPlanRepository | undefined;

function productionDeps(): PendingDeletionSweepDeps {
  cachedRepository ??= createDynamoMealPlanRepository({
    now: () => Date.now(),
    // Present because the port requires it; the sweep only purges and deletes, so no id is
    // ever generated here.
    newMealPlanId: () => newMealPlanId(Date.now()),
  });

  return { repository: cachedRepository, now: () => Date.now() };
}

const JSON_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
});

/**
 * The whole endpoint: authenticate, sweep, report counts.
 *
 * @param deps - Store and clock seam; production callers omit it, and an unauthenticated
 *   request is refused before the production store is constructed
 */
export async function handleSweepRequest(
  request: Request,
  deps?: PendingDeletionSweepDeps
): Promise<Response> {
  // Credential first: an unauthenticated caller must not reach the store at all, and the
  // 401 it receives is the same frozen body every other route returns.
  if (!isAuthorizedSweepRequest(request)) return credentialErrorResponse();

  let result: PendingDeletionSweepResult;
  try {
    result = await runPendingDeletionSweep(deps ?? productionDeps());
  } catch {
    // Only an unreachable store reaches here — per-entry failures are absorbed above and
    // reported as `stillPending`. Nothing was lost: the entries remain for the next run.
    return serviceUnavailableResponse();
  }

  return new Response(JSON.stringify(result), { status: 200, headers: JSON_HEADERS });
}
