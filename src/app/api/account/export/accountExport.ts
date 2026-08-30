/**
 * The Account_Data_Export document and its handler factory (Requirement 10).
 *
 * This lives beside `route.ts` rather than inside it because Next.js validates
 * the export surface of a `route.ts` file: only `GET`, `POST`, the other method
 * names, and the route config fields may be exported from it. The document
 * shape, the file-naming rule, and the handler factory therefore live here,
 * where tests can reach them and where a later client change can share
 * {@link exportFileName} with the browser half of the export.
 *
 * Four properties of the handler are load-bearing:
 *
 * - **Every identity field comes from the verified Auth_Token, never from the
 *   request.** `withAuth` has already stripped any `userId` from the query and
 *   the body, and the only User_Id reachable here is `ctx.identity.userId`, so
 *   the document cannot be steered at another Account (Requirements 10.5, 4.4).
 * - **No credential can enter the document.** The payload is assembled field by
 *   field into the closed {@link AccountDataExport} shape rather than by
 *   spreading an identity or a token payload, so a password value, an
 *   Auth_Token, or an Identity_Provider credential has no route in
 *   (Requirement 10.6).
 * - **`mealPlans` is always a collection.** An Account owning no records exports
 *   `[]`, never an omitted key (Requirement 10.3).
 * - **The body is serialized only after `listAll` resolves.** A store failure
 *   produces a 503 and no bytes at all, so the client never receives a partial
 *   document to save (Requirement 10.9).
 *
 * `listAll` applies no page limit, as Requirement 10.2 requires; it is bounded
 * by the 100-record-per-Account cap regardless.
 */

import { exportFileName } from '@/lib/accountExportFile';
import { newMealPlanId } from '@/lib/mealPlanId';
import type { MealPlanRecord } from '@/lib/types';
import type { AuthTokenVerifier, VerifiedIdentity } from '@/lib/server/authTokenVerifier';
import { serviceUnavailableResponse } from '@/lib/server/apiErrors';
import { createDynamoMealPlanRepository } from '@/lib/server/dynamoMealPlanRepository';
import type { Clock, MealPlanRepository } from '@/lib/server/mealPlanRepository';
import { withAuth, type RouteHandler } from '@/lib/server/withAuth';

// ─── Document shape ────────────────────────────────────────────────────────────

/**
 * The server half of the Account_Data_Export. The shape is closed on purpose:
 * adding a field is a deliberate edit here rather than something a spread of an
 * identity or a store item could introduce (Requirement 10.6).
 *
 * `trackerEntries` is absent by design — the entries live in the browser's
 * localStorage, which the server cannot see, so `AccountSettingsPage` merges
 * them into this document before writing the file (Requirements 10.2, 10.3).
 */
export interface AccountDataExport {
  /** User_Id derived from the verified Auth_Token (Requirement 10.5). */
  userId: string;
  /** Display name from the verified claims. */
  displayName: string;
  /** Email address from the verified claims. */
  email: string;
  /**
   * Account creation date as an ISO-8601 UTC instant, or `null` when the
   * Auth_Service reported none. Present either way rather than omitted
   * (Requirement 10.3).
   */
  accountCreatedAt: string | null;
  /**
   * Every Meal_Plan_Record the Account owns, with no page limit applied
   * (Requirement 10.2). Empty for an Account owning none, never omitted
   * (Requirement 10.3).
   */
  mealPlans: MealPlanRecord[];
}

/** Seams for tests; production uses the DynamoDB store and the `jose` verifier. */
export interface ExportRouteOptions {
  /** Substitutes the Meal_Plan_Store. Absent builds the DynamoDB adapter. */
  repository?: MealPlanRepository | (() => MealPlanRepository);
  /** Substitutes the {@link AuthTokenVerifier}. Absent uses the `jose` adapter. */
  verifier?: AuthTokenVerifier;
  /** Current time in epoch milliseconds; names the download file. */
  now?: Clock;
}

// ─── Payload assembly ──────────────────────────────────────────────────────────

/**
 * Builds the export document from the verified identity and the records read for
 * that identity's User_Id.
 *
 * Only the four identity fields Requirement 10.2 names are read, one at a time.
 * The identity is never spread, so a field added to `VerifiedIdentity` later
 * cannot silently appear in a Patient's download.
 */
export function buildAccountDataExport(
  identity: VerifiedIdentity,
  mealPlans: MealPlanRecord[],
): AccountDataExport {
  const createdAtMs = identity.accountCreatedAtMs;

  return {
    userId: identity.userId,
    displayName: identity.displayName,
    email: identity.email,
    accountCreatedAt:
      createdAtMs === undefined || !Number.isFinite(createdAtMs)
        ? null
        : new Date(createdAtMs).toISOString(),
    mealPlans,
  };
}

/**
 * Download file name for `nowMs`, using the UTC date (Requirement 10.4).
 *
 * Re-exported from `src/lib/accountExportFile.ts`, which is where the rule now
 * lives so the browser half can share it: this module reaches the DynamoDB
 * client and the token verifier through its imports, so a client component
 * importing it would pull the AWS SDK into the browser bundle. The name the
 * Patient sees is written by the client, from the same function.
 */
export { exportFileName };

// ─── Store construction ────────────────────────────────────────────────────────

/**
 * Built on first request rather than at module scope, so importing the route —
 * as `next build` does when it collects the route's config — never opens a
 * DynamoDB client. The instance is reused across requests on a warm lambda.
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

/**
 * Builds the `GET` handler. `freshRevocationCheck` is set, so a removed Account
 * or a revoked Session is observed immediately instead of through the 5-minute
 * cache, and an unverifiable credential yields the frozen 401 with no store read
 * at all (Requirements 4.6, 10.8).
 */
export function createExportRoute(options: ExportRouteOptions = {}): RouteHandler {
  const now = options.now ?? ((): number => Date.now());
  const resolveRepository =
    typeof options.repository === 'function'
      ? options.repository
      : options.repository === undefined
        ? defaultRepository
        : () => options.repository as MealPlanRepository;

  return withAuth(
    async (_req, ctx): Promise<Response> => {
      const repository = resolveRepository();

      let mealPlans: MealPlanRecord[];
      try {
        // No page limit (Requirement 10.2). The repository logs the store
        // outcome itself; nothing about it is echoed into the response.
        mealPlans = await repository.listAll(ctx.identity.userId);
      } catch {
        // Nothing has been written to the response yet, so an unreachable store
        // produces a 503 and no partial document (Requirement 10.9).
        return serviceUnavailableResponse();
      }

      const document = buildAccountDataExport(ctx.identity, mealPlans);

      return new Response(JSON.stringify(document), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          // Requirement 10.4 — the download name carries the UTC date.
          'Content-Disposition': `attachment; filename="${exportFileName(now())}"`,
          'Cache-Control': 'no-store',
        },
      });
    },
    {
      // Requirement 4.6: the export hands over a Patient's whole stored health
      // record, so a revoked Session or a removed Account must be seen now
      // rather than up to 5 minutes late.
      freshRevocationCheck: true,
      ...(options.verifier === undefined ? {} : { verifier: options.verifier }),
    },
  );
}
