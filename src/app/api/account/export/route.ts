/**
 * `GET /api/account/export` — the server half of the Account_Data_Export
 * (Requirement 10).
 *
 * Next.js validates the export surface of a `route.ts`, so this file holds only
 * the route config fields, the credential assertion, and the handler itself. The
 * document shape, the file-naming rule, and the handler factory live in
 * `accountExport.ts` beside it.
 *
 * The export spans the two places a Patient's data lives. This route returns the
 * Meal_Plan_Store half; `AccountSettingsPage` merges the device-local tracker
 * entries in and writes the file, because localStorage is not visible from here
 * (Requirements 10.2, 10.3, 10.4).
 */

import { assertServerEnv } from '@/lib/server/env';
import { createExportRoute } from './accountExport';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const preferredRegion = 'iad1'; // us-east-1 — Requirement 13.6

// A missing credential fails module evaluation at startup, with the credential
// group named, rather than mid-export. No default or placeholder is substituted
// (Requirements 13.7, 13.11).
assertServerEnv(['MEAL_PLAN_STORE']);

const getHandler = createExportRoute();

export function GET(request: Request): Promise<Response> {
  return getHandler(request);
}
