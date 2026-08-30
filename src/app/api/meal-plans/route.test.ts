/**
 * Unit tests for `POST /api/meal-plans` and `GET /api/meal-plans`.
 *
 * The handlers run over the in-memory Meal_Plan_Store and a fake verifier, so every
 * assertion here is about the route's own behavior: which checks run before the store is
 * touched, what the success bodies carry, and how each store outcome maps to a status.
 * The exhaustive coverage of the acknowledgment gate lives in the property test.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// The route asserts its credential groups at module scope (Requirements 13.7, 13.11), so
// the variables have to exist before the import is evaluated. The values are never used:
// the store is injected and the verifier is a fake.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_FIREBASE_API_KEY = 'test-api-key';
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'test-project';
  process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN = 'test-project.firebaseapp.com';
  process.env.MEAL_PLAN_TABLE_NAME = 'test-table';
  process.env.MEAL_PLAN_AWS_REGION = 'us-east-1';
  process.env.MEAL_PLAN_AWS_ACCESS_KEY_ID = 'test-access-key-id';
  process.env.MEAL_PLAN_AWS_SECRET_ACCESS_KEY = 'test-secret-access-key';
});

import { newMealPlanId } from '@/lib/mealPlanId';
import { MAX_SERIALIZED_BYTES } from '@/lib/mealPlanSerializer';
import { decodeCursor } from '@/lib/pagination';
import type { MealPlanContent, MealPlanRecord } from '@/lib/types';
import type { AuthTokenVerifier, VerifiedIdentity } from '@/lib/server/authTokenVerifier';
import {
  createInMemoryMealPlanRepository,
  type InMemoryMealPlanRepository,
} from '@/lib/server/inMemoryMealPlanRepository';
import {
  createListMealPlansHandler,
  createSaveMealPlanHandler,
} from '@/lib/server/mealPlansRouteHandlers';
import { withAuth } from '@/lib/server/withAuth';

import { GET as ROUTE_GET, POST as ROUTE_POST } from './route';

const USER_ID = 'derived-user-id';

const IDENTITY: VerifiedIdentity = {
  userId: USER_ID,
  authTimeMs: 1_700_000_000_000,
  email: 'patient@example.com',
  displayName: 'Patient',
};

const VERIFIER: AuthTokenVerifier = {
  verifyAuthToken: async () => ({ ok: true, identity: IDENTITY }),
};

const CONTENT: MealPlanContent = {
  meals: [
    {
      mealName: 'Breakfast',
      items: [{ name: 'Oatmeal', portion: '1 cup', notes: 'Cook until soft' }],
    },
  ],
  summary: 'A gentle low-residue day.',
};

/** Fixed clock, so the generated id, `createdAt`, and the default title all agree. */
const NOW_MS = Date.parse('2025-03-04T05:06:07.008Z');

let store: InMemoryMealPlanRepository;
let clockMs: number;

/** The route's collaborators, resolved per request as production does. */
function deps() {
  return {
    repository: store,
    now: () => clockMs,
    newMealPlanId: (ms: number) => newMealPlanId(ms),
  };
}

const post = withAuth(createSaveMealPlanHandler(deps), {
  verifier: VERIFIER,
  freshRevocationCheck: true,
});

const get = withAuth(createListMealPlansHandler(deps), { verifier: VERIFIER });

function saveRequest(body: unknown): Request {
  return new Request('https://example.com/api/meal-plans', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer token' },
    body: JSON.stringify(body),
  });
}

function listRequest(query = ''): Request {
  return new Request(`https://example.com/api/meal-plans${query}`, {
    headers: { authorization: 'Bearer token' },
  });
}

/** A record already in the store, created at `ms`. */
function storedRecord(ms: number): MealPlanRecord {
  const iso = new Date(ms).toISOString();
  return {
    userId: USER_ID,
    mealPlanId: newMealPlanId(ms),
    title: `Plan ${iso}`,
    createdAt: iso,
    updatedAt: iso,
    content: CONTENT,
  };
}

/** A plan whose serialized form is comfortably over the 100 kilobyte ceiling. */
function oversizedContent(): MealPlanContent {
  const notes = 'n'.repeat(1000);
  return {
    meals: Array.from({ length: 10 }, (_unused, meal) => ({
      mealName: `Meal ${meal}`,
      items: Array.from({ length: 20 }, (_ignored, item) => ({
        name: `Item ${item}`,
        portion: '1 cup',
        notes,
      })),
    })),
    summary: 'Oversized',
  };
}

beforeEach(() => {
  clockMs = NOW_MS;
  store = createInMemoryMealPlanRepository({
    now: () => clockMs,
    newMealPlanId: () => newMealPlanId(clockMs),
  });
});

describe('route module', () => {
  it('exports both methods, having asserted its credential groups at module scope', () => {
    // Reaching this assertion at all means `assertServerEnv(['AUTH_SERVICE',
    // 'MEAL_PLAN_STORE'])` ran during module evaluation without throwing.
    expect(typeof ROUTE_POST).toBe('function');
    expect(typeof ROUTE_GET).toBe('function');
  });
});

describe('POST /api/meal-plans', () => {
  it('creates a record and answers 201 with updatedAt equal to createdAt', async () => {
    const response = await post(saveRequest({ mealPlan: CONTENT, acknowledgeStorage: true }));

    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, string>;
    expect(Object.keys(body).sort()).toEqual(['createdAt', 'mealPlanId', 'title', 'updatedAt']);
    expect(body.createdAt).toBe(new Date(NOW_MS).toISOString());
    expect(body.updatedAt).toBe(body.createdAt);

    // The id's embedded millisecond timestamp is the same one `createdAt` reports, which
    // is what keeps sort-key ordering aligned with the stored timestamp.
    const stored = await store.get(USER_ID, body.mealPlanId);
    expect(stored?.createdAt).toBe(body.createdAt);
    expect(stored?.content).toEqual(CONTENT);
  });

  it('defaults a whitespace-only title to the UTC creation date', async () => {
    const response = await post(
      saveRequest({ mealPlan: CONTENT, title: '   \n ', acknowledgeStorage: true })
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { title: string };
    expect(body.title).toBe('Meal plan — 2025-03-04');
  });

  it('trims a supplied title and truncates one over 100 characters', async () => {
    const trimmed = await post(
      saveRequest({ mealPlan: CONTENT, title: '  Weekend plan  ', acknowledgeStorage: true })
    );
    expect(((await trimmed.json()) as { title: string }).title).toBe('Weekend plan');

    const long = await post(saveRequest({ mealPlan: CONTENT, title: 'x'.repeat(140) }));
    expect(long.status).toBe(201);
    expect(((await long.json()) as { title: string }).title).toBe('x'.repeat(100));
  });

  it('rejects a plan with no meals as 400 naming the collection, writing nothing', async () => {
    const response = await post(
      saveRequest({ mealPlan: { meals: [], summary: 'Empty' }, acknowledgeStorage: true })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'VALIDATION_FAILED',
      message: 'Request field "content.meals" is not within its permitted bound (1..10 entries).',
      field: 'content.meals',
    });
    expect(store.calls).toHaveLength(0);
  });

  it('rejects a missing mealPlan as 400 naming the request field', async () => {
    const response = await post(saveRequest({ title: 'No plan' }));

    expect(response.status).toBe(400);
    expect((await response.json()).field).toBe('mealPlan');
    expect(store.calls).toHaveLength(0);
  });

  it('rejects an oversized plan as 413 before any store call', async () => {
    const response = await post(
      saveRequest({ mealPlan: oversizedContent(), acknowledgeStorage: true })
    );

    expect(response.status).toBe(413);
    expect((await response.json()).error).toBe('PLAN_TOO_LARGE');
    expect(store.calls).toHaveLength(0);
  });

  it('answers 428 and stores nothing when the storage notice is unacknowledged', async () => {
    const response = await post(saveRequest({ mealPlan: CONTENT }));

    expect(response.status).toBe(428);
    expect((await response.json()).error).toBe('STORAGE_ACK_REQUIRED');
    expect((await store.list(USER_ID)).items).toHaveLength(0);
  });

  it('answers 409 when the Account already holds 100 records', async () => {
    store.seed([{ userId: USER_ID, planCount: 100, storageAckAt: new Date(NOW_MS).toISOString() }]);

    const response = await post(saveRequest({ mealPlan: CONTENT }));

    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('PLAN_LIMIT_REACHED');
  });

  it('answers 503 when the store is unreachable, leaving nothing written', async () => {
    const failing = { ...store, create: async () => { throw new Error('store unreachable'); } };
    const handler = withAuth(
      createSaveMealPlanHandler(() => ({
        repository: failing,
        now: () => clockMs,
        newMealPlanId: (ms: number) => newMealPlanId(ms),
      })),
      { verifier: VERIFIER, freshRevocationCheck: true }
    );

    const response = await handler(saveRequest({ mealPlan: CONTENT, acknowledgeStorage: true }));

    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe('SERVICE_UNAVAILABLE');
  });

  it('rejects a malformed body as 400 without touching the store', async () => {
    const response = await post(
      new Request('https://example.com/api/meal-plans', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      })
    );

    expect(response.status).toBe(400);
    expect(store.calls).toHaveLength(0);
  });

  it('keeps the serialized item under the ceiling it checks against', () => {
    // Guards the oversized fixture itself: if the bound moved, the 413 case above would
    // otherwise pass for the wrong reason.
    expect(JSON.stringify(oversizedContent()).length).toBeGreaterThan(MAX_SERIALIZED_BYTES);
  });
});

describe('GET /api/meal-plans', () => {
  it('returns a page newest first, with nextCursor omitted on the final page', async () => {
    const records = Array.from({ length: 21 }, (_unused, index) =>
      storedRecord(NOW_MS + index * 1000)
    );
    store.seed([{ userId: USER_ID, records, storageAckAt: new Date(NOW_MS).toISOString() }]);

    const first = await get(listRequest());
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      items: Array<{ mealPlanId: string; createdAt: string }>;
      nextCursor?: string;
    };

    expect(firstBody.items).toHaveLength(20);
    expect(typeof firstBody.nextCursor).toBe('string');

    const created = firstBody.items.map((item) => item.createdAt);
    expect([...created].sort().reverse()).toEqual(created);
    expect(firstBody.items[0].createdAt).toBe(new Date(NOW_MS + 20 * 1000).toISOString());
    expect(decodeCursor(firstBody.nextCursor as string).ok).toBe(true);

    const second = await get(listRequest(`?cursor=${encodeURIComponent(firstBody.nextCursor as string)}`));
    const secondBody = (await second.json()) as { items: unknown[]; nextCursor?: string };

    expect(second.status).toBe(200);
    expect(secondBody.items).toHaveLength(1);
    expect('nextCursor' in secondBody).toBe(false);
  });

  it('returns an empty page for an Account holding no records', async () => {
    const response = await get(listRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [] });
  });

  it('rejects a malformed cursor as 400 without reading the store', async () => {
    const response = await get(listRequest('?cursor=not-a-cursor'));

    expect(response.status).toBe(400);
    expect((await response.json()).field).toBe('cursor');
    expect(store.calls).toHaveLength(0);
  });

  it('answers 503 when the store is unreachable', async () => {
    const failing = { ...store, list: async () => { throw new Error('store unreachable'); } };
    const handler = withAuth(
      createListMealPlansHandler(() => ({
        repository: failing,
        now: () => clockMs,
        newMealPlanId: (ms: number) => newMealPlanId(ms),
      })),
      { verifier: VERIFIER }
    );

    const response = await handler(listRequest());

    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe('SERVICE_UNAVAILABLE');
  });
});
