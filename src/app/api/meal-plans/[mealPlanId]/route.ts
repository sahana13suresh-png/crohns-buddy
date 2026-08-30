/**
 * `/api/meal-plans/{mealPlanId}` — read, update, rename, and delete one
 * Meal_Plan_Record.
 *
 * This file is wiring only. The handlers themselves live in
 * `src/lib/server/mealPlanItemRoute.ts` so the repository, the clock, and the
 * token verifier can be injected: a route file may export nothing but its HTTP
 * methods and its segment config, and the indistinguishability property for
 * unusable Meal_Plan_Id references drives the same handlers over the in-memory
 * repository.
 */

import { newMealPlanId } from '@/lib/mealPlanId';
import { createDynamoMealPlanRepository } from '@/lib/server/dynamoMealPlanRepository';
import { assertServerEnv } from '@/lib/server/env';
import { createMealPlanItemRouteHandlers } from '@/lib/server/mealPlanItemRoute';
import type { RouteHandler } from '@/lib/server/withAuth';

/** Node.js runtime: the AWS SDK needs Node crypto for SigV4. */
export const runtime = 'nodejs';
/** Never cached or prerendered — every response is scoped to one Account. */
export const dynamic = 'force-dynamic';
/** us-east-1, pinned to the Meal_Plan_Store and inference region (Requirement 13.6). */
export const preferredRegion = 'iad1';

// A missing credential fails module evaluation rather than surfacing mid-request,
// and the thrown error names the group (Requirements 13.7, 13.11).
assertServerEnv(['MEAL_PLAN_STORE']);

const now = (): number => Date.now();

const handlers = createMealPlanItemRouteHandlers({
  repository: createDynamoMealPlanRepository({
    now,
    // Unused on this path — the id always comes from the request — but the port
    // requires a generator, and this one keeps the ULID's embedded timestamp
    // equal to the clock the rest of the route reads.
    newMealPlanId: () => newMealPlanId(now()),
  }),
  now,
});

interface MealPlanRouteContext {
  params: Promise<{ mealPlanId: string }>;
}

async function invoke(
  handler: RouteHandler,
  request: Request,
  context: MealPlanRouteContext,
): Promise<Response> {
  return handler(request, { params: await context.params });
}

export function GET(request: Request, context: MealPlanRouteContext): Promise<Response> {
  return invoke(handlers.GET, request, context);
}

export function PUT(request: Request, context: MealPlanRouteContext): Promise<Response> {
  return invoke(handlers.PUT, request, context);
}

export function PATCH(request: Request, context: MealPlanRouteContext): Promise<Response> {
  return invoke(handlers.PATCH, request, context);
}

export function DELETE(request: Request, context: MealPlanRouteContext): Promise<Response> {
  return invoke(handlers.DELETE, request, context);
}
