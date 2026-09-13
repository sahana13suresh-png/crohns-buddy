/**
 * Route-level tests for the pending-deletion sweep endpoint (Requirement 11.7).
 * The sweep's own behavior is covered alongside the sweep module; what is left here is the
 * route surface: POST refuses an unauthenticated caller, the segment config is
 * pinned, and the module fails evaluation when the store credential group is incomplete
 * (Requirements 13.7, 13.11).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CREDENTIAL_ERROR_BODY } from '@/lib/server/apiErrors';

const STORE_ENV: Record<string, string> = {
  MEAL_PLAN_TABLE_NAME: 'crohns-buddy-meal-plans-test',
  MEAL_PLAN_AWS_REGION: 'us-east-1',
  MEAL_PLAN_AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  MEAL_PLAN_AWS_SECRET_ACCESS_KEY: 'secret-example',
};

/** Fresh module evaluation per test, so the module-scope assertion is observable. */
async function loadRoute(): Promise<typeof import('./route')> {
  vi.resetModules();
  return import('./route');
}

function sweepRequest(): Request {
  return new Request('https://example.test/api/internal/pending-deletion-sweep', {
    method: 'POST',
    headers: { Authorization: 'Bearer not-the-secret' },
  });
}

beforeEach(() => {
  for (const [name, value] of Object.entries(STORE_ENV)) vi.stubEnv(name, value);
  vi.stubEnv('CRON_SECRET', 'cron-secret-value-long-enough-to-matter');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST', () => {
  it('refuses an unauthorized request with the frozen 401', async () => {
    const route = await loadRoute();

    const response = await route.POST(sweepRequest());

    expect(response.status).toBe(401);
    expect(await response.json()).toStrictEqual(CREDENTIAL_ERROR_BODY);
  });

  it('pins the segment config the store adapter needs', async () => {
    const route = await loadRoute();

    expect(route.runtime).toBe('nodejs');
    expect(route.dynamic).toBe('force-dynamic');
  });
});

describe('startup credential validation', () => {
  it('fails module evaluation naming MEAL_PLAN_STORE when a store variable is absent', async () => {
    vi.stubEnv('MEAL_PLAN_AWS_SECRET_ACCESS_KEY', '');

    await expect(loadRoute()).rejects.toThrow(/MEAL_PLAN_STORE/);
  });
});
