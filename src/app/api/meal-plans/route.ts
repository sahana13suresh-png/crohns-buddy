/**
 * `POST /api/meal-plans` — save a Meal_Plan to the Account (Requirement 5.2).
 * `GET  /api/meal-plans` — one page of saved Meal_Plan_Records (Requirements 6.1–6.3).
 *
 * The module is deliberately only wiring. Next.js accepts nothing but its own known exports
 * from a `route.ts`, so the handler bodies live in `@/lib/server/mealPlansRouteHandlers`,
 * where the property tests can drive them over the in-memory Meal_Plan_Store.
 *
 * `POST` uses `freshRevocationCheck: true` because it mutates: a removed Account or a
 * revoked Session must be observed on this request rather than through the verifier's
 * 5-minute cache (Requirement 4.6). `GET` reads, and tolerates that staleness.
 */

import { assertServerEnv } from '@/lib/server/env';
import {
  createListMealPlansHandler,
  createSaveMealPlanHandler,
  productionMealPlansDeps,
} from '@/lib/server/mealPlansRouteHandlers';
import { withAuth } from '@/lib/server/withAuth';

// The AWS SDK needs Node's crypto for SigV4, and the responses are per-Patient so nothing may
// be cached or statically rendered.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Evaluated when the module is first loaded, so an absent credential fails at startup with
// every incomplete group named, rather than surfacing mid-request as an opaque signing
// error (Requirements 13.7, 13.11).
assertServerEnv(['MEAL_PLAN_STORE']);

const postHandler = withAuth(createSaveMealPlanHandler(productionMealPlansDeps), {
  freshRevocationCheck: true,
});

const getHandler = withAuth(createListMealPlansHandler(productionMealPlansDeps));

export function POST(request: Request): Promise<Response> {
  return postHandler(request);
}

export function GET(request: Request): Promise<Response> {
  return getHandler(request);
}
