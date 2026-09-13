/**
 * `POST /api/internal/pending-deletion-sweep` — the daily pending-deletion sweep
 * (Requirement 11.7).
 *
 * A Next.js route module may only export the HTTP methods and its segment config, so the
 * sweep itself — the constant-time `CRON_SECRET` check, the bounded retry loop, and the
 * counts it reports — lives in `src/lib/server/pendingDeletionSweep.ts`, where the
 * convergence and idempotency property can drive it without an HTTP layer in between.
 *
 * This is the one endpoint that does not go through `withAuth`, and the reason is
 * structural: the sweep runs after the Account has been removed from the Auth_Service, so
 * no Auth_Token for the User_Ids it processes can exist (design: route surface).
 */

import { assertServerEnv } from '@/lib/server/env';
import { handleSweepRequest } from '@/lib/server/pendingDeletionSweep';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// A missing store credential fails here, at module evaluation, with the credential group
// named — not mid-sweep as an opaque signing error (Requirements 13.7, 13.11).
assertServerEnv(['MEAL_PLAN_STORE']);

export async function POST(request: Request): Promise<Response> {
  return handleSweepRequest(request);
}
