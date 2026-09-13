/**
 * `POST /api/account/purge` (Requirements 11.3, 11.7, 11.9).
 *
 * The route file carries only the handler and the config fields Next.js permits
 * a route to export; the behavior, and the seams the tests drive it through,
 * live in `purgeHandler.ts` beside it.
 */

import { assertServerEnv } from '@/lib/server/env';
import { createPurgeRoute } from './accountPurge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// A missing credential fails here, at module evaluation, with the credential
// group named — not mid-purge with a partial deletion behind it
// (Requirements 13.7, 13.11).
assertServerEnv(['MEAL_PLAN_STORE']);

const postHandler = createPurgeRoute();

export function POST(request: Request): Promise<Response> {
  return postHandler(request);
}
