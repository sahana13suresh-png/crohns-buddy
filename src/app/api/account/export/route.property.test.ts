// @vitest-environment node
//
// Property-based test for the Account_Data_Export document.
//
// Feature: user-auth-and-cloud-storage, Property 13.
//
// Every half of the property is answered against the *emitted bytes*, never
// against key names. Records arrive from `arbMarkedRecord()`, so "every record
// the Account owns is present" and "no record from another Account is present"
// are both questions about specific marker strings appearing or not appearing in
// the serialized document — an export that nested a record one level deeper, or
// renamed a key, could not slip past.
//
// Credentials are marked the same way and planted everywhere a handler could
// plausibly pick them up: the `Authorization` header, the query string, and
// extra fields hung off the object the verifier resolves. The last of those is
// the one that matters most — it is what fails if the document is ever built by
// spreading the identity instead of naming its four fields.
//
// `accountExport.ts` is imported rather than `route.ts`: a Next.js `route.ts`
// may export only HTTP method names and the segment config, so the handler
// factory and the document shape live beside it.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { newMealPlanId } from '@/lib/mealPlanId';
import type { MealPlanRecord } from '@/lib/types';
import type {
  AuthTokenVerifier,
  VerifiedIdentity,
} from '@/lib/server/authTokenVerifier';
import {
  createInMemoryMealPlanRepository,
  type InMemoryMealPlanRepository,
} from '@/lib/server/inMemoryMealPlanRepository';
import { arbMarkedRecord, type MarkedMealPlanRecord } from '@/test/arbitraries';

import {
  buildAccountDataExport,
  createExportRoute,
  type AccountDataExport,
} from './accountExport';

const BASE_URL = 'https://crohns-buddy.test';
const OWNER = 'account-under-test';

/** The five keys Requirement 10.2 names for the server half of the document. */
const DOCUMENT_KEYS = ['accountCreatedAt', 'displayName', 'email', 'mealPlans', 'userId'];

// ─── Generators ────────────────────────────────────────────────────────────────

/** Record counts biased toward the empty case, which Requirement 10.3 governs. */
const arbRecordCount = fc.oneof(
  { weight: 1, arbitrary: fc.constant(0) },
  { weight: 4, arbitrary: fc.integer({ min: 1, max: 5 }) },
);

/**
 * One other Account holding records of its own. Its User_Id is deliberately
 * unrelated to the owner's, so a leak is unambiguous.
 */
const arbOtherAccount = fc
  .tuple(
    fc.integer({ min: 0, max: 0xffff }),
    fc.array(arbMarkedRecord(), { minLength: 1, maxLength: 2 }),
  )
  .map(([suffix, marked]: [number, MarkedMealPlanRecord[]]) => ({
    userId: `other-account-${suffix.toString(16)}`,
    marked,
  }));

/**
 * Identity fields and the credential values planted around the request. Both
 * sets are marker strings: the identity markers must appear in the document, the
 * credential markers must not.
 */
const arbIdentityCase = fc.integer({ min: 0, max: 0x7fff_ffff }).chain((seed) =>
  fc.record({
    tag: fc.constant(seed.toString(16).padStart(8, '0')),
    /** Absent exercises the `accountCreatedAt: null` branch (Requirement 10.3). */
    accountCreatedAtMs: fc.option(
      fc.integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2030, 0, 1) }),
      { nil: undefined },
    ),
  }),
);

const arbNowMs = fc.integer({ min: Date.UTC(2024, 0, 1), max: Date.UTC(2035, 0, 1) });

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Drops records sharing a Meal_Plan_Id, keeping the first. Two records with the
 * same key are one record in the store, so the expected set has to agree.
 */
function distinctById(marked: MarkedMealPlanRecord[]): MarkedMealPlanRecord[] {
  const seen = new Set<string>();
  return marked.filter(({ record }) => {
    if (seen.has(record.mealPlanId)) return false;
    seen.add(record.mealPlanId);
    return true;
  });
}

/** The record as the store owns it: the partition key wins over the record's claim. */
function ownedBy(userId: string, record: MealPlanRecord): MealPlanRecord {
  return { ...record, userId };
}

/** `crohns-buddy-export-YYYY-MM-DD.json`, derived independently of the module. */
function expectedFileName(nowMs: number): string {
  const at = new Date(nowMs);
  const year = String(at.getUTCFullYear()).padStart(4, '0');
  const month = String(at.getUTCMonth() + 1).padStart(2, '0');
  const day = String(at.getUTCDate()).padStart(2, '0');
  return `crohns-buddy-export-${year}-${month}-${day}.json`;
}

function seededRepository(
  seeds: { userId: string; records: MealPlanRecord[] }[],
  nowMs: number,
): InMemoryMealPlanRepository {
  const repo = createInMemoryMealPlanRepository({
    now: () => nowMs,
    newMealPlanId: () => newMealPlanId(nowMs),
  });
  repo.seed(
    seeds.map(({ userId, records }) => ({
      userId,
      records,
      storageAckAt: new Date(nowMs).toISOString(),
    })),
  );
  repo.clearCalls();
  return repo;
}

/**
 * A verifier resolving to `identity`, with credential-shaped extra fields hung
 * off the resolved object. They are unreachable through `VerifiedIdentity`, which
 * is the point: only a handler that spread the identity would emit them.
 */
function verifierResolving(
  identity: VerifiedIdentity,
  credentials: Record<string, string>,
): AuthTokenVerifier {
  return {
    verifyAuthToken: () =>
      Promise.resolve({
        ok: true as const,
        identity: { ...identity, ...credentials } as VerifiedIdentity,
      }),
  };
}

// ─── Property 13 ───────────────────────────────────────────────────────────────

describe('Property 13: Export is complete, account-scoped, and free of credentials', () => {
  it('exports every owned record, nothing from another Account, and no credential', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbRecordCount.chain((count) =>
          fc.array(arbMarkedRecord(), { minLength: count, maxLength: count }),
        ),
        fc.array(arbOtherAccount, { minLength: 0, maxLength: 3 }),
        arbIdentityCase,
        arbNowMs,
        async (ownerMarked, otherAccounts, identityCase, nowMs) => {
          const owned = distinctById(ownerMarked);
          const ownedRecords = owned.map(({ record }) => ownedBy(OWNER, record));

          const others = otherAccounts.map(({ userId, marked }) => ({
            userId,
            marked: distinctById(marked),
          }));

          const repo = seededRepository(
            [
              { userId: OWNER, records: ownedRecords },
              ...others.map(({ userId, marked }) => ({
                userId,
                records: marked.map(({ record }) => ownedBy(userId, record)),
              })),
            ],
            nowMs,
          );

          const email = `MARKER-${identityCase.tag}-email@example.test`;
          const displayName = `MARKER-${identityCase.tag}-displayName`;
          const identity: VerifiedIdentity = {
            userId: OWNER,
            authTimeMs: nowMs - 60_000,
            email,
            displayName,
            ...(identityCase.accountCreatedAtMs === undefined
              ? {}
              : { accountCreatedAtMs: identityCase.accountCreatedAtMs }),
          };

          const credentialValues = {
            password: `CREDENTIAL-${identityCase.tag}-password`,
            authToken: `CREDENTIAL-${identityCase.tag}-authToken`,
            providerCredential: `CREDENTIAL-${identityCase.tag}-providerCredential`,
          };

          // Every credential also travels on the request itself.
          const url = new URL(`${BASE_URL}/api/account/export`);
          url.searchParams.set('password', credentialValues.password);
          url.searchParams.set('idToken', credentialValues.authToken);
          url.searchParams.set('providerCredential', credentialValues.providerCredential);
          url.searchParams.set('userId', others[0]?.userId ?? 'someone-else');

          const handler = createExportRoute({
            repository: repo,
            verifier: verifierResolving(identity, credentialValues),
            now: () => nowMs,
          });
          const response = await handler(
            new Request(url, {
              method: 'GET',
              headers: { authorization: `Bearer ${credentialValues.authToken}` },
            }),
            { params: {} },
          );

          expect(response.status).toBe(200);

          const body = await response.text();
          const document = JSON.parse(body) as AccountDataExport;

          // ── The four identity fields, from the verified claims only (10.2, 10.5)
          expect(Object.keys(document).sort()).toEqual(DOCUMENT_KEYS);
          expect(document.userId).toBe(OWNER);
          expect(document.email).toBe(email);
          expect(document.displayName).toBe(displayName);
          expect(document.accountCreatedAt).toBe(
            identityCase.accountCreatedAtMs === undefined
              ? null
              : new Date(identityCase.accountCreatedAtMs).toISOString(),
          );

          // ── Completeness, unpaged (10.2)
          expect(document.mealPlans).toHaveLength(ownedRecords.length);
          expect([...document.mealPlans].map((r) => r.mealPlanId).sort()).toEqual(
            ownedRecords.map((r) => r.mealPlanId).sort(),
          );
          for (const expected of ownedRecords) {
            const actual = document.mealPlans.find(
              (r) => r.mealPlanId === expected.mealPlanId,
            );
            expect(actual).toEqual(expected);
          }
          // Every marker of every owned record reached the document.
          for (const marker of owned.flatMap(({ markers }) => markers)) {
            expect(body).toContain(marker);
          }

          // ── Absent collections are empty, never omitted (10.3)
          expect('mealPlans' in document).toBe(true);
          expect(Array.isArray(document.mealPlans)).toBe(true);
          expect('accountCreatedAt' in document).toBe(true);

          // ── Account scoping (10.5)
          expect(document.mealPlans.every((r) => r.userId === OWNER)).toBe(true);
          const ownerMarkers = new Set(owned.flatMap(({ markers }) => markers));
          for (const { userId, marked } of others) {
            expect(body).not.toContain(userId);
            for (const marker of marked.flatMap(({ markers }) => markers)) {
              // A marker generated for both partitions is not evidence of a leak.
              if (ownerMarkers.has(marker)) continue;
              expect(body).not.toContain(marker);
            }
          }
          // One unpaged read, confined to the derived User_Id (10.2, 10.5).
          expect(repo.calls).toEqual([{ op: 'listAll', access: 'read', userId: OWNER }]);

          // ── No credential anywhere in the document (10.6)
          for (const credential of Object.values(credentialValues)) {
            expect(body).not.toContain(credential);
          }

          // ── The delivered file name carries the UTC date of production (10.4)
          expect(response.headers.get('content-disposition')).toBe(
            `attachment; filename="${expectedFileName(nowMs)}"`,
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it('builds the document from the identity field by field, never by spreading it', () => {
    fc.assert(
      fc.property(arbIdentityCase, arbMarkedRecord(), (identityCase, marked) => {
        const credentials = {
          password: `CREDENTIAL-${identityCase.tag}-password`,
          authToken: `CREDENTIAL-${identityCase.tag}-authToken`,
          providerCredential: `CREDENTIAL-${identityCase.tag}-providerCredential`,
        };
        const identity = {
          userId: OWNER,
          authTimeMs: 0,
          email: `MARKER-${identityCase.tag}-email@example.test`,
          displayName: `MARKER-${identityCase.tag}-displayName`,
          ...(identityCase.accountCreatedAtMs === undefined
            ? {}
            : { accountCreatedAtMs: identityCase.accountCreatedAtMs }),
          ...credentials,
        } as VerifiedIdentity;

        const document = buildAccountDataExport(identity, [ownedBy(OWNER, marked.record)]);
        const serialized = JSON.stringify(document);

        expect(Object.keys(document).sort()).toEqual(DOCUMENT_KEYS);
        // `authTimeMs` is a claim, not export data: it is not in the shape either.
        for (const credential of Object.values(credentials)) {
          expect(serialized).not.toContain(credential);
        }
      }),
      { numRuns: 100 },
    );
  });
});
