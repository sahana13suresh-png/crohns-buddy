/**
 * Unit smoke tests for `withAuth` (Requirement 4).
 *
 * The exhaustive coverage lives in the property tests (Property 7 and Property
 * 8, `withAuth.property.test.ts`). These cases pin the concrete behaviors that
 * are easiest to break by accident: the status mapping, the byte-identical 401,
 * and the fact that a supplied `userId` is unreachable from the handler.
 */

import { describe, expect, it, vi } from 'vitest';

import type { AuthTokenVerifier, VerifiedIdentity, VerifyResult } from './authTokenVerifier';
import { CREDENTIAL_ERROR_BODY, SERVICE_UNAVAILABLE_BODY } from './apiErrors';
import { withAuth } from './withAuth';

const IDENTITY: VerifiedIdentity = {
  userId: 'derived-user-id',
  authTimeMs: 1_700_000_000_000,
  email: 'patient@example.com',
  displayName: 'Patient',
};

function verifierReturning(result: VerifyResult): AuthTokenVerifier {
  return { verifyAuthToken: vi.fn(async () => result) };
}

describe('withAuth', () => {
  it('maps missing and invalid credentials to one byte-identical 401', async () => {
    const handler = vi.fn(async () => new Response('handler ran'));

    const missing = await withAuth(handler, {
      verifier: verifierReturning({ ok: false, kind: 'missing' }),
    })(new Request('https://example.com/api/meal-plans'));

    const invalid = await withAuth(handler, {
      verifier: verifierReturning({ ok: false, kind: 'invalid' }),
    })(new Request('https://example.com/api/meal-plans'));

    const missingText = await missing.text();
    const invalidText = await invalid.text();

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(missingText).toBe(invalidText);
    expect(JSON.parse(invalidText)).toEqual(CREDENTIAL_ERROR_BODY);
    expect(handler).not.toHaveBeenCalled();
  });

  it('maps an unreachable Auth_Service to 503', async () => {
    const handler = vi.fn(async () => new Response('handler ran'));

    const response = await withAuth(handler, {
      verifier: verifierReturning({ ok: false, kind: 'unavailable' }),
    })(new Request('https://example.com/api/meal-plans'));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(SERVICE_UNAVAILABLE_BODY);
    expect(handler).not.toHaveBeenCalled();
  });

  it('strips a supplied userId from the body, query, and params', async () => {
    let seenBody: unknown;
    let seenQuery: string | null = 'unset';
    let seenParams: Record<string, string> = {};
    let seenUserId = '';

    const handler = withAuth(
      async (req, ctx) => {
        seenBody = await req.json();
        seenQuery = new URL(req.url).searchParams.get('userId');
        seenParams = ctx.params;
        seenUserId = ctx.identity.userId;
        return new Response(null, { status: 204 });
      },
      { verifier: verifierReturning({ ok: true, identity: IDENTITY }) },
    );

    const response = await handler(
      new Request('https://example.com/api/meal-plans?userId=someone-else&limit=20', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'someone-else', title: 'Weekday plan' }),
      }),
      { params: { mealPlanId: '01JBX2ZQ4C6K0YV6E3W2N7T5AB', userId: 'someone-else' } },
    );

    // A mismatched supplied userId completes normally, with no error reported.
    expect(response.status).toBe(204);
    expect(seenBody).toEqual({ title: 'Weekday plan' });
    expect(seenQuery).toBeNull();
    expect(seenParams).toEqual({ mealPlanId: '01JBX2ZQ4C6K0YV6E3W2N7T5AB' });
    expect(seenUserId).toBe('derived-user-id');
  });

  it('forwards freshRevocationCheck to the verifier', async () => {
    const verifier = verifierReturning({ ok: true, identity: IDENTITY });
    const handler = async () => new Response(null, { status: 204 });

    await withAuth(handler, { verifier, freshRevocationCheck: true })(
      new Request('https://example.com/api/meal-plans', { method: 'DELETE' }),
    );
    await withAuth(handler, { verifier })(new Request('https://example.com/api/meal-plans'));

    expect(verifier.verifyAuthToken).toHaveBeenNthCalledWith(1, expect.any(Request), {
      requireFreshRevocationCheck: true,
    });
    expect(verifier.verifyAuthToken).toHaveBeenNthCalledWith(2, expect.any(Request), {
      requireFreshRevocationCheck: false,
    });
  });

  it('leaves a non-JSON body and an unrelated query string untouched', async () => {
    let seenText = '';
    let seenLimit: string | null = null;

    const handler = withAuth(
      async (req) => {
        seenText = await req.text();
        seenLimit = new URL(req.url).searchParams.get('limit');
        return new Response(null, { status: 204 });
      },
      { verifier: verifierReturning({ ok: true, identity: IDENTITY }) },
    );

    await handler(
      new Request('https://example.com/api/meal-plans?limit=20', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'userId=someone-else',
      }),
    );

    expect(seenText).toBe('userId=someone-else');
    expect(seenLimit).toBe('20');
  });
});
