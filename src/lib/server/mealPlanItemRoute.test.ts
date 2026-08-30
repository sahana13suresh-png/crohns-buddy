/**
 * Unit tests for the `/api/meal-plans/{mealPlanId}` handlers.
 *
 * The exhaustive indistinguishability coverage is Property 6; these cases pin the
 * concrete behaviors easiest to break by accident: the status mapping, the frozen
 * 404 for every unusable id with no store access, `PUT` preserving `mealPlanId`
 * and `createdAt`, `PATCH` leaving content untouched, and `DELETE` reporting 204
 * for an already-absent record.
 */

import { describe, expect, it, vi } from 'vitest';

import { mealPlanIdTimestampMs, newMealPlanId } from '../mealPlanId';
import { MealPlanItemError } from '../mealPlanSerializer';
import type { MealPlanContent, MealPlanRecord } from '../types';
import { NOT_FOUND_BODY, PLAN_TOO_LARGE_BODY, PLAN_UNREADABLE_BODY, SERVICE_UNAVAILABLE_BODY } from './apiErrors';
import type { AuthTokenVerifier, VerifiedIdentity } from './authTokenVerifier';
import {
  createInMemoryMealPlanRepository,
  type InMemoryMealPlanRepository,
} from './inMemoryMealPlanRepository';
import type { MealPlanRepository } from './mealPlanRepository';
import { createMealPlanItemRouteHandlers } from './mealPlanItemRoute';

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const OWNER = 'owner-user-id';
const OTHER = 'other-user-id';

const CREATED_MS = 1_700_000_000_000;
const NOW_MS = 1_700_000_500_000;

const IDENTITY: VerifiedIdentity = {
  userId: OWNER,
  authTimeMs: CREATED_MS,
  email: 'patient@example.com',
  displayName: 'Patient',
};

const verifier: AuthTokenVerifier = {
  verifyAuthToken: vi.fn(async () => ({ ok: true as const, identity: IDENTITY })),
};

const CONTENT: MealPlanContent = {
  meals: [{ mealName: 'Breakfast', items: [{ name: 'Oatmeal', portion: '1 cup' }] }],
  summary: 'A gentle start to the day.',
};

const REPLACEMENT_CONTENT: MealPlanContent = {
  meals: [{ mealName: 'Lunch', items: [{ name: 'White rice', portion: '1 cup' }] }],
  summary: 'Low residue.',
  warnings: ['Chew thoroughly.'],
};

/** A serialized plan well over the 100 kilobyte ceiling, within every other bound. */
const OVERSIZED_CONTENT: MealPlanContent = {
  meals: Array.from({ length: 10 }, (_unused, meal) => ({
    mealName: `Meal ${meal}`,
    items: Array.from({ length: 20 }, (_item, index) => ({
      name: `Item ${index}`,
      portion: '1 cup',
      notes: 'x'.repeat(1000),
    })),
  })),
  summary: 'y'.repeat(5000),
};

function recordOf(mealPlanId: string, overrides: Partial<MealPlanRecord> = {}): MealPlanRecord {
  // The serializer requires `createdAt` to equal the id's embedded millisecond
  // timestamp, so it is derived from the id rather than fixed.
  const createdAt = new Date(mealPlanIdTimestampMs(mealPlanId)).toISOString();
  return {
    userId: OWNER,
    mealPlanId,
    title: 'Low-fiber week',
    createdAt,
    updatedAt: createdAt,
    content: CONTENT,
    ...overrides,
  };
}

/** Ids whose Meal_Plan_Id fails Requirement 7.8's charset, length, or emptiness check. */
const UNUSABLE_IDS = ['', 'a'.repeat(65), 'has space', '#meta', 'under_score', 'slash/slash'];

// ─── Harness ───────────────────────────────────────────────────────────────────

function handlersFor(repository: MealPlanRepository) {
  return createMealPlanItemRouteHandlers({ repository, now: () => NOW_MS, verifier });
}

function seededRepository(records: MealPlanRecord[]): InMemoryMealPlanRepository {
  const repository = createInMemoryMealPlanRepository({
    now: () => NOW_MS,
    newMealPlanId: () => newMealPlanId(NOW_MS),
  });
  repository.seed([{ userId: OWNER, records, storageAckAt: new Date(CREATED_MS).toISOString() }]);
  return repository;
}

function requestFor(mealPlanId: string, method: string, body?: unknown): Request {
  const url = `https://example.com/api/meal-plans/${encodeURIComponent(mealPlanId)}`;
  if (body === undefined) return new Request(url, { method });
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function contextFor(mealPlanId: string): { params: Record<string, string> } {
  return { params: { mealPlanId } };
}

// ─── Unusable ids (Requirements 7.3, 7.4, 7.8) ─────────────────────────────────

describe('unusable Meal_Plan_Id references', () => {
  it('returns the frozen 404 for every method without touching the store', async () => {
    for (const id of UNUSABLE_IDS) {
      const repository = seededRepository([recordOf(newMealPlanId(CREATED_MS))]);
      const { GET, PUT, PATCH, DELETE } = handlersFor(repository);
      repository.clearCalls();

      const responses = [
        await GET(requestFor(id, 'GET'), contextFor(id)),
        await PUT(requestFor(id, 'PUT', { content: CONTENT }), contextFor(id)),
        await PATCH(requestFor(id, 'PATCH', { title: 'Renamed' }), contextFor(id)),
        await DELETE(requestFor(id, 'DELETE'), contextFor(id)),
      ];

      for (const response of responses) {
        expect(response.status).toBe(404);
        expect(JSON.parse(await response.text())).toEqual(NOT_FOUND_BODY);
      }
      expect(repository.calls).toHaveLength(0);
    }
  });

  it('answers an id owned elsewhere and an id existing nowhere with identical bytes', async () => {
    const ownedElsewhere = newMealPlanId(CREATED_MS);
    const nowhere = newMealPlanId(CREATED_MS + 1);

    const repository = seededRepository([]);
    repository.seed([
      { userId: OTHER, records: [recordOf(ownedElsewhere, { userId: OTHER })] },
    ]);
    const { GET } = handlersFor(repository);

    const elsewhere = await GET(requestFor(ownedElsewhere, 'GET'), contextFor(ownedElsewhere));
    const absent = await GET(requestFor(nowhere, 'GET'), contextFor(nowhere));

    expect(elsewhere.status).toBe(absent.status);
    expect(await elsewhere.text()).toBe(await absent.text());
    // The record under the other Account is untouched.
    expect(repository.snapshotPartition(OTHER)).toContain(ownedElsewhere);
  });
});

// ─── GET (Requirements 6.4, 6.9) ───────────────────────────────────────────────

describe('GET', () => {
  it('returns the stored record with its order preserved', async () => {
    const id = newMealPlanId(CREATED_MS);
    const stored = recordOf(id, { content: REPLACEMENT_CONTENT });
    const { GET } = handlersFor(seededRepository([stored]));

    const response = await GET(requestFor(id, 'GET'), contextFor(id));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ record: stored });
  });

  it('returns 422 with no attribute detail when the deserializer signals an error', async () => {
    const id = newMealPlanId(CREATED_MS);
    const repository = seededRepository([recordOf(id)]);
    const before = repository.snapshot();

    const failing: MealPlanRepository = {
      ...repository,
      get: async () => {
        throw new MealPlanItemError('content.meals[0].items', 'wrong-type');
      },
    };
    const { GET } = handlersFor(failing);

    const response = await GET(requestFor(id, 'GET'), contextFor(id));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual(PLAN_UNREADABLE_BODY);
    // Requirement 6.9: the stored Meal_Plan_Record is left unchanged.
    expect(repository.snapshot()).toBe(before);
  });

  it('returns 503 when the Meal_Plan_Store is unreachable', async () => {
    const id = newMealPlanId(CREATED_MS);
    const failing: MealPlanRepository = {
      ...seededRepository([recordOf(id)]),
      get: async () => {
        throw Object.assign(new Error('unreachable'), { name: 'ThrottlingException' });
      },
    };
    const { GET } = handlersFor(failing);

    const response = await GET(requestFor(id, 'GET'), contextFor(id));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(SERVICE_UNAVAILABLE_BODY);
  });
});

// ─── PUT (Requirements 5.3, 5.4, 5.7) ──────────────────────────────────────────

describe('PUT', () => {
  it('replaces content and updatedAt while preserving mealPlanId and createdAt', async () => {
    const id = newMealPlanId(CREATED_MS);
    const repository = seededRepository([recordOf(id)]);
    const { PUT } = handlersFor(repository);

    const response = await PUT(
      requestFor(id, 'PUT', { content: REPLACEMENT_CONTENT, title: '  Renamed on save  ' }),
      contextFor(id)
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      mealPlanId: id,
      updatedAt: new Date(NOW_MS).toISOString(),
    });

    const stored = await repository.get(OWNER, id);
    expect(stored).toEqual({
      userId: OWNER,
      mealPlanId: id,
      title: 'Renamed on save',
      createdAt: new Date(CREATED_MS).toISOString(),
      updatedAt: new Date(NOW_MS).toISOString(),
      content: REPLACEMENT_CONTENT,
    });
  });

  it('returns 413 for an oversized plan before attempting a write', async () => {
    const id = newMealPlanId(CREATED_MS);
    const repository = seededRepository([recordOf(id)]);
    const before = repository.snapshot();
    const { PUT } = handlersFor(repository);
    repository.clearCalls();

    const response = await PUT(
      requestFor(id, 'PUT', { content: OVERSIZED_CONTENT }),
      contextFor(id)
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual(PLAN_TOO_LARGE_BODY);
    expect(repository.calls).toHaveLength(0);
    expect(repository.snapshot()).toBe(before);
  });

  it('returns 400 naming the collection when the plan carries no meals', async () => {
    const id = newMealPlanId(CREATED_MS);
    const repository = seededRepository([recordOf(id)]);
    const { PUT } = handlersFor(repository);
    repository.clearCalls();

    const response = await PUT(
      requestFor(id, 'PUT', { content: { meals: [], summary: '' } }),
      contextFor(id)
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'VALIDATION_FAILED',
      field: 'content.meals',
    });
    expect(repository.calls).toHaveLength(0);
  });

  it('returns the frozen 404 for a record the Account does not hold', async () => {
    const id = newMealPlanId(CREATED_MS);
    const { PUT } = handlersFor(seededRepository([]));

    const response = await PUT(requestFor(id, 'PUT', { content: CONTENT }), contextFor(id));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(NOT_FOUND_BODY);
  });

  it('returns 400 for a body that is not a JSON object', async () => {
    const id = newMealPlanId(CREATED_MS);
    const { PUT } = handlersFor(seededRepository([recordOf(id)]));

    const response = await PUT(
      new Request(`https://example.com/api/meal-plans/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json at all',
      }),
      contextFor(id)
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'VALIDATION_FAILED', field: 'body' });
  });
});

// ─── PATCH (Requirements 8.4, 8.6, 8.7) ────────────────────────────────────────

describe('PATCH', () => {
  it('stores the trimmed title and updatedAt, leaving the content untouched', async () => {
    const id = newMealPlanId(CREATED_MS);
    const repository = seededRepository([recordOf(id)]);
    const { PATCH } = handlersFor(repository);

    const response = await PATCH(
      requestFor(id, 'PATCH', { title: '   Autumn plan   ' }),
      contextFor(id)
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      title: 'Autumn plan',
      updatedAt: new Date(NOW_MS).toISOString(),
    });

    const stored = await repository.get(OWNER, id);
    expect(stored?.title).toBe('Autumn plan');
    expect(stored?.updatedAt).toBe(new Date(NOW_MS).toISOString());
    expect(stored?.createdAt).toBe(new Date(CREATED_MS).toISOString());
    expect(stored?.content).toEqual(CONTENT);
  });

  it('rejects an empty, whitespace-only, over-long, or absent title without renaming', async () => {
    const id = newMealPlanId(CREATED_MS);

    for (const title of ['', '    ', 'z'.repeat(101), undefined, 42]) {
      const repository = seededRepository([recordOf(id)]);
      const { PATCH } = handlersFor(repository);
      repository.clearCalls();

      const response = await PATCH(
        requestFor(id, 'PATCH', title === undefined ? {} : { title }),
        contextFor(id)
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: 'VALIDATION_FAILED',
        field: 'title',
      });
      expect(repository.calls).toHaveLength(0);
      expect((await repository.get(OWNER, id))?.title).toBe('Low-fiber week');
    }
  });

  it('accepts a title of exactly 100 characters', async () => {
    const id = newMealPlanId(CREATED_MS);
    const repository = seededRepository([recordOf(id)]);
    const { PATCH } = handlersFor(repository);

    const title = 'z'.repeat(100);
    const response = await PATCH(requestFor(id, 'PATCH', { title }), contextFor(id));

    expect(response.status).toBe(200);
    expect((await repository.get(OWNER, id))?.title).toBe(title);
  });

  it('returns the frozen 404 for a record the Account does not hold', async () => {
    const id = newMealPlanId(CREATED_MS);
    const { PATCH } = handlersFor(seededRepository([]));

    const response = await PATCH(requestFor(id, 'PATCH', { title: 'Renamed' }), contextFor(id));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(NOT_FOUND_BODY);
  });
});

// ─── DELETE (Requirements 8.1, 8.3) ────────────────────────────────────────────

describe('DELETE', () => {
  it('removes the record and returns 204, leaving the remaining records in place', async () => {
    const target = newMealPlanId(CREATED_MS);
    const keeper = newMealPlanId(CREATED_MS + 1);
    const repository = seededRepository([recordOf(target), recordOf(keeper)]);
    const { DELETE } = handlersFor(repository);

    const response = await DELETE(requestFor(target, 'DELETE'), contextFor(target));

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(await repository.get(OWNER, target)).toBeNull();
    expect(await repository.get(OWNER, keeper)).not.toBeNull();
  });

  it('returns 204 when the record is already absent', async () => {
    const id = newMealPlanId(CREATED_MS);
    const keeper = newMealPlanId(CREATED_MS + 1);
    const repository = seededRepository([recordOf(keeper)]);
    const { DELETE } = handlersFor(repository);

    const first = await DELETE(requestFor(id, 'DELETE'), contextFor(id));
    const second = await DELETE(requestFor(id, 'DELETE'), contextFor(id));

    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    expect(await repository.get(OWNER, keeper)).not.toBeNull();
  });

  it('returns 503 when the Meal_Plan_Store is unreachable', async () => {
    const id = newMealPlanId(CREATED_MS);
    const failing: MealPlanRepository = {
      ...seededRepository([recordOf(id)]),
      delete: async () => {
        throw new Error('unreachable');
      },
    };
    const { DELETE } = handlersFor(failing);

    const response = await DELETE(requestFor(id, 'DELETE'), contextFor(id));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(SERVICE_UNAVAILABLE_BODY);
  });
});
