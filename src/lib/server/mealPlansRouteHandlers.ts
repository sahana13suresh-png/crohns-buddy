/**
 * The handler bodies behind `POST /api/meal-plans` and `GET /api/meal-plans`.
 *
 * They live here rather than in the route module because Next.js accepts only its own
 * known exports from a `route.ts` file — a factory exported alongside `POST` fails the
 * build — and the property tests for the acknowledgment gate and for id-reference
 * indistinguishability need to drive these handlers over the in-memory Meal_Plan_Store.
 * The route module stays what the design asks a route to be: module-scope configuration,
 * the credential assertion, and two `withAuth` wrappers.
 *
 * Both handlers are thin: verify, validate, delegate, map the outcome to a status.
 * Everything substantive lives below them — the Auth_Token check in `withAuth`, the bounds
 * in the Meal_Plan_Serializer, the cap and the acknowledgment gate in the store's
 * transaction, and the failure taxonomy in `apiErrors`.
 *
 * Four orderings in the save handler are load-bearing and are why the steps read the way
 * they do:
 *
 * 1. **Verification precedes everything.** `withAuth` awaits the verifier before the
 *    handler body runs, and `ctx.identity.userId` is the handler's only route to a
 *    User_Id, so no store access can happen ahead of the check and a `userId` supplied in
 *    the body or query is unreachable rather than merely ignored (Requirements 4.1, 4.4).
 * 2. **The id is generated from the injected clock, and `createdAt` comes from the same
 *    millisecond.** The serializer asserts the ULID's embedded timestamp equals
 *    `createdAt`, so the sort key's newest-first ordering cannot drift from the stored
 *    timestamp (Requirements 5.2, 6.2).
 * 3. **`updatedAt` is set equal to `createdAt` on a create** (Requirement 5.2). A `PUT`
 *    later moves `updatedAt` alone.
 * 4. **The 100 kilobyte check runs before the write is attempted** (Requirement 5.7), so an
 *    oversized plan produces a 413 with nothing stored and no store call made.
 */

import { newMealPlanId as newMealPlanIdAt } from '../mealPlanId';
import {
  MAX_SERIALIZED_BYTES,
  MealPlanValidationError,
  serializeMealPlanRecord,
  serializedByteLength,
} from '../mealPlanSerializer';
import { normalizeTitle } from '../mealPlanTitle';
import { decodeCursor } from '../pagination';
import type { MealPlanRecord } from '../types';
import {
  mealPlanValidationErrorResponse,
  planTooLargeResponse,
  saveFailureResponse,
  serviceUnavailableResponse,
  validationErrorResponse,
} from './apiErrors';
import { MealPlanTooLargeError } from './dynamoMealPlanRepository';
import type { Clock, MealPlanRepository } from './mealPlanRepository';
import { getMealPlanRepository, systemClock } from './mealPlanStore';
import { logStoreOp } from './storeLog';
import type { AuthenticatedHandler } from './withAuth';

// ─── Injected collaborators ────────────────────────────────────────────────────

/**
 * What the two handlers need from outside themselves. Resolved per request through a
 * function so the production store is built lazily and a test can substitute the in-memory
 * repository with a fixed clock.
 */
export interface MealPlansRouteDeps {
  /** The Meal_Plan_Store, always addressed with the derived User_Id. */
  repository: MealPlanRepository;
  /** Current time in epoch milliseconds. */
  now: Clock;
  /** Produces the Meal_Plan_Id for a record created at the supplied millisecond. */
  newMealPlanId: (nowMs: number) => string;
}

/** Production collaborators: the real store, the system clock, and a ULID generator. */
export function productionMealPlansDeps(): MealPlansRouteDeps {
  return {
    repository: getMealPlanRepository(),
    now: systemClock,
    newMealPlanId: newMealPlanIdAt,
  };
}

// ─── Shared helpers ────────────────────────────────────────────────────────────

/** Success bodies carry the same no-store posture as the failure bodies in `apiErrors`. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

/** The parsed JSON body as a plain object, or `null` when it is anything else. */
async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/**
 * The supplied title as a string, or `undefined` when absent.
 *
 * `null` counts as absent, so a client that sends `title: null` gets the generated default
 * rather than a rejection (Requirement 5.5). A present value of some other type is not a
 * missing title, so it is reported as a validation failure instead of silently defaulted.
 */
function readSuppliedTitle(value: unknown): { ok: true; title?: string } | { ok: false } {
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== 'string') return { ok: false };
  return { ok: true, title: value };
}

/**
 * Maps a thrown store error to its response. A validation or size error reaching here means
 * a bug above this layer rather than a Patient-correctable condition — both are checked
 * before the store is called — so they are mapped rather than swallowed. Every other
 * failure is an unreachable or throttled store, which is a 503 that leaves the Session and
 * the stored records unchanged.
 */
function storeErrorResponse(error: unknown): Response {
  if (error instanceof MealPlanValidationError) return mealPlanValidationErrorResponse(error);
  if (error instanceof MealPlanTooLargeError) return planTooLargeResponse();
  return serviceUnavailableResponse();
}

// ─── POST — create ─────────────────────────────────────────────────────────────

/**
 * Builds the save handler (Requirement 5.2).
 *
 * @param resolveDeps - Called once per request, so the store is built lazily
 */
export function createSaveMealPlanHandler(
  resolveDeps: () => MealPlansRouteDeps
): AuthenticatedHandler {
  return async function saveMealPlan(req, ctx): Promise<Response> {
    const deps = resolveDeps();

    const body = await readJsonObject(req);
    if (body === null) return validationErrorResponse('body', 'a JSON object');

    const suppliedTitle = readSuppliedTitle(body.title);
    if (!suppliedTitle.ok) return validationErrorResponse('title', '1 to 100 characters');

    const content = body.mealPlan;
    if (typeof content !== 'object' || content === null || Array.isArray(content)) {
      return validationErrorResponse('mealPlan', 'a meal plan object');
    }

    // One millisecond serves as the id's embedded timestamp, `createdAt`, `updatedAt`, and
    // the default title's date, so all four agree by construction (Requirements 5.2, 5.5).
    const createdAtMs = deps.now();
    const mealPlanId = deps.newMealPlanId(createdAtMs);
    const createdAt = new Date(createdAtMs).toISOString();

    const record: MealPlanRecord = {
      userId: ctx.identity.userId,
      mealPlanId,
      title: normalizeTitle(suppliedTitle.title, createdAtMs),
      createdAt,
      updatedAt: createdAt,
      content: content as MealPlanRecord['content'],
    };

    // Bounds first: a Meal_Plan with no meals, an out-of-range field, or a lone surrogate
    // produces a 400 naming the field at fault and no item at all (Requirements 5.15, 9.8).
    // The reported path is the record's — `content.meals[0].items[2].portion` — since that
    // is what the serializer knows.
    let item;
    try {
      item = serializeMealPlanRecord(record);
    } catch (error) {
      if (error instanceof MealPlanValidationError) {
        logStoreOp({
          mealPlanId,
          op: 'create',
          outcome: 'failure',
          failureCategory: 'validation',
          atMs: createdAtMs,
        });
        return mealPlanValidationErrorResponse(error);
      }
      throw error;
    }

    // Size next, and before any store call, so an oversized plan is rejected with nothing
    // written (Requirement 5.7).
    if (serializedByteLength(item) > MAX_SERIALIZED_BYTES) {
      logStoreOp({
        mealPlanId,
        op: 'create',
        outcome: 'failure',
        failureCategory: 'size',
        atMs: createdAtMs,
      });
      return planTooLargeResponse();
    }

    // The cap and the acknowledgment gate are conditions inside the store's transaction, so
    // `cap-reached` (409) and `ack-required` (428) both mean nothing was written
    // (Requirements 5.8, 5.9, 12.3, 12.5).
    let outcome;
    try {
      outcome = await deps.repository.create(
        ctx.identity.userId,
        record,
        body.acknowledgeStorage === true
      );
    } catch (error) {
      return storeErrorResponse(error);
    }

    // `cap-reached`, `ack-required`, and `not-found` are the failures, each mapped by
    // `saveFailureResponse`. `updated` is not reachable from a create — both store
    // implementations report a resubmitted identical save as `created`, which is what
    // Requirement 5.4 asks for — so it is treated as the success it describes rather than
    // given a status of its own.
    if (outcome.kind !== 'created' && outcome.kind !== 'updated') {
      return saveFailureResponse(outcome.kind);
    }

    return jsonResponse(201, {
      mealPlanId,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  };
}

// ─── GET — list ────────────────────────────────────────────────────────────────

/**
 * Builds the list handler (Requirements 6.1, 6.2, 6.3, 6.8).
 *
 * @param resolveDeps - Called once per request, so the store is built lazily
 */
export function createListMealPlansHandler(
  resolveDeps: () => MealPlansRouteDeps
): AuthenticatedHandler {
  return async function listMealPlans(req, ctx): Promise<Response> {
    const deps = resolveDeps();

    // The cursor is decoded here so a malformed one is a 400 that never reaches the store.
    // It names only a sort-key position: the partition is always the derived User_Id, so a
    // cursor lifted from another Account resumes inside the caller's own records and
    // discloses nothing (Requirements 6.3, 6.8).
    const supplied = new URL(req.url).searchParams.get('cursor');
    let cursor: string | undefined;
    if (supplied !== null) {
      if (!decodeCursor(supplied).ok) return validationErrorResponse('cursor');
      cursor = supplied;
    }

    let page;
    try {
      page = await deps.repository.list(ctx.identity.userId, cursor);
    } catch (error) {
      return storeErrorResponse(error);
    }

    // `nextCursor` is omitted entirely on the final page — never `null` or `''` — so the
    // client removes the control that requests further records (Requirement 6.8).
    return jsonResponse(200, {
      items: page.items,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    });
  };
}
