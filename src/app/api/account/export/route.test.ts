// @vitest-environment node
//
// Unit tests for `GET /api/account/export` (Requirement 10).
//
// Only two things are substituted: the Auth_Token verifier, so no RSA signing is
// needed to exercise the document shape, and the Meal_Plan_Store, using the
// in-memory implementation whose `calls` ledger makes "read nothing" observable.
//
// `accountExport.ts` is imported statically — it has no module-scope side effect.
// `route.ts` asserts its credential groups at module scope, so it is imported
// dynamically, after the environment is populated.

import fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';

import type { MealPlanRecord } from '@/lib/types';
import { arbMealPlanRecord } from '@/test/arbitraries';
import type {
  AuthTokenVerifier,
  VerifiedIdentity,
  VerifyResult,
} from '@/lib/server/authTokenVerifier';
import { CREDENTIAL_ERROR_BODY, SERVICE_UNAVAILABLE_BODY } from '@/lib/server/apiErrors';
import {
  createInMemoryMealPlanRepository,
  type InMemoryMealPlanRepository,
} from '@/lib/server/inMemoryMealPlanRepository';
import type { MealPlanRepository } from '@/lib/server/mealPlanRepository';
import { newMealPlanId } from '@/lib/mealPlanId';
import {
  createExportRoute,
  exportFileName,
  type AccountDataExport,
} from './accountExport';

const BASE_URL = 'https://crohns-buddy.test';
const OWNER = 'account-under-test';
const OTHER = 'another-account';
const CREATED_AT_MS = Date.UTC(2024, 4, 17, 8, 15, 0);
const NOW_MS = Date.UTC(2025, 0, 15, 23, 30, 0); // UTC date 2025-01-15

/** The credentials the route asserts at module scope (Requirements 13.7, 13.11). */
const SERVER_ENV: Record<string, string> = {
  NEXT_PUBLIC_FIREBASE_API_KEY: 'test-web-api-key',
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'crohns-buddy-test',
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'crohns-buddy-test.firebaseapp.com',
  MEAL_PLAN_TABLE_NAME: 'crohns-buddy-meal-plans-test',
  MEAL_PLAN_AWS_REGION: 'us-east-1',
  MEAL_PLAN_AWS_ACCESS_KEY_ID: 'test-access-key-id',
  MEAL_PLAN_AWS_SECRET_ACCESS_KEY: 'test-secret-access-key',
};

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const identity = (overrides: Partial<VerifiedIdentity> = {}): VerifiedIdentity => ({
  userId: OWNER,
  authTimeMs: NOW_MS - 60_000,
  email: 'patient@example.test',
  displayName: 'Test Patient',
  accountCreatedAtMs: CREATED_AT_MS,
  ...overrides,
});

/** A verifier that answers with a fixed result, recording what it was asked. */
function stubVerifier(result: VerifyResult): AuthTokenVerifier & { freshChecks: number } {
  const verifier = {
    freshChecks: 0,
    verifyAuthToken(_req: Request, opts?: { requireFreshRevocationCheck?: boolean }) {
      if (opts?.requireFreshRevocationCheck === true) verifier.freshChecks += 1;
      return Promise.resolve(result);
    },
  };
  return verifier;
}

function seededRepository(
  seeds: { userId: string; records: MealPlanRecord[] }[],
): InMemoryMealPlanRepository {
  const repo = createInMemoryMealPlanRepository({
    now: () => NOW_MS,
    newMealPlanId: () => newMealPlanId(NOW_MS),
  });
  repo.seed(
    seeds.map(({ userId, records }) => ({
      userId,
      records,
      storageAckAt: new Date(CREATED_AT_MS).toISOString(),
    })),
  );
  repo.clearCalls();
  return repo;
}

/** Two records for the owner and one for a different Account. */
let ownerRecords: MealPlanRecord[];
let otherRecord: MealPlanRecord;

beforeEach(() => {
  const drawn = fc.sample(arbMealPlanRecord(), 3);
  ownerRecords = [
    { ...drawn[0], userId: OWNER },
    { ...drawn[1], userId: OWNER },
  ];
  otherRecord = { ...drawn[2], userId: OTHER };
});

function call(
  repository: MealPlanRepository,
  verifier: AuthTokenVerifier,
  url = `${BASE_URL}/api/account/export`,
): Promise<Response> {
  const handler = createExportRoute({ repository, verifier, now: () => NOW_MS });
  return handler(new Request(url, { method: 'GET' }), { params: {} });
}

// ─── Cases ─────────────────────────────────────────────────────────────────────

describe('GET /api/account/export', () => {
  it('returns every record the Account owns and nothing from another Account', async () => {
    const repo = seededRepository([
      { userId: OWNER, records: ownerRecords },
      { userId: OTHER, records: [otherRecord] },
    ]);

    const response = await call(repo, stubVerifier({ ok: true, identity: identity() }));
    expect(response.status).toBe(200);

    const document = (await response.json()) as AccountDataExport;

    expect(Object.keys(document).sort()).toEqual([
      'accountCreatedAt',
      'displayName',
      'email',
      'mealPlans',
      'userId',
    ]);
    expect(document.userId).toBe(OWNER);
    expect(document.displayName).toBe('Test Patient');
    expect(document.email).toBe('patient@example.test');
    expect(document.accountCreatedAt).toBe(new Date(CREATED_AT_MS).toISOString());

    expect([...document.mealPlans].map((record) => record.mealPlanId).sort()).toEqual(
      ownerRecords.map((record) => record.mealPlanId).sort(),
    );
    expect(document.mealPlans.every((record) => record.userId === OWNER)).toBe(true);

    // Requirement 10.2 — one unpaged read, confined to the derived User_Id.
    expect(repo.calls).toEqual([{ op: 'listAll', access: 'read', userId: OWNER }]);
  });

  it('serves the download with a UTC-dated file name', async () => {
    const repo = seededRepository([{ userId: OWNER, records: ownerRecords }]);

    const response = await call(repo, stubVerifier({ ok: true, identity: identity() }));

    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="crohns-buddy-export-2025-01-15.json"',
    );
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('emits an empty mealPlans collection rather than omitting it', async () => {
    const repo = seededRepository([{ userId: OWNER, records: [] }]);

    const document = (await (
      await call(repo, stubVerifier({ ok: true, identity: identity() }))
    ).json()) as AccountDataExport;

    expect(document.mealPlans).toEqual([]);
    expect('mealPlans' in document).toBe(true);
  });

  it('emits accountCreatedAt as null when the Auth_Service reported no creation time', async () => {
    const repo = seededRepository([{ userId: OWNER, records: ownerRecords }]);
    const withoutCreatedAt = identity();
    delete withoutCreatedAt.accountCreatedAtMs;

    const document = (await (
      await call(repo, stubVerifier({ ok: true, identity: withoutCreatedAt }))
    ).json()) as AccountDataExport;

    expect(document.accountCreatedAt).toBeNull();
    expect('accountCreatedAt' in document).toBe(true);
  });

  it('ignores a userId supplied in the query string', async () => {
    const repo = seededRepository([
      { userId: OWNER, records: ownerRecords },
      { userId: OTHER, records: [otherRecord] },
    ]);

    const document = (await (
      await call(
        repo,
        stubVerifier({ ok: true, identity: identity() }),
        `${BASE_URL}/api/account/export?userId=${OTHER}`,
      )
    ).json()) as AccountDataExport;

    expect(document.userId).toBe(OWNER);
    expect(repo.calls.every((entry) => entry.userId === OWNER)).toBe(true);
  });

  it('carries no credential-shaped value in the document', async () => {
    const repo = seededRepository([{ userId: OWNER, records: ownerRecords }]);

    const body = await (await call(repo, stubVerifier({ ok: true, identity: identity() }))).text();
    const keys = new Set<string>();
    JSON.parse(body, (key: string) => {
      keys.add(key.toLowerCase());
      return undefined;
    });

    for (const forbidden of [
      'password',
      'authtoken',
      'token',
      'idtoken',
      'credential',
      'providerid',
    ]) {
      expect(keys.has(forbidden)).toBe(false);
    }
  });

  it('reads nothing and returns the frozen 401 when the credential is unusable', async () => {
    const repo = seededRepository([{ userId: OWNER, records: ownerRecords }]);
    const before = repo.snapshot();

    for (const kind of ['missing', 'invalid'] as const) {
      const response = await call(repo, stubVerifier({ ok: false, kind }));

      expect(response.status).toBe(401);
      expect(await response.text()).toBe(JSON.stringify(CREDENTIAL_ERROR_BODY));
    }

    expect(repo.calls).toEqual([]);
    expect(repo.snapshot()).toBe(before);
  });

  it('returns 503 with no partial document when the store is unreachable', async () => {
    const repo = seededRepository([{ userId: OWNER, records: ownerRecords }]);
    const failing: MealPlanRepository = {
      ...repo,
      listAll: () => Promise.reject(new Error('store unreachable')),
    };

    const response = await call(failing, stubVerifier({ ok: true, identity: identity() }));

    expect(response.status).toBe(503);
    expect(await response.text()).toBe(JSON.stringify(SERVICE_UNAVAILABLE_BODY));
    expect(response.headers.get('content-disposition')).toBeNull();
  });

  it('requires a fresh revocation check', async () => {
    const repo = seededRepository([{ userId: OWNER, records: ownerRecords }]);
    const verifier = stubVerifier({ ok: true, identity: identity() });

    await call(repo, verifier);

    expect(verifier.freshChecks).toBe(1);
  });
});

describe('exportFileName', () => {
  it('uses the UTC date, not the local one', () => {
    // 23:30 UTC on 2025-01-15 is already 2025-01-16 in some local zones.
    expect(exportFileName(NOW_MS)).toBe('crohns-buddy-export-2025-01-15.json');
    expect(exportFileName(Date.UTC(2025, 0, 16, 0, 0, 0))).toBe(
      'crohns-buddy-export-2025-01-16.json',
    );
  });
});

describe('route module', () => {
  it('exposes GET once the credential groups are present', async () => {
    for (const [name, value] of Object.entries(SERVER_ENV)) process.env[name] = value;

    const routeModule = await import('./route');

    expect(typeof routeModule.GET).toBe('function');
    expect(routeModule.runtime).toBe('nodejs');
    expect(routeModule.dynamic).toBe('force-dynamic');
    expect(routeModule.preferredRegion).toBe('iad1');
  });
});
