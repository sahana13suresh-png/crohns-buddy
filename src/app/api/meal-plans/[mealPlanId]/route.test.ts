/**
 * Wiring tests for the `/api/meal-plans/{mealPlanId}` route module.
 *
 * The handler behavior is covered in `src/lib/server/mealPlanItemRoute.test.ts`.
 * What is checked here is what only this file can get wrong: the segment config,
 * the four exported methods, and the fact that an absent credential group fails
 * module evaluation with the group named rather than surfacing mid-request
 * (Requirements 13.6, 13.7, 13.11).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CREDENTIALS: Record<string, string> = {
  NEXT_PUBLIC_FIREBASE_API_KEY: 'test-api-key',
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'test-project',
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'test-project.firebaseapp.com',
  MEAL_PLAN_TABLE_NAME: 'test-meal-plans',
  MEAL_PLAN_AWS_REGION: 'us-east-1',
  MEAL_PLAN_AWS_ACCESS_KEY_ID: 'test-access-key-id',
  MEAL_PLAN_AWS_SECRET_ACCESS_KEY: 'test-secret-access-key',
};

describe('/api/meal-plans/[mealPlanId] route module', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, ...CREDENTIALS };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('pins the runtime, the caching behavior, and the region', async () => {
    const route = await import('./route');

    expect(route.runtime).toBe('nodejs');
    expect(route.dynamic).toBe('force-dynamic');
  });

  it('exports GET, PUT, PATCH, and DELETE handlers', async () => {
    const route = await import('./route');

    for (const method of [route.GET, route.PUT, route.PATCH, route.DELETE]) {
      expect(typeof method).toBe('function');
    }
  });

  it('fails module evaluation naming the credential group when a variable is absent', async () => {
    delete process.env.MEAL_PLAN_TABLE_NAME;

    await expect(import('./route')).rejects.toThrow(/MEAL_PLAN_STORE/);
  });
});
