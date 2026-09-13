// @vitest-environment node
//
// `withAuth` is server-only, and these cases drive the *real* `jose` verifier so
// that RS256 signing and verification are genuine rather than stubbed. Under the
// project-wide jsdom environment Node's `Uint8Array` and WebCrypto come from a
// different realm and the signing path rejects its own payload, so this file
// runs in the environment the code actually runs in.
//
// Property-based tests for the authenticated route wrapper.
//
// One `describe` per property, with the shared fixture helpers below at module
// scope so a later property appends without restructuring anything. The only
// thing stubbed is `fetch` — the certificate endpoint and the Identity Toolkit
// `accounts:lookup` endpoint — which is exactly the boundary Requirement 4 talks
// about. Everything inside the verifier runs for real: header decoding, the
// length guard, certificate import, signature verification, claim checks, and
// the revocation lookup.

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MealPlanRecord } from '../types';
import { newMealPlanId } from '../mealPlanId';
import {
  arbMealPlanRecord,
  arbTrickyString,
  arbUnusableToken,
  createUnusableTokenKit,
  mintAuthToken,
  UNUSABLE_TOKEN_CAUSES,
  type UnusableToken,
  type UnusableTokenKit,
} from '../../test/arbitraries';
import { CREDENTIAL_ERROR_BODY, SERVICE_UNAVAILABLE_BODY } from './apiErrors';
import {
  createInMemoryMealPlanRepository,
  type InMemoryMealPlanRepository,
} from './inMemoryMealPlanRepository';
import {
  ACCOUNTS_LOOKUP_URL,
  CERTIFICATE_URL,
  joseAuthTokenVerifier,
  resetAuthTokenVerifierCaches,
} from './joseAuthTokenVerifier';
import { withAuth } from './withAuth';
import type { AuthTokenVerifier, VerifiedIdentity } from './authTokenVerifier';

// ─── Shared fixture ────────────────────────────────────────────────────────────

const BASE_URL = 'https://crohns-buddy.test';

/** A syntactically valid Meal_Plan_Id for the id-bearing routes. */
const FIXED_MEAL_PLAN_ID = newMealPlanId(Date.UTC(2025, 0, 10, 9, 30, 0));

/**
 * One kit for the whole file. Two RSA key pairs per kit makes it far too
 * expensive to build per draw, and every credential these properties need is a
 * pure function of the kit plus the draw.
 *
 * `nowMs` is the real clock rather than a fixed instant, because the verifier
 * checks `exp` against `Date.now()` and this file deliberately runs without fake
 * timers — `fast-check`'s async runner and a faked clock do not mix well. Any
 * drift between kit construction and a request only pushes an expired credential
 * further past its expiry, which is the safe direction.
 */
const KIT: UnusableTokenKit = createUnusableTokenKit({ nowMs: Date.now() });

/** A valid record, used only so the wired handlers touch the store for real. */
const SAMPLE_RECORD: MealPlanRecord = fc.sample(arbMealPlanRecord(), 1)[0];

/** Byte-exact bodies the wrapper is allowed to produce. */
const CREDENTIAL_ERROR_BYTES = JSON.stringify(CREDENTIAL_ERROR_BODY);
const SERVICE_UNAVAILABLE_BYTES = JSON.stringify(SERVICE_UNAVAILABLE_BODY);

/**
 * One Meal_Plan_API endpoint, reduced to what these properties need: the request
 * to send, whether the route is a mutating one (so `freshRevocationCheck` is
 * set, per the design's route table), and the store operation its handler
 * performs.
 *
 * Every handler touches the repository, which is what makes "performs zero reads
 * and zero writes against the Meal_Plan_Store" an observation rather than an
 * assumption: if the wrapper ever let a handler body run, the `calls` ledger
 * would record it.
 */
interface EndpointFixture {
  name: string;
  method: string;
  path: string;
  freshRevocationCheck: boolean;
  body?: string;
  touch: (repo: InMemoryMealPlanRepository, identity: VerifiedIdentity) => Promise<void>;
}

const ENDPOINTS: readonly EndpointFixture[] = [
  {
    name: 'POST /api/meal-plans',
    method: 'POST',
    path: '/api/meal-plans',
    freshRevocationCheck: true,
    body: JSON.stringify({ mealPlan: SAMPLE_RECORD.content, title: SAMPLE_RECORD.title }),
    touch: async (repo, identity) => {
      await repo.create(identity.userId, { ...SAMPLE_RECORD, userId: identity.userId }, true);
    },
  },
  {
    name: 'GET /api/meal-plans',
    method: 'GET',
    path: '/api/meal-plans',
    freshRevocationCheck: false,
    touch: async (repo, identity) => {
      await repo.list(identity.userId);
    },
  },
  {
    name: 'GET /api/meal-plans/{mealPlanId}',
    method: 'GET',
    path: `/api/meal-plans/${FIXED_MEAL_PLAN_ID}`,
    freshRevocationCheck: false,
    touch: async (repo, identity) => {
      await repo.get(identity.userId, FIXED_MEAL_PLAN_ID);
    },
  },
  {
    name: 'PUT /api/meal-plans/{mealPlanId}',
    method: 'PUT',
    path: `/api/meal-plans/${FIXED_MEAL_PLAN_ID}`,
    freshRevocationCheck: true,
    body: JSON.stringify({ mealPlan: SAMPLE_RECORD.content }),
    touch: async (repo, identity) => {
      await repo.update(identity.userId, { ...SAMPLE_RECORD, userId: identity.userId });
    },
  },
  {
    name: 'PATCH /api/meal-plans/{mealPlanId}',
    method: 'PATCH',
    path: `/api/meal-plans/${FIXED_MEAL_PLAN_ID}`,
    freshRevocationCheck: true,
    body: JSON.stringify({ title: 'Renamed plan' }),
    touch: async (repo, identity) => {
      await repo.rename(identity.userId, FIXED_MEAL_PLAN_ID, 'Renamed plan', Date.now());
    },
  },
  {
    name: 'DELETE /api/meal-plans/{mealPlanId}',
    method: 'DELETE',
    path: `/api/meal-plans/${FIXED_MEAL_PLAN_ID}`,
    freshRevocationCheck: true,
    touch: async (repo, identity) => {
      await repo.delete(identity.userId, FIXED_MEAL_PLAN_ID);
    },
  },
  {
    // Requirement 10.8 — the export route is behind the same wrapper.
    name: 'GET /api/account/export',
    method: 'GET',
    path: '/api/account/export',
    freshRevocationCheck: true,
    touch: async (repo, identity) => {
      await repo.listAll(identity.userId);
    },
  },
  {
    name: 'POST /api/account/purge',
    method: 'POST',
    path: '/api/account/purge',
    freshRevocationCheck: true,
    body: JSON.stringify({ confirm: 'DELETE' }),
    touch: async (repo, identity) => {
      await repo.purge(identity.userId);
    },
  },
];

/** A fresh in-memory store seeded with two Accounts, so a stray read has something to find. */
function seededRepository(): InMemoryMealPlanRepository {
  const repo = createInMemoryMealPlanRepository({
    now: () => Date.now(),
    newMealPlanId: () => newMealPlanId(Date.now()),
  });
  repo.seed([
    {
      // `mealPlanId` is left as generated: the serializer asserts that the id's
      // embedded millisecond timestamp equals `createdAt`, so the pair cannot be
      // rewritten independently.
      userId: 'seeded-account-one',
      records: [{ ...SAMPLE_RECORD, userId: 'seeded-account-one' }],
      storageAckAt: new Date(Date.UTC(2025, 0, 1)).toISOString(),
    },
    { userId: 'seeded-account-two', storageAckAt: new Date(Date.UTC(2025, 0, 1)).toISOString() },
  ]);
  repo.clearCalls();
  return repo;
}

/** Sends one request through the wrapped endpoint with the supplied header. */
async function callEndpoint(
  endpoint: EndpointFixture,
  repo: InMemoryMealPlanRepository,
  authorization: string | null,
): Promise<Response> {
  const route = withAuth(
    async (_req, ctx) => {
      await endpoint.touch(repo, ctx.identity);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    {
      verifier: joseAuthTokenVerifier,
      freshRevocationCheck: endpoint.freshRevocationCheck,
    },
  );

  const headers = new Headers();
  if (authorization !== null) headers.set('authorization', authorization);
  if (endpoint.body !== undefined) headers.set('content-type', 'application/json');

  const request = new Request(`${BASE_URL}${endpoint.path}`, {
    method: endpoint.method,
    headers,
    body: endpoint.body,
  });

  return route(request, { params: { mealPlanId: FIXED_MEAL_PLAN_ID } });
}

/** Records every outbound Auth_Service request, so "no request at all" is assertable. */
interface OutboundLedger {
  urls: string[];
}

/**
 * Installs the `fetch` stub. The certificate endpoint serves the kit's real
 * certificate document; `accounts:lookup` serves whatever answer the current
 * case prescribes, which is what makes the revoked, disabled, and deleted causes
 * self-describing rather than reconstructed here.
 */
function installFetchStub(
  ledger: OutboundLedger,
  lookup: () => { status: number; body: unknown },
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: unknown) => {
      const target = String(url);
      ledger.urls.push(target);

      if (target === CERTIFICATE_URL) {
        return Promise.resolve(
          new Response(JSON.stringify(KIT.certificateDocument), {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'cache-control': 'public, max-age=3600',
            },
          }),
        );
      }

      if (target.startsWith(ACCOUNTS_LOOKUP_URL)) {
        const answer = lookup();
        return Promise.resolve(
          new Response(JSON.stringify(answer.body), {
            status: answer.status,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }

      return Promise.reject(new Error(`unexpected outbound request to ${target}`));
    }),
  );
}

// ─── Property 7 ────────────────────────────────────────────────────────────────

/**
 * **Property 7: Unusable Auth_Tokens are indistinguishable and never reach the store**
 *
 * *For any* request whose Auth_Token is absent, unparseable, signed with the
 * wrong key, expired by more than 60 seconds, longer than 8,192 characters, or
 * belongs to an Account the Auth_Service reports as removed or revoked, every
 * Meal_Plan_API endpoint responds with HTTP 401 and identical response body
 * bytes across all of those causes, and performs zero reads and zero writes
 * against the Meal_Plan_Store.
 *
 * **Validates: Requirements 4.2, 4.3, 4.6, 4.7, 10.8**
 */
describe('Property 7: unusable Auth_Tokens are indistinguishable and never reach the store', () => {
  /** Every distinct response body observed. A passing run leaves exactly one. */
  let observedBodies: Set<string>;
  /** Every cause actually exercised, so a vacuous run is visible. */
  let observedCauses: Set<string>;
  let ledger: OutboundLedger;
  /** The lookup answer for the case in flight, swapped per draw. */
  let currentLookup: { status: number; body: unknown };

  beforeEach(() => {
    resetAuthTokenVerifierCaches();
    observedBodies = new Set<string>();
    observedCauses = new Set<string>();
    ledger = { urls: [] };
    currentLookup = { status: 200, body: { users: [] } };

    vi.stubEnv('NEXT_PUBLIC_FIREBASE_PROJECT_ID', KIT.projectId);
    vi.stubEnv('NEXT_PUBLIC_FIREBASE_API_KEY', KIT.apiKey);
    vi.stubEnv('NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN', `${KIT.projectId}.firebaseapp.com`);
    // The verifier emits one warning line only when the Auth_Service is
    // unreachable, which no case here provokes; silenced so a regression that
    // does provoke it cannot hide in the suite output.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    installFetchStub(ledger, () => currentLookup);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetAuthTokenVerifierCaches();
  });

  it('answers 401 with byte-identical bodies and never touches the Meal_Plan_Store', async () => {
    await fc.assert(
      fc.asyncProperty(arbUnusableToken(KIT), async (unusable: UnusableToken) => {
        observedCauses.add(unusable.cause);
        currentLookup = unusable.lookupResponse;

        const repo = seededRepository();
        const before = repo.snapshot();
        ledger.urls.length = 0;

        for (const endpoint of ENDPOINTS) {
          const response = await callEndpoint(endpoint, repo, unusable.authorization);
          const body = await response.text();
          observedBodies.add(body);

          const where = `${endpoint.name} / ${unusable.cause}: ${unusable.detail}`;

          // Requirements 4.2, 4.3, 4.6, 4.7, 10.8 — one status for every cause.
          expect(response.status, where).toBe(401);

          // The bytes are the frozen constant's bytes, for every cause and every
          // endpoint. Nothing in the response separates an absent credential
          // from a bad signature from a revoked Session.
          expect(body, where).toBe(CREDENTIAL_ERROR_BYTES);
          expect(body, where).not.toBe(SERVICE_UNAVAILABLE_BYTES);

          // Headers are part of what must not vary between causes.
          expect(response.headers.get('content-type'), where).toBe('application/json');
          expect(response.headers.get('www-authenticate'), where).toBe('Bearer');

          // Zero reads and zero writes. The ledger records an attempted
          // operation before its conditions are evaluated, so even a rejected
          // write would appear here.
          expect(repo.calls, where).toEqual([]);
        }

        // The store is byte-for-byte what it was before the eight requests.
        expect(repo.snapshot()).toBe(before);

        // Requirement 4.7: an over-length credential is rejected on length
        // alone, and every other pre-network cause likewise reaches no
        // Auth_Service endpoint at all.
        if (!unusable.reachesAuthService) {
          expect(ledger.urls, `${unusable.cause}: ${unusable.detail}`).toEqual([]);
        }
      }),
      { numRuns: 120 },
    );

    // Across every cause and every endpoint, exactly one response body existed.
    expect(Array.from(observedBodies)).toEqual([CREDENTIAL_ERROR_BYTES]);
    // And the run was not vacuous: all ten causes were exercised.
    expect(Array.from(observedCauses).sort()).toEqual([...UNUSABLE_TOKEN_CAUSES].sort());
  });

  it('reaches the store with a usable Auth_Token, so the rejections above are not vacuous', async () => {
    const userId = 'control-account';
    const authTimeMs = KIT.nowMs - 60_000;
    const token = mintAuthToken(KIT, {
      claims: {
        sub: userId,
        authTimeMs,
        issuedAtMs: authTimeMs,
        expiresAtMs: KIT.nowMs + 60 * 60 * 1000,
      },
    });
    currentLookup = {
      status: 200,
      body: {
        users: [
          {
            localId: userId,
            disabled: false,
            validSince: String(Math.floor(authTimeMs / 1000) - 60),
          },
        ],
      },
    };

    const repo = seededRepository();
    const listEndpoint = ENDPOINTS.find((e) => e.name === 'GET /api/meal-plans');
    expect(listEndpoint).toBeDefined();

    const response = await callEndpoint(listEndpoint!, repo, `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(repo.calls).toEqual([{ op: 'list', access: 'read', userId }]);
  });
});

// ─── Property 8 ────────────────────────────────────────────────────────────────

/**
 * The wrapper's own rule for what counts as a supplied User_Id, restated here so
 * the test asserts the spelling-insensitive contract rather than trusting the
 * implementation's private helper: lowercase, drop `_` and `-`, compare.
 */
function looksLikeUserIdKey(key: string): boolean {
  return key.toLowerCase().replace(/[_-]/g, '') === 'userid';
}

/** Spellings a caller might reach for. Every one of them must be stripped. */
const USER_ID_KEY_SPELLINGS = [
  'userId',
  'userid',
  'user_id',
  'USER-ID',
  'User_Id',
  'USERID',
] as const;

/** A query parameter that carries no User_Id, so stripping can be shown to be surgical. */
const BENIGN_QUERY_KEY = 'sort';
const BENIGN_QUERY_VALUE = 'recent';

/** How the ordering case presents its credential. */
type OrderingCredential = 'usable' | 'absent' | 'wrong-key';

const ORDERING_CREDENTIALS: readonly OrderingCredential[] = ['usable', 'absent', 'wrong-key'];

/**
 * Subjects for the minted credentials. Tricky by default, because a User_Id is
 * an opaque string the Auth_Service chooses and it travels through a JWT
 * payload, a query string, a JSON body, and a partition key on the way to the
 * store — every one of which is a place a non-ASCII value could be mangled.
 */
function arbUserId(): fc.Arbitrary<string> {
  return arbTrickyString(1, 40);
}

/** What the handler could see of the request, recorded rather than asserted inline. */
interface HandlerObservation {
  identityUserId: string;
  queryKeys: string[];
  benignQueryValue: string | null;
  paramKeys: string[];
  mealPlanIdParam: string | null;
  /** Top-level body keys, or `null` when the request carried no JSON body. */
  bodyKeys: string[] | null;
}

/**
 * **Property 8: Verification precedes store access and the derived User_Id is authoritative**
 *
 * *For any* request to the Meal_Plan_API, no read or write reaches the
 * Meal_Plan_Store before Auth_Token verification resolves, and *for any* User_Id
 * value supplied in the request body, query string, or path — including a value
 * differing from the verified one — every store operation is performed against
 * the User_Id derived from the verified token and the request completes without
 * reporting an error about the mismatch.
 *
 * **Validates: Requirements 4.1, 4.4**
 */
describe('Property 8: verification precedes store access and the derived User_Id is authoritative', () => {
  let ledger: OutboundLedger;
  /** The `accounts:lookup` answer for the case in flight, swapped per draw. */
  let currentLookup: { status: number; body: unknown };

  beforeEach(() => {
    resetAuthTokenVerifierCaches();
    ledger = { urls: [] };
    currentLookup = { status: 200, body: { users: [] } };

    vi.stubEnv('NEXT_PUBLIC_FIREBASE_PROJECT_ID', KIT.projectId);
    vi.stubEnv('NEXT_PUBLIC_FIREBASE_API_KEY', KIT.apiKey);
    vi.stubEnv('NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN', `${KIT.projectId}.firebaseapp.com`);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    installFetchStub(ledger, () => currentLookup);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetAuthTokenVerifierCaches();
  });

  /** How long before "now" the Patient authenticated, matching the kit's own default. */
  const AUTH_AGE_MS = 60_000;

  /** An `accounts:lookup` answer that accepts `userId`: present, enabled, not revoked. */
  function acceptLookup(userId: string): { status: number; body: unknown } {
    const authTimeMs = KIT.nowMs - AUTH_AGE_MS;
    return {
      status: 200,
      body: {
        users: [
          {
            localId: userId,
            disabled: false,
            validSince: String(Math.floor(authTimeMs / 1000) - 60),
          },
        ],
      },
    };
  }

  /** A credential the real verifier accepts, carrying `userId` as its `sub`. */
  function usableAuthorization(userId: string): string {
    const authTimeMs = KIT.nowMs - AUTH_AGE_MS;
    return `Bearer ${mintAuthToken(KIT, {
      claims: {
        sub: userId,
        authTimeMs,
        issuedAtMs: authTimeMs,
        expiresAtMs: KIT.nowMs + 60 * 60 * 1000,
      },
    })}`;
  }

  /** A credential signed by a key nothing published, so verification rejects it. */
  function wrongKeyAuthorization(userId: string): string {
    const authTimeMs = KIT.nowMs - AUTH_AGE_MS;
    return `Bearer ${mintAuthToken(KIT, {
      claims: {
        sub: userId,
        authTimeMs,
        issuedAtMs: authTimeMs,
        expiresAtMs: KIT.nowMs + 60 * 60 * 1000,
      },
      signWith: 'wrong',
    })}`;
  }

  // ── Part 1: verification resolves before any store access ────────────────────

  /**
   * Drives one endpoint through a verifier that watches the store while it works.
   *
   * The instrumentation is what turns "the wrapper awaits the verifier" from a
   * reading of the source into an observation: the verifier deliberately holds
   * the request across several event-loop turns and asserts the repository
   * ledger is still empty when it finally answers. A wrapper that started the
   * handler without awaiting — or that pre-warmed a read before verifying —
   * would have recorded a call by then. The `events` ledger then pins the
   * relative order of the answer and the first store access.
   */
  async function runOrdered(
    endpoint: EndpointFixture,
    repo: InMemoryMealPlanRepository,
    authorization: string | null,
  ): Promise<{ events: string[]; status: number; body: string }> {
    const events: string[] = [];

    const watchingVerifier: AuthTokenVerifier = {
      async verifyAuthToken(req, opts) {
        events.push('verify:start');
        // Nothing may have reached the store before verification even began.
        expect(repo.calls, 'the store was touched before verification started').toEqual([]);

        // Hold the request across several turns of the event loop. Anything the
        // wrapper kicked off without awaiting would land inside this window.
        for (let turn = 0; turn < 3; turn += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }

        const result = await joseAuthTokenVerifier.verifyAuthToken(req, opts);
        expect(repo.calls, 'the store was touched while verification was pending').toEqual([]);

        events.push('verify:resolved');
        return result;
      },
    };

    const route = withAuth(
      async (_req, ctx) => {
        events.push('handler:start');
        await endpoint.touch(repo, ctx.identity);
        events.push('store:done');
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      { verifier: watchingVerifier, freshRevocationCheck: endpoint.freshRevocationCheck },
    );

    const headers = new Headers();
    if (authorization !== null) headers.set('authorization', authorization);
    if (endpoint.body !== undefined) headers.set('content-type', 'application/json');

    const request = new Request(`${BASE_URL}${endpoint.path}`, {
      method: endpoint.method,
      headers,
      body: endpoint.body,
    });

    const response = await route(request, { params: { mealPlanId: FIXED_MEAL_PLAN_ID } });
    return { events, status: response.status, body: await response.text() };
  }

  it('resolves verification before any store access, whatever the credential', async () => {
    const seenEndpoints = new Set<string>();
    const seenCredentials = new Set<string>();

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ENDPOINTS),
        fc.constantFrom(...ORDERING_CREDENTIALS),
        arbUserId(),
        async (endpoint, credential, userId) => {
          seenEndpoints.add(endpoint.name);
          seenCredentials.add(credential);

          currentLookup = acceptLookup(userId);
          const authorization =
            credential === 'absent'
              ? null
              : credential === 'usable'
                ? usableAuthorization(userId)
                : wrongKeyAuthorization(userId);

          const repo = seededRepository();
          const before = repo.snapshot();

          const { events, status, body } = await runOrdered(endpoint, repo, authorization);
          const where = `${endpoint.name} / ${credential}`;

          // Requirement 4.1 — verification is the first thing that happens, and
          // it resolves before anything else does.
          expect(events.slice(0, 2), where).toEqual(['verify:start', 'verify:resolved']);

          const resolvedAt = events.indexOf('verify:resolved');
          const storeAt = events.indexOf('store:done');

          if (credential === 'usable') {
            // The handler ran, and it ran strictly after the answer arrived.
            expect(status, where).toBe(200);
            expect(events, where).toEqual([
              'verify:start',
              'verify:resolved',
              'handler:start',
              'store:done',
            ]);
            expect(storeAt, where).toBeGreaterThan(resolvedAt);

            // Exactly one store operation, against the derived User_Id.
            expect(repo.calls.length, where).toBe(1);
            expect(repo.calls[0]?.userId, where).toBe(userId);
          } else {
            // Verification resolved and the request stopped there: no handler
            // body, no store access, nothing moved.
            expect(status, where).toBe(401);
            expect(body, where).toBe(CREDENTIAL_ERROR_BYTES);
            expect(events, where).toEqual(['verify:start', 'verify:resolved']);
            expect(repo.calls, where).toEqual([]);
            expect(repo.snapshot(), where).toBe(before);
          }
        },
      ),
      { numRuns: 60 },
    );

    // Not vacuous: every endpoint and every credential kind was exercised.
    expect(seenEndpoints.size).toBe(ENDPOINTS.length);
    expect(Array.from(seenCredentials).sort()).toEqual([...ORDERING_CREDENTIALS].sort());
  });

  // ── Part 2: the derived User_Id is authoritative ─────────────────────────────

  /**
   * Sends one request that supplies `suppliedUserId` in the body, the query
   * string, and the route params, under `spelling` as well as the canonical
   * `userId`, and records everything the handler could see.
   *
   * The handler is the observation point on purpose: Requirement 4.4 is not
   * "the handler ignores a supplied User_Id" but "a supplied User_Id is not
   * reachable", and the only way to tell those apart is to look from inside.
   */
  async function callWithSuppliedUserId(
    endpoint: EndpointFixture,
    repo: InMemoryMealPlanRepository,
    authorization: string,
    suppliedUserId: string,
    spelling: string,
  ): Promise<{ status: number; body: string; observation: HandlerObservation | null }> {
    let observation: HandlerObservation | null = null;

    const route = withAuth(
      async (req, ctx) => {
        const url = new URL(req.url);
        const method = req.method.toUpperCase();
        const text = method === 'GET' || method === 'HEAD' ? '' : await req.text();

        let bodyKeys: string[] | null = null;
        if (text !== '') {
          try {
            const parsed: unknown = JSON.parse(text);
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
              bodyKeys = Object.keys(parsed as Record<string, unknown>);
            }
          } catch {
            bodyKeys = null;
          }
        }

        observation = {
          identityUserId: ctx.identity.userId,
          queryKeys: Array.from(url.searchParams.keys()),
          benignQueryValue: url.searchParams.get(BENIGN_QUERY_KEY),
          paramKeys: Object.keys(ctx.params),
          mealPlanIdParam: ctx.params.mealPlanId ?? null,
          bodyKeys,
        };

        // The handler's only route to a User_Id is the derived one.
        await endpoint.touch(repo, ctx.identity);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      { verifier: joseAuthTokenVerifier, freshRevocationCheck: endpoint.freshRevocationCheck },
    );

    const url = new URL(`${BASE_URL}${endpoint.path}`);
    url.searchParams.set(BENIGN_QUERY_KEY, BENIGN_QUERY_VALUE);
    url.searchParams.set('userId', suppliedUserId);
    url.searchParams.set(spelling, suppliedUserId);

    const headers = new Headers();
    headers.set('authorization', authorization);

    let body: string | undefined;
    if (endpoint.body !== undefined) {
      const original = JSON.parse(endpoint.body) as Record<string, unknown>;
      body = JSON.stringify({ ...original, userId: suppliedUserId, [spelling]: suppliedUserId });
      headers.set('content-type', 'application/json');
    }

    const request = new Request(url.toString(), { method: endpoint.method, headers, body });

    const response = await route(request, {
      // A supplied User_Id in the path segment too (Requirement 4.4).
      params: { mealPlanId: FIXED_MEAL_PLAN_ID, userId: suppliedUserId, [spelling]: suppliedUserId },
    });

    return { status: response.status, body: await response.text(), observation };
  }

  it('confines every store operation to the derived User_Id and reports no mismatch', async () => {
    const seenEndpoints = new Set<string>();
    const seenSpellings = new Set<string>();
    /** Whether the "supplied happens to equal the derived id" case was drawn. */
    let sawMatchingSupplied = false;
    /** Whether the "supplied names a real other Account" case was drawn. */
    let sawForeignAccount = false;

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ENDPOINTS),
        arbUserId(),
        fc.oneof(
          { weight: 3, arbitrary: arbUserId() },
          // Naming an Account that genuinely exists in the store, so a leak
          // would land in a partition whose contents are being watched.
          { weight: 1, arbitrary: fc.constantFrom('seeded-account-one', 'seeded-account-two') },
        ),
        // 0 means "supply the derived id itself", which must behave no
        // differently from supplying a foreign one.
        fc.integer({ min: 0, max: 4 }),
        fc.constantFrom(...USER_ID_KEY_SPELLINGS),
        async (endpoint, derivedUserId, candidate, sameDraw, spelling) => {
          const suppliedUserId = sameDraw === 0 ? derivedUserId : candidate;
          seenEndpoints.add(endpoint.name);
          seenSpellings.add(spelling);
          if (suppliedUserId === derivedUserId) sawMatchingSupplied = true;
          if (suppliedUserId.startsWith('seeded-account-')) sawForeignAccount = true;

          currentLookup = acceptLookup(derivedUserId);

          const repo = seededRepository();
          const suppliedBefore = repo.snapshotPartition(suppliedUserId);

          const { status, body, observation } = await callWithSuppliedUserId(
            endpoint,
            repo,
            usableAuthorization(derivedUserId),
            suppliedUserId,
            spelling,
          );

          const where = `${endpoint.name} / supplied under "${spelling}"`;

          // The request completes normally. Nothing reports the mismatch: no
          // 4xx, and the body is the handler's own success payload.
          expect(status, where).toBe(200);
          expect(body, where).toBe(JSON.stringify({ ok: true }));
          expect(body, where).not.toBe(CREDENTIAL_ERROR_BYTES);

          const seen = observation;
          expect(seen, where).not.toBeNull();
          if (seen === null) return;

          // Requirement 4.4 — the derived id is the one the handler holds, and
          // the supplied one is not reachable from body, query, or params.
          expect(seen.identityUserId, where).toBe(derivedUserId);
          expect(seen.queryKeys.filter(looksLikeUserIdKey), where).toEqual([]);
          expect(seen.paramKeys.filter(looksLikeUserIdKey), where).toEqual([]);
          expect((seen.bodyKeys ?? []).filter(looksLikeUserIdKey), where).toEqual([]);

          // Stripping is surgical: everything else survives untouched.
          expect(seen.benignQueryValue, where).toBe(BENIGN_QUERY_VALUE);
          expect(seen.mealPlanIdParam, where).toBe(FIXED_MEAL_PLAN_ID);
          if (endpoint.body !== undefined) {
            const originalKeys = Object.keys(JSON.parse(endpoint.body) as Record<string, unknown>);
            expect(seen.bodyKeys, where).not.toBeNull();
            expect([...(seen.bodyKeys ?? [])].sort(), where).toEqual([...originalKeys].sort());
          }

          // Every store operation ran against the derived User_Id — and the
          // handler did reach the store, so this is not vacuous.
          expect(repo.calls.length, where).toBeGreaterThan(0);
          for (const call of repo.calls) {
            expect(call.userId, `${where} / ${call.op}`).toBe(derivedUserId);
          }

          // The supplied partition is byte-for-byte what it was, whenever it is
          // a partition other than the derived one.
          if (suppliedUserId !== derivedUserId) {
            expect(repo.snapshotPartition(suppliedUserId), where).toBe(suppliedBefore);
          }
        },
      ),
      { numRuns: 80 },
    );

    // Not vacuous: every endpoint, every spelling, and both the matching and the
    // real-other-Account supplied values were exercised.
    expect(seenEndpoints.size).toBe(ENDPOINTS.length);
    expect(Array.from(seenSpellings).sort()).toEqual([...USER_ID_KEY_SPELLINGS].sort());
    expect(sawMatchingSupplied).toBe(true);
    expect(sawForeignAccount).toBe(true);
  });
});
