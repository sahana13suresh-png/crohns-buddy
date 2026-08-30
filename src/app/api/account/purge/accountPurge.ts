/**
 * The `POST /api/account/purge` handler — the server half of the
 * Account_Deletion_Flow (Requirements 11.3, 11.7, 11.9).
 *
 * It lives beside `route.ts` rather than in it because Next.js validates the
 * export surface of a route file; the factory and the budget constants below are
 * what let the tests drive the handler over the in-memory Meal_Plan_Store and a
 * substituted token verifier.
 *
 * This route removes Meal_Plan_Records and nothing else. It does **not** remove
 * the Account: nothing here touches the Auth_Service, and no code path can,
 * because the Auth_Service admin surface is not reachable from the server at all
 * (design Decision 2). That asymmetry is the whole point of the ordering in
 * Requirement 11.3 — records are purged first, while nothing irreversible has
 * happened yet, and the browser half of the flow (`src/lib/accountDeletion.ts`)
 * calls `deleteCurrentAccount()` only after this route has reported how the
 * purge went. So:
 *
 * - **`200` with `remaining === 0`** — every record for the derived User_Id is
 *   gone. The client may proceed to remove the Account (Requirement 11.3).
 * - **`200` with `remaining > 0`** — the retry budget of Requirement 11.7 was
 *   spent and records still remain, so the User_Id is on the pending-deletion
 *   list and `pendingDeletion` is `true`. The client still removes the Account,
 *   and tells the Patient that removal of the remaining meal plan data is in
 *   progress. The daily sweep finishes it.
 * - **`500`** — the purge did not get far enough to report either of the above.
 *   The Account, every remaining Meal_Plan_Record, and the Session are all left
 *   exactly as they were, and the body carries restart guidance
 *   (Requirement 11.9). The client must not remove the Account after this.
 *
 * The request body is never read. `withAuth` already strips any supplied
 * `userId` from the body, the query, and the params, and the only User_Id this
 * handler can reach is `ctx.identity.userId` (Requirement 4.4). Combined with
 * `freshRevocationCheck: true`, a revoked Session or a removed Account is
 * observed immediately rather than through the 5-minute cache — which matters
 * here more than anywhere else, since this request destroys data
 * (Requirement 4.6).
 */

import type { AuthTokenVerifier } from '@/lib/server/authTokenVerifier';
import { deletionIncompleteResponse, storeFailureCategoryFor } from '@/lib/server/apiErrors';
import { createDynamoMealPlanRepository } from '@/lib/server/dynamoMealPlanRepository';
import { logStoreOp } from '@/lib/server/storeLog';
import { newMealPlanId } from '@/lib/mealPlanId';
import type { Clock, MealPlanRepository } from '@/lib/server/mealPlanRepository';
import { withAuth, type RouteHandler } from '@/lib/server/withAuth';

// ─── Retry budget ──────────────────────────────────────────────────────────────

/**
 * Purge attempts one request gets, the first one included (Requirement 11.7's
 * "up to 3 times").
 *
 * The DynamoDB adapter already retries a batch's `UnprocessedItems` under the
 * same bound, so in production this loop usually runs once. It is kept at the
 * route because the bound belongs to the flow, not to one store adapter: a
 * repository whose `purge` performs no retrying of its own is still held to
 * three attempts within the budget here.
 */
export const PURGE_ATTEMPTS = 3;

/** Wall-clock budget for the whole retry loop, in ms (Requirement 11.7). */
export const PURGE_BUDGET_MS = 60_000;

// ─── Response ──────────────────────────────────────────────────────────────────

/**
 * The `200` body. `deletedCount` and `remaining` count Meal_Plan_Records only —
 * the per-Account `#meta` item is removed by the purge as well, but it is not a
 * record and is counted in neither total.
 *
 * `pendingDeletion` is exactly `remaining > 0`. It is reported rather than left
 * for the client to infer, because the client's message differs on it
 * (Requirement 11.7) and because it is the acknowledgment that the enqueue
 * succeeded — a `200` with `pendingDeletion: true` means the sweep will pick the
 * User_Id up, not merely that records remain.
 */
export interface AccountPurgeResult {
  deletedCount: number;
  remaining: number;
  pendingDeletion: boolean;
}

const JSON_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
});

function purgeResultResponse(result: AccountPurgeResult): Response {
  return new Response(JSON.stringify(result), { status: 200, headers: { ...JSON_HEADERS } });
}

// ─── Store construction ────────────────────────────────────────────────────────

/**
 * Built on first request rather than at module scope, so importing this module —
 * as `next build` does when it collects the route's config, and as the tests do
 * with a repository of their own — never opens a DynamoDB client. The instance
 * is reused across requests on a warm lambda.
 */
let cachedRepository: MealPlanRepository | undefined;

function defaultRepository(): MealPlanRepository {
  cachedRepository ??= createDynamoMealPlanRepository({
    now: () => Date.now(),
    newMealPlanId: () => newMealPlanId(Date.now()),
  });
  return cachedRepository;
}

// ─── Handler ───────────────────────────────────────────────────────────────────

/** Seams for tests. Production uses the defaults. */
export interface PurgeRouteOptions {
  /** Substitutes the Meal_Plan_Store. Absent builds the DynamoDB adapter. */
  repository?: MealPlanRepository | (() => MealPlanRepository);
  /** Substitutes the {@link AuthTokenVerifier}. Absent uses the `jose` adapter. */
  verifier?: AuthTokenVerifier;
  /** Current time in epoch ms, driving the retry deadline and the log timestamps. */
  now?: Clock;
}

/**
 * Runs the purge under the Requirement 11.7 budget: at most
 * {@link PURGE_ATTEMPTS} attempts, and no attempt started once
 * {@link PURGE_BUDGET_MS} has elapsed.
 *
 * `deletedCount` accumulates across attempts, since each attempt reports only
 * what it removed; `remaining` is whatever the last attempt reported. No delay
 * is inserted between attempts on purpose — Requirement 11.3 gives the whole
 * flow 30 seconds, and the adapter's own exponential backoff already paces the
 * batches within an attempt.
 */
async function purgeWithinBudget(
  repository: MealPlanRepository,
  userId: string,
  now: Clock,
): Promise<{ deletedCount: number; remaining: number }> {
  const deadlineMs = now() + PURGE_BUDGET_MS;

  let deletedCount = 0;
  let remaining = 0;

  for (let attempt = 0; attempt < PURGE_ATTEMPTS; attempt += 1) {
    const outcome = await repository.purge(userId);
    deletedCount += outcome.deletedCount;
    remaining = outcome.remaining;

    if (remaining === 0) break;
    if (now() >= deadlineMs) break;
  }

  return { deletedCount, remaining };
}

/**
 * Builds the `POST` handler. Exported so tests can drive it over the in-memory
 * repository and a substituted verifier.
 */
export function createPurgeRoute(options: PurgeRouteOptions = {}): RouteHandler {
  const now = options.now ?? (() => Date.now());
  const resolveRepository =
    typeof options.repository === 'function'
      ? options.repository
      : options.repository === undefined
        ? defaultRepository
        : () => options.repository as MealPlanRepository;

  return withAuth(
    async (_req, ctx): Promise<Response> => {
      const userId = ctx.identity.userId;
      const repository = resolveRepository();

      let deletedCount: number;
      let remaining: number;

      try {
        const outcome = await purgeWithinBudget(repository, userId, now);
        deletedCount = outcome.deletedCount;
        remaining = outcome.remaining;

        // A remainder is recorded *before* the response goes out, so a `200`
        // never tells the client to remove the Account while records are left
        // with nothing scheduled to remove them (Requirement 11.7). An enqueue
        // that throws is therefore a failure of the whole request, not a
        // detail the client can ignore.
        if (remaining > 0) await repository.enqueuePendingDeletion(userId);
      } catch {
        // Nothing has been removed from the Auth_Service by this route, and
        // nothing can have been: the Account and every record the purge did not
        // reach are intact, and the Session stays active. The 500 carries the
        // restart guidance Requirement 11.9 asks for. The error itself is
        // deliberately dropped — it may quote stored values, and neither the
        // response nor the log may carry them (Requirement 7.6).
        logStoreOp({
          mealPlanId: '',
          op: 'purge',
          outcome: 'failure',
          failureCategory: storeFailureCategoryFor('DELETION_INCOMPLETE'),
          atMs: now(),
        });
        return deletionIncompleteResponse();
      }

      logStoreOp({
        mealPlanId: '',
        op: 'purge',
        // `remaining > 0` is a `200` for the flow but not a completed purge, so
        // the store log records it as the failure it is. The category is the
        // most the route can honestly claim: unprocessed deletions come back
        // from a throttled store.
        outcome: remaining === 0 ? 'success' : 'failure',
        ...(remaining === 0 ? {} : { failureCategory: 'throttled' as const }),
        atMs: now(),
      });

      return purgeResultResponse({ deletedCount, remaining, pendingDeletion: remaining > 0 });
    },
    {
      // Requirement 4.6: this request destroys data, so a revoked Session or a
      // removed Account must be seen now rather than up to 5 minutes late.
      freshRevocationCheck: true,
      ...(options.verifier === undefined ? {} : { verifier: options.verifier }),
    },
  );
}
