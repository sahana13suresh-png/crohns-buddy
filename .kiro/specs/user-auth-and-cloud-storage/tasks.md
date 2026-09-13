# Implementation Plan: User Auth and Cloud Storage

## Overview

Implementation follows the design's layering strictly: pure domain modules first (no I/O, no clock, no randomness except through injected parameters), then the repository and verifier ports, then the adapters that touch the network, then the thin route handlers, then the browser UI, and finally the committed deployment artifacts.

The ordering is deliberate. Every property-based test in the design targets either a pure function or a port, so the in-memory repository lands before the DynamoDB adapter and serves as the model for the model-based properties. Route handlers are written only once `withAuth` exists, so the verify-then-derive order in Requirement 4.1 cannot be bypassed by a new route. All 23 correctness properties from the design are assigned to a sub-task, placed as close to the implementation they check as the dependency order allows.

Language: TypeScript, matching the existing codebase. Test tooling: Vitest with jsdom plus `fast-check`, both already present.

## Tasks

- [x] 1. Foundation — dependencies, domain types, environment validation, generators

  - [x] 1.1 Add pinned runtime and test dependencies to `package.json`
    - Add exact-pinned runtime deps: `"@aws-sdk/client-dynamodb": "3.744.0"`, `"@aws-sdk/lib-dynamodb": "3.744.0"`, `"jose": "5.9.6"`, `"ulid": "2.3.0"` (no `^`, no `~`, per the design's "all pinned to exact versions")
    - Add dev dep `"aws-sdk-client-mock": "4.1.0"` for the adapter command assertions
    - Do NOT add `firebase-admin` — Decision 2 excludes it from the server bundle (Requirement 13.13)
    - Run `npm install` and confirm `npm run build` still succeeds
    - _Requirements: 13.13_

  - [x] 1.2 Add Meal_Plan domain types to `src/lib/types.ts`
    - Append `MealPlanItemEntry`, `MealEntry`, `MealPlanContent`, `MealPlanRecord`, `MealPlanSummary`, and `PendingDeletion` exactly as specified in the design's Domain types section, including the bound comments
    - `content` mirrors the existing `MealPlanResponse['mealPlan']` shape so `MealPlanDisplay` can render a stored plan unchanged
    - `notes` and `warnings` are declared optional (`?:`) — absent means absent, never `''` or `[]`
    - Leave every existing export in the file untouched
    - _Requirements: 6.4, 7.1, 9.1, 9.4, 9.7_

  - [x] 1.3 Create `src/lib/server/env.ts` with `assertServerEnv`
    - Define the `CredentialGroup` union (`'AUTH_SERVICE' | 'AI_INFERENCE' | 'MEAL_PLAN_STORE'`) and the `REQUIRED` record exactly as listed in the design
    - `assertServerEnv(groups)` throws an error naming *every* credential group that has at least one absent variable
    - No default value, no placeholder, no fallback for any absent variable
    - Treat an empty-string value as absent
    - _Requirements: 13.7, 13.11_

  - [x]* 1.4 Write property test for credential-group validation
    - **Property 19: Credential-group validation fails startup naming every missing group**
    - **Validates: Requirements 13.11**
    - File: `src/lib/server/env.property.test.ts`

  - [x] 1.5 Create core test generators in `src/test/arbitraries.ts`
    - `arbTrickyString(min, max)` drawing from ASCII, Latin-1 accents, CJK, emoji with surrogate pairs, combining marks, RTL text, `\n`, `\r\n`, `\t`, `'`, `"`, backslashes, and `${}`-looking sequences
    - `arbMealPlanRecord()` respecting every bound in Requirement 9.7, biased toward the boundaries (1 and 10 meals, 1 and 20 items, 0 and 20 warnings) and toward all four present/absent combinations of `notes` and `warnings`
    - `arbInvalidMealPlanRecord()` returning `{ record, brokenField }` where exactly one bound is violated
    - _Requirements: 9.6, 9.7_

- [x] 2. Pure domain layer — id, title, serializer, cursor

  - [x] 2.1 Create `src/lib/mealPlanId.ts`
    - `newMealPlanId(nowMs: number): string` producing a 26-character Crockford base-32 ULID via the injected timestamp, never calling `Date.now()` directly
    - `isValidMealPlanId(id: unknown): boolean` accepting only non-empty strings of at most 64 characters containing solely letters, digits, and hyphens — so `#meta` and `PENDING#DELETION` are rejected before any store access
    - `mealPlanIdTimestampMs(id: string): number` extracting the leading 48-bit millisecond timestamp
    - _Requirements: 6.2, 7.1, 7.8_

  - [x]* 2.2 Write unit tests for `mealPlanId`
    - Charset and length boundaries: empty, 64 characters, 65 characters, `#meta`, `PENDING#DELETION`, lowercase, underscore
    - Lexicographic ordering of ids generated at increasing timestamps
    - _Requirements: 7.8_

  - [x] 2.3 Create `src/lib/mealPlanTitle.ts`
    - `normalizeTitle(supplied: string | undefined, createdAtMs: number): string` — trim, default to `Meal plan — YYYY-MM-DD` from the UTC creation date when absent or whitespace-only, truncate to the first 100 characters using `Array.from(...).slice(0, 100)` (code points, per Open Technical Decision 2)
    - `validateRenameTitle(supplied: string): { ok: true; title: string } | { ok: false }` rejecting a trimmed value that is empty or over 100 characters, for client-side rejection before any request
    - Never returns an empty string, never returns more than 100 code points
    - _Requirements: 5.5, 5.6, 5.14, 8.4, 8.6_

  - [x]* 2.4 Write property test for title normalization
    - **Property 9: Title normalization trims, defaults, and truncates**
    - **Validates: Requirements 5.5, 5.6, 5.14, 8.4, 8.6**
    - File: `src/lib/mealPlanTitle.property.test.ts`

  - [x] 2.5 Create `src/lib/mealPlanSerializer.ts`
    - `serializeMealPlanRecord(record): MealPlanItem` and `deserializeMealPlanItem(item: unknown): MealPlanRecord`
    - `MealPlanValidationError(field, bound)` and `MealPlanItemError(attribute, reason)` exactly as designed, each naming the offending field or attribute path
    - `serializedByteLength(item): number` measuring UTF-8 bytes for the 100 KB check
    - Every collection is an `L` list — no `SS`, `NS`, or `BS` anywhere; add an assertion test that no set type appears in a produced item
    - Omit `notes` and `warnings` attributes entirely when the source value is absent; produce records with the key absent rather than `''` or `[]`
    - Timestamps as ISO-8601 UTC strings with exactly three fractional digits; assert the ULID's embedded millisecond timestamp equals `createdAt`
    - Reject lone surrogates as a `wrong-type` validation error naming the field; apply no Unicode normalization in either direction
    - Reject a record with zero meals (Requirement 5.15) through the 1..10 meals bound
    - _Requirements: 5.7, 5.15, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9_

  - [x]* 2.6 Write property test for serializer round trip
    - **Property 1: Serialization round trip preserves the record exactly**
    - **Validates: Requirements 9.1, 9.2, 9.3, 9.6**
    - File: `src/lib/mealPlanSerializer.property.test.ts`, `numRuns: 500`

  - [x]* 2.7 Write property test for absent optional values
    - **Property 2: Absent optional values stay absent, never empty**
    - **Validates: Requirements 9.4, 9.9**
    - File: `src/lib/mealPlanSerializer.property.test.ts`

  - [x]* 2.8 Write property test for bound violations
    - **Property 3: Bound violations are rejected with the offending field named**
    - **Validates: Requirements 9.7, 9.8, 5.15**
    - File: `src/lib/mealPlanSerializer.property.test.ts`, driven by `arbInvalidMealPlanRecord()`

  - [x] 2.9 Extend `src/test/arbitraries.ts` with `arbCorruptedItem()`
    - Take a valid serialized item, pick a required attribute path, and either delete it or replace its value with one of a different type
    - Return `{ item, attributePath, mutation }` so the property can assert the error names that exact path
    - _Requirements: 9.5_

  - [x]* 2.10 Write property test for corrupt item rejection
    - **Property 4: Corrupt items are rejected with the attribute named, and never partially deserialized**
    - **Validates: Requirements 9.5**
    - File: `src/lib/mealPlanSerializer.property.test.ts`

  - [x] 2.11 Create `src/lib/pagination.ts`
    - `encodeCursor(lastMealPlanId: string): string` producing `base64url(JSON.stringify({ v: 1, sk: lastMealPlanId }))`
    - `decodeCursor(cursor: string): { ok: true; sk: string } | { ok: false }` rejecting bad base64url, bad JSON, an unexpected `v`, a missing `sk`, and an `sk` failing `isValidMealPlanId`
    - The cursor carries only the sort key; `userId` is never encoded and is always re-derived from the verified token
    - _Requirements: 6.3, 6.8_

  - [x]* 2.12 Write unit tests for the cursor
    - Round trip for valid ids; rejection of malformed, truncated, wrong-version, and cross-account-shaped cursors
    - Confirms a cursor lifted from another account is inert because it names only a sort-key position
    - _Requirements: 6.3, 6.8_

- [x] 3. Checkpoint — pure domain layer complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Ports, logging, in-memory repository, and the DynamoDB adapter

  - [x] 4.1 Define the repository port in `src/lib/server/mealPlanRepository.ts`
    - `MealPlanRepository` interface, `ListPage`, and the `SaveOutcome` union (`created`, `updated`, `cap-reached`, `ack-required`, `not-found`) exactly as designed
    - Every method takes `userId` as its first parameter; no method accepts a scan or any cross-partition read — the absence of the affordance is what enforces Requirement 7.2
    - Inject the clock as `() => number` and the id generator as `() => string`
    - _Requirements: 5.8, 7.1, 7.2, 7.7, 8.3, 10.2, 11.3, 11.7_

  - [x] 4.2 Create `src/lib/server/storeLog.ts` and the redaction helper
    - `logStoreOp(entry)` with the exact closed parameter type from the design: `mealPlanId`, `op`, `outcome`, optional `failureCategory`, `atMs` — no `unknown`, no index signature, no `userId` field
    - Add the redaction helper that strips Meal_Plan content, quiz answers, email addresses, display names, and Auth_Token values from any payload bound for a third-party analytics or error-reporting sink
    - _Requirements: 7.6, 12.9_

  - [x]* 4.3 Write property test for log and outbound-payload redaction
    - **Property 18: Store-operation logs and outbound payloads carry no content or personal data**
    - **Validates: Requirements 7.6, 12.9**
    - File: `src/lib/server/redaction.property.test.ts`, using `arbMarkedRecord()` marker strings

  - [x] 4.4 Implement `src/lib/server/inMemoryMealPlanRepository.ts`
    - Reimplement the real semantics, not a loose mock: the 100-record cap, newest-first ordering by sort key with the ULID tie-break, strictly-exclusive cursor advance, `attribute_not_exists` create condition, `attribute_exists` update/rename/delete conditions, `#meta` exclusion from listings, `storageAckAt` acknowledgment gate, idempotent delete, and the pending-deletion partition
    - This implementation is the model for the model-based properties, so its conditions must match the adapter's
    - _Requirements: 5.2, 5.3, 5.4, 5.8, 5.9, 6.2, 6.3, 6.8, 7.1, 7.2, 7.7, 8.1, 8.3, 8.4, 11.3, 11.7, 12.3, 12.4_

  - [x] 4.5 Extend `src/test/arbitraries.ts` with store and command generators
    - `arbMultiAccountStore()` — 2 to 5 accounts with overlapping id shapes and deliberately colliding `createdAt` values, which is what makes the tie-break assertion meaningful
    - `arbCommandSequence()` — up to 300 create/update/rename/delete commands, including sequences that reach and exceed the 100-record cap
    - `arbMarkedRecord()` — records seeded with unique marker strings so absence can be asserted on specific values rather than guessed key names
    - _Requirements: 5.8, 6.2, 7.2_

  - [x]* 4.6 Write property test for partition confinement
    - **Property 5: Every store operation is confined to the derived User_Id**
    - **Validates: Requirements 7.1, 7.2, 7.7, 8.7, 10.5, 11.3**
    - File: `src/lib/server/mealPlanRepository.property.test.ts`, driven by `arbMultiAccountStore()`

  - [x]* 4.7 Write property test for save/delete sequences and the record cap
    - **Property 10: Save and delete sequences preserve identity and respect the record cap**
    - **Validates: Requirements 5.2, 5.3, 5.4, 5.8, 5.9, 8.3, 8.4**
    - File: `src/lib/server/mealPlanRepository.property.test.ts`, model-based over `arbCommandSequence()`

  - [x]* 4.8 Write property test for pagination
    - **Property 11: Pagination is complete, duplicate-free, ordered, and terminating**
    - **Validates: Requirements 6.2, 6.3, 6.8**
    - File: `src/lib/server/mealPlanRepository.property.test.ts`

  - [x]* 4.9 Write property test for the oversized-plan guard
    - **Property 12: Oversized plans are rejected without a write**
    - **Validates: Requirements 5.7**
    - File: `src/lib/server/mealPlanRepository.property.test.ts`, using `serializedByteLength` against a repository spy that records every attempted write

  - [x] 4.10 Implement `src/lib/server/dynamoMealPlanRepository.ts`
    - The only module importing `@aws-sdk/client-dynamodb` / `@aws-sdk/lib-dynamodb`; construct the client from `MEAL_PLAN_AWS_*` variables after `assertServerEnv(['MEAL_PLAN_STORE'])`
    - `list`: `Query` with `KeyConditionExpression: userId = :uid AND mealPlanId > :low` (`:low = "#meta"`), `ScanIndexForward: false`, `Limit: 20`, `ProjectionExpression` limited to `mealPlanId, title, createdAt, updatedAt`
    - `create`: `TransactWriteItems` with `Put` guarded by `attribute_not_exists(mealPlanId)` plus the `#meta` `Update` carrying the cap and `storageAckAt` conditions; inspect `TransactionCanceledException.CancellationReasons` to distinguish `cap-reached` (409) from `ack-required` (428) and never retry either blindly
    - `update` / `rename`: `UpdateItem` with `attribute_exists(mealPlanId)`, structurally preserving `mealPlanId` and `createdAt`
    - `delete`: `TransactWriteItems` with `attribute_exists` plus the `#meta` decrement; on `ConditionalCheckFailed` return without decrementing so an already-absent record still yields 204
    - `purge`: paged key `Query`, then `BatchWriteItem` in batches of 25 retrying `UnprocessedItems` within a 3-attempt, 60-second budget
    - `maxAttempts: 3` retry strategy; no `Scan` command anywhere in the module
    - Emit every outcome through `logStoreOp`; never call `console.*`
    - _Requirements: 5.2, 5.3, 5.4, 5.7, 5.8, 5.9, 6.2, 6.3, 6.8, 7.1, 7.2, 7.6, 7.7, 8.1, 8.3, 8.4, 11.3, 11.7, 12.3, 13.6_

  - [x]* 4.11 Write unit tests for the DynamoDB adapter commands
    - Using `aws-sdk-client-mock`, assert the emitted command shapes: the key condition excludes `#meta`, `ScanIndexForward` is `false`, the projection is metadata-only, the transaction conditions are present, `maxAttempts` is 3, and no `ScanCommand` is ever constructed
    - Assert `TransactionCanceledException` cancellation-reason mapping to `cap-reached` and `ack-required`
    - _Requirements: 5.9, 6.2, 7.2, 12.3_

- [x] 5. Auth token verification and the `withAuth` wrapper

  - [x] 5.1 Define the verifier port in `src/lib/server/authTokenVerifier.ts`
    - `VerifiedIdentity` (`userId`, `authTimeMs`, `email`, `displayName`) and the `VerifyResult` union (`missing`, `invalid`, `unavailable`) exactly as designed
    - Declare the `AuthTokenVerifier` interface so route handlers depend on it, never on `jose`
    - _Requirements: 4.1, 4.2, 4.3, 4.5, 4.6, 4.7_

  - [x] 5.2 Implement `src/lib/server/joseAuthTokenVerifier.ts`
    - Steps strictly in the design's order: read `Authorization: Bearer`, then the 8,192-character length guard with no outbound request at all, then the JWT header check requiring `alg: RS256` and a `kid`, then certificate resolution, then claim verification, then the revocation lookup
    - Cache Google's `securetoken@system` x509 certificates in-process honouring the response `Cache-Control: max-age`; fail closed to `unavailable` if certificates cannot be fetched inside the 5-second, 2-attempt budget — never a skipped signature check
    - Claims: `iss === https://securetoken.google.com/${projectId}`, `aud === projectId`, non-empty `sub` of at most 128 characters, `auth_time` not in the future, `exp` with `clockTolerance: 60`
    - Revocation: `accounts:lookup` mapping `USER_NOT_FOUND`, `disabled: true`, and `validSince` newer than `auth_time` to `invalid`; cache keyed by `(sub, auth_time)` for 5 minutes, bypassed when `requireFreshRevocationCheck` is set
    - Every rejection from the length guard onward returns the same `invalid` kind — nothing distinguishes a bad signature from an expired token from a revoked session
    - _Requirements: 4.1, 4.3, 4.5, 4.6, 4.7_

  - [x]* 5.3 Write unit tests for the verifier's fail-closed and cache behavior
    - Certificate fetch silent past 5 seconds over 2 attempts yields `unavailable` (mapped to 503, not 401) and leaves the session unchanged
    - Certificate cache honours `max-age`; revocation cache honours the 5-minute TTL and is bypassed under `requireFreshRevocationCheck`
    - Uses `vi.useFakeTimers()` rather than real waiting
    - _Requirements: 4.5, 4.6_

  - [x] 5.4 Implement `src/lib/server/withAuth.ts`
    - Wrap a handler so verification always resolves before the handler body runs, and the handler's only route to a User_Id is `ctx.identity.userId`
    - Strip any `userId` key from the parsed body and from the query string before the handler sees it; a mismatched supplied `userId` completes normally against the derived one with no error reported
    - `opts.freshRevocationCheck` forwards to the verifier for mutating routes
    - Map `missing` and `invalid` to one identical 401 body, `unavailable` to 503
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 10.8_

  - [x] 5.5 Extend `src/test/arbitraries.ts` with `arbUnusableToken()`
    - The full cause set: absent, blank, wrong scheme, garbage, wrong-key-signed, expired 61 to 10,000 seconds, over 8,192 characters, revoked, disabled, deleted
    - _Requirements: 4.2, 4.3, 4.6, 4.7_

  - [x]* 5.6 Write property test for unusable Auth_Tokens
    - **Property 7: Unusable Auth_Tokens are indistinguishable and never reach the store**
    - **Validates: Requirements 4.2, 4.3, 4.6, 4.7, 10.8**
    - File: `src/lib/server/withAuth.property.test.ts`, asserting identical response bytes and zero repository calls

  - [x]* 5.7 Write property test for verification ordering and derived-id authority
    - **Property 8: Verification precedes store access and the derived User_Id is authoritative**
    - **Validates: Requirements 4.1, 4.4**
    - File: `src/lib/server/withAuth.property.test.ts`

- [x] 6. Checkpoint — ports, adapters, and verification complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Meal_Plan_API and account route handlers

  - [x] 7.1 Create `src/lib/server/apiErrors.ts` with frozen response constants
    - Module-level `Object.freeze`d bodies for the credential 401 and the ownership 404 so no future edit can make two causes distinguishable — the indistinguishability properties assert on these constants' bytes
    - Status mapping for the whole failure taxonomy: 400 validation naming the field without echoing the value, 409 cap, 413 size, 422 deserializer, 428 `STORAGE_ACK_REQUIRED`, 500 partial purge, 503 upstream and store
    - _Requirements: 4.3, 5.7, 5.9, 6.9, 7.3, 7.4, 7.8, 9.8, 11.9, 12.3_

  - [x] 7.2 Implement `src/app/api/meal-plans/route.ts` — `POST` create and `GET` list
    - Module scope: `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`, `preferredRegion = 'iad1'`, `assertServerEnv(['AUTH_SERVICE', 'MEAL_PLAN_STORE'])`
    - `POST` wrapped in `withAuth({ freshRevocationCheck: true })`: normalize the title, generate the ULID from the injected clock, set `updatedAt` equal to `createdAt`, run the size check before any write, delegate to `create`, and respond `201 {mealPlanId, title, createdAt, updatedAt}`
    - `GET` wrapped in `withAuth()`: decode the cursor, return `200 {items, nextCursor?}` with `nextCursor` omitted on the final page
    - _Requirements: 4.1, 5.2, 5.5, 5.6, 5.7, 5.8, 5.9, 5.14, 5.15, 6.1, 6.2, 6.3, 6.8, 9.8, 12.3, 13.6, 13.11_

  - [x]* 7.3 Write property test for the storage-acknowledgment gate
    - **Property 14: No record is written before the storage notice is acknowledged, and the notice appears at most once per Account**
    - **Validates: Requirements 12.3, 12.4, 12.5**
    - File: `src/app/api/meal-plans/storageAck.property.test.ts`

  - [x] 7.4 Implement `src/app/api/meal-plans/[mealPlanId]/route.ts` — `GET`, `PUT`, `PATCH`, `DELETE`
    - Validate the path id with `isValidMealPlanId` before any store access; a malformed id returns the frozen 404 constant without touching the store
    - `GET` returns `200 {record}`, or 422 with cannot-open guidance when the deserializer signals an error, leaving the stored record unchanged
    - `PUT` updates content and `updatedAt` while preserving `mealPlanId` and `createdAt`; runs the 100 KB check first
    - `PATCH` renames, setting `updatedAt` and leaving content untouched
    - `DELETE` returns 204 including when the record is already absent
    - `PUT`, `PATCH`, and `DELETE` use `freshRevocationCheck: true`
    - _Requirements: 5.3, 5.4, 5.7, 6.4, 6.9, 7.3, 7.4, 7.7, 7.8, 8.1, 8.3, 8.4, 8.7_

  - [x]* 7.5 Write property test for indistinguishable id references
    - **Property 6: Unusable Meal_Plan_Id references are indistinguishable**
    - **Validates: Requirements 7.3, 7.4, 7.8**
    - File: `src/lib/server/mealPlanRepository.property.test.ts`, driving the route handlers over the in-memory repository and asserting identical status, body bytes, and field sets across owned-elsewhere, nonexistent, and malformed ids

  - [x] 7.6 Implement `src/app/api/account/export/route.ts`
    - `withAuth({ freshRevocationCheck: true })`, then `listAll(userId)` with no page limit
    - Build `{userId, displayName, email, accountCreatedAt, mealPlans}` from the verified token claims only, never from a request body
    - Never include a password value, Auth_Token, or Identity_Provider credential
    - Set `Content-Disposition` for the download; absent collections are emitted empty rather than omitted
    - _Requirements: 10.2, 10.3, 10.5, 10.6, 10.8_

  - [x]* 7.7 Write property test for export completeness and scoping
    - **Property 13: Export is complete, account-scoped, and free of credentials**
    - **Validates: Requirements 10.2, 10.3, 10.4, 10.5, 10.6**
    - File: `src/app/api/account/export/route.property.test.ts`, using `arbMarkedRecord()`

  - [x] 7.8 Implement `src/app/api/account/purge/route.ts`
    - `withAuth({ freshRevocationCheck: true })`, then `purge(userId)` returning `200 {deletedCount, remaining}`
    - Retry unprocessed deletions at most 3 times within 60 seconds; when `remaining > 0` after those retries, call `enqueuePendingDeletion(userId)` and report it
    - A failure before Account removal returns 500 with restart guidance, leaving the Account and every remaining record unchanged
    - _Requirements: 11.3, 11.7, 11.9_

  - [x] 7.9 Implement `src/app/api/internal/pending-deletion-sweep/route.ts`
    - Authenticate solely with `Bearer ${CRON_SECRET}` compared in constant time; this is the one endpoint exempt from Requirement 4, because it runs after the Account no longer exists
    - Accept no request-controlled User_Id and touch nothing outside the `PENDING#DELETION` partition
    - For each entry, retry the purge and remove the entry exactly when no record remains for that User_Id; return `200 {processed, cleared, stillPending}`
    - Idempotent: a second run over the same list produces the same end state
    - _Requirements: 11.7_

  - [x]* 7.10 Write property test for the pending-deletion sweep
    - **Property 21: The pending-deletion sweep retries boundedly and converges**
    - **Validates: Requirements 11.7**
    - File: `src/lib/accountDeletion.property.test.ts`

  - [x] 7.11 Migrate `src/app/api/meal-plan/route.ts` to `assertServerEnv(['AI_INFERENCE'])`
    - Replace the current mid-request 500 on a missing `AWS_BEARER_TOKEN_BEDROCK` with a module-scope `assertServerEnv` call so startup fails uniformly with the new routes
    - Leave the route unauthenticated and its generation behavior otherwise unchanged
    - Update `src/app/api/meal-plan/route.test.ts` for the new failure mode
    - _Requirements: 5.12, 6.10, 13.11_

- [x] 8. Checkpoint — server surface complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Auth library consolidation and client-side auth logic

  - [x] 9.1 Create `src/lib/firebaseClient.ts`
    - Sole owner of `firebaseConfig`, `getFirebaseApp()`, and `isFirebaseConfigured()`
    - Remove the duplicated config object and `initializeApp` guard from `auth.ts` and `firebase.ts` by having both import from here
    - _Requirements: 13.7_

  - [x] 9.2 Extend `src/lib/auth.ts` into the single Auth_Service module
    - Add `AuthSession`, and the functions `signInWithGoogle`, `signOutEverywhere`, `sendVerificationEmail`, `requestPasswordReset`, `reauthenticate`, `deleteCurrentAccount`, `getIdTokenForRequest`; change `onAuthChange` to emit `AuthSession | null`
    - Absorb `signInWithGoogle` from `firebase.ts` and return the `GoogleSignInOutcome` discriminated union (`signed-in`, `cancelled`, `timed-out`, `no-email`, `failed`) rather than throwing, so the four distinct Auth_UI outcomes are distinguishable
    - `signInWithPopup` first; fall back to `signInWithRedirect` on `auth/popup-blocked` or `auth/operation-not-supported-in-this-environment`, reconciled by `getRedirectResult()` on mount
    - Enforce the 120-second provider timeout in this module, not in the UI
    - `browserLocalPersistence`; `requestPasswordReset` swallows `user-not-found` so the response is identical for registered and unregistered addresses
    - Replace substring matching on `err.message` with `err.code` on `FirebaseError`, mapped per the design's error-code table
    - Keep the existing `signUp`, `signIn`, `signOut` signatures so current callers are unaffected
    - _Requirements: 1.2, 1.3, 1.4, 1.6, 1.9, 1.10, 2.1, 2.2, 2.9, 2.10, 2.12, 3.2, 3.4, 3.6, 3.7, 3.8, 3.9, 11.5_

  - [x] 9.3 Create the shared throttle, session-age, and display-name helpers
    - `src/lib/throttle.ts`: one sliding-window predicate parameterized by window, limit, and cooldown, serving the verification resend rule (1.7), the signin failure rule (2.3), and the password reset rule (2.9); reports seconds remaining as an exact whole-second ceiling
    - The signin failure ledger in localStorage keyed by a SHA-256 hash of the lowercased email, never the address itself; only credential rejections increment it — client-side validation failures and transport failures do not; a successful signin resets the count to zero
    - `sessionStartedAtMs` read/write in localStorage plus `isSessionActive(nowMs)` returning active only under 30 days
    - `deriveDisplayName(profileName, email)`: first 50 characters of the trimmed profile name when it has 1 or more characters, otherwise the first 50 characters of the email local part; never empty, never over 50
    - _Requirements: 1.7, 2.1, 2.3, 2.5, 2.7, 2.9, 2.11, 3.3, 3.5_

  - [x]* 9.4 Write property test for the sliding-window throttles
    - **Property 16: Sliding-window throttles admit an attempt exactly when the window permits**
    - **Validates: Requirements 1.7, 2.1, 2.3, 2.9, 2.11**
    - File: `src/lib/auth.property.test.ts`

  - [x]* 9.5 Write property test for display name derivation
    - **Property 17: Display name derivation trims, falls back, and truncates to 50**
    - **Validates: Requirements 3.3, 3.5**
    - File: `src/lib/auth.property.test.ts`

  - [x]* 9.6 Write property test for session validity as a function of age
    - **Property 15: Session validity is a function of age, and an invalid Session displays no records**
    - **Validates: Requirements 2.5, 2.7, 2.8, 2.13**
    - File: `src/lib/auth.property.test.ts`

  - [x] 9.7 Implement `src/lib/accountDeletion.ts`
    - The ordered flow as a testable state machine: confirmation text must equal exactly `DELETE`; re-authentication gate when `auth_time` is more than 5 minutes old; then `POST /api/account/purge`; then `deleteCurrentAccount()`; then clear tracker entries via `trackerStorage`; then end the Session
    - No path from the re-auth state straight to purging, so a mid-flow session expiry returns to confirmation and requires the text again
    - A failed record deletion before Account removal aborts with nothing removed and the Session still active
    - Abort after a cancelled re-auth or 3 failed re-auth attempts
    - _Requirements: 11.2, 11.3, 11.5, 11.6, 11.8, 11.9, 11.10_

  - [x]* 9.8 Write property test for deletion gates and effect ordering
    - **Property 20: Account deletion removes nothing before its gates pass, then proceeds in order**
    - **Validates: Requirements 11.2, 11.3, 11.5, 11.8, 11.9**
    - File: `src/lib/accountDeletion.property.test.ts`

  - [x] 9.9 Reduce `src/lib/firebase.ts` to Firestore forum helpers
    - Remove the auth implementations; re-export `signInWithGoogle`, `signOut`, and `onAuthChange` from `auth.ts` as thin re-exports for one release
    - Keep `getDb`, `postForumMessage`, and `subscribeToForumMessages` behavior identical; verify `ChatForum` still compiles and its tests pass
    - _Requirements: 13.13_

- [x] 10. Browser UI — session, auth surface, saved plans, account settings

  - [x] 10.1 Create `src/lib/apiClient.ts`
    - `callApi<T>(path, init, opts)` returning the `ApiResult<T>` union, attaching the ID token from `getIdTokenForRequest()`, with a default 10-second `AbortController` timeout matching the pattern already used in `src/lib/bedrock.ts`
    - Map response statuses to the `kind` values `unauthorized`, `not-found`, `conflict`, `too-large`, `ack-required`, `validation`, `unavailable`, `timeout`
    - Handle `unauthorized` centrally: clear the session, empty the plan list, show the expiry message — the same path as an elapsed Session
    - _Requirements: 2.13, 5.11, 6.6, 8.5, 8.8, 10.9_

  - [x]* 10.2 Write unit tests for `callApi`
    - Timeout at 10 seconds using `vi.useFakeTimers()`; each status-to-`kind` mapping; central `unauthorized` handling firing exactly once per failed call
    - _Requirements: 5.11, 6.6, 8.5, 10.9_

  - [x] 10.3 Create `src/components/auth/SessionProvider.tsx`
    - React context over `onAuthChange`, checking the 30-day session age on every load and on every auth change
    - Past 30 days: sign out, clear the displayed plan list, show the expiry message alongside the signin and signup controls
    - On signout, clear the plan view within the same render pass and discard the locally held session even when the Auth_Service returns no response
    - _Requirements: 2.5, 2.6, 2.8, 2.13_

  - [x] 10.4 Create `src/components/auth/AccountMenu.tsx` and mount it in `src/app/layout.tsx`
    - Header display name plus a signout control, rendered on every page — the root layout currently renders only `{children}`, so `SessionProvider` and `AccountMenu` are mounted there rather than in `page.tsx`
    - _Requirements: 2.4, 2.6, 2.8_

  - [x] 10.5 Create `src/components/auth/GoogleSignInButton.tsx`
    - One control per recognized provider in `NEXT_PUBLIC_AUTH_PROVIDERS`, operable by both pointer and keyboard, with an accessible label
    - Render nothing for unrecognized or absent providers
    - _Requirements: 3.1, 3.10_

  - [x]* 10.6 Write property test for provider-control rendering
    - **Property 23: Identity_Provider controls mirror the Deployment_Configuration**
    - **Validates: Requirements 3.1, 3.10**
    - File: `src/lib/auth.property.test.ts`

  - [x] 10.7 Rework `src/components/AuthModal.tsx`
    - Field-level validation and retention: password 8–128 with name and email retained; duplicate email with a sign-in offer and both fields retained; display name 1–50 as the only message when it alone fails; invalid email retaining the display name; signup failure or timeout retaining name and email and clearing the password
    - Signin: one shared incorrect-email-or-password message revealing neither which value nor whether the address is registered, retaining email and clearing password; a field-level message with no request sent for an empty or syntactically invalid entry
    - Throttle countdown showing remaining seconds when blocked
    - Google control on both views, plus the password reset entry point
    - Privacy_Notice link present on the initial view and after any validation message
    - Close the modal and show no validation message on success
    - Replace `err.message` substring matching with the `err.code` mapping
    - _Requirements: 1.1, 1.3, 1.4, 1.5, 1.8, 1.9, 1.10, 1.11, 2.2, 2.3, 2.9, 2.11, 2.12, 3.1, 3.6, 3.7, 3.8, 3.9, 12.2_

  - [x]* 10.8 Write unit tests for `AuthModal` branches
    - Duplicate email (1.4), signup timeout (1.10), modal close on success (1.11), no-Session initial state (2.6), signin transport failure (2.12), provider cancellation returning with no message (3.6), provider failure with email and password still enabled (3.7), provider returning no email (3.8), 120-second provider timeout with fake timers (3.9)
    - _Requirements: 1.4, 1.10, 1.11, 2.6, 2.12, 3.6, 3.7, 3.8, 3.9_

  - [x] 10.9 Create `src/components/auth/EmailVerificationBanner.tsx`
    - Pending-verification indicator shown while the signed-in Account's email is unverified, with a resend control gated by the shared 60-second throttle predicate and a message naming when the next resend becomes available
    - _Requirements: 1.7_

  - [x] 10.10 Create `src/components/planner/SavePlanControl.tsx` and add `savedMealPlanId` to `MealPlannerPage`
    - Save control rendered inside the displayed plan view only while a Session is active; a signed-out view shows the account-required message and no control
    - Confirmation within 2 seconds of a successful response; on failure, a message plus a control that resubmits the same request, with the generated plan left unchanged in view
    - Retain the returned `mealPlanId` so a second activation issues `PUT` against the same record instead of another `POST`
    - Recompute `compiledPrompt` from a reopened stored plan and stop passing the previously displayed plan to `AIChatInterface`
    - _Requirements: 5.1, 5.10, 5.11, 5.12, 5.13, 6.7_

  - [x] 10.11 Create `src/components/planner/StorageNoticeDialog.tsx`
    - Triggered by the `ack-required` result; names the storage region and offers acknowledge and decline
    - Acknowledging resubmits the save with `acknowledgeStorage: true`; declining writes nothing
    - _Requirements: 12.3, 12.5_

  - [x] 10.12 Create `src/components/planner/SavedPlansList.tsx`
    - One row per record showing the stored title and the creation date formatted `YYYY-MM-DD`; progress indicator while a request is in flight
    - Empty state message with no rows when the Account owns none; signed-out message with no records
    - Load-more control appending the next page below existing rows, removed when the response carries no continuation token
    - On list or read failure, keep previously rendered rows and add a retry control — error state is additive, never a reset of the data
    - Reopen a record through `MealPlanDisplay` so a stored plan renders with the same layout as a generated one; a deserializer error shows the cannot-open message with the list still displayed
    - _Requirements: 6.1, 6.3, 6.4, 6.5, 6.6, 6.8, 6.9, 6.10_

  - [x]* 10.13 Write property test for rendered plans and lists
    - **Property 22: Rendered plans and lists preserve stored order and content**
    - **Validates: Requirements 6.1, 6.4, 6.6, 6.7**
    - File: `src/components/planner/SavedPlansList.property.test.tsx`

  - [x] 10.14 Create `src/components/planner/RenamePlanDialog.tsx` and `DeletePlanDialog.tsx`
    - Rename validates 1–100 characters after trimming before any request is sent, keeping the stored title displayed on rejection; applies optimistically and restores the captured pre-rename title exactly on failure
    - Delete confirmation names the record by title and offers exactly one confirm and one cancel control, sending nothing until confirm is activated; removes the row within 1 second of a successful response leaving the remaining order intact; on failure keeps the row and the delete control available
    - _Requirements: 8.1, 8.2, 8.5, 8.6, 8.8_

  - [x] 10.15 Create `src/components/pages/AccountSettingsPage.tsx`
    - Export control calling `GET /api/account/export`, merging `trackerStorage` entries in as `trackerEntries` (always a collection, empty rather than omitted), and downloading `crohns-buddy-export-YYYY-MM-DD.json` built from the UTC date — the `Blob` is created only after the full payload resolves, so a failure produces a message and a retry control with no partial file
    - Deletion flow UI driving `src/lib/accountDeletion.ts`, including the exact-`DELETE` text gate, the re-auth prompt, the completion confirmation, and the in-progress message when removal of remaining data is pending
    - Privacy_Notice link
    - _Requirements: 10.1, 10.3, 10.4, 10.9, 11.1, 11.4, 11.6, 11.10, 12.2_

  - [x] 10.16 Create `src/app/privacy/page.tsx`
    - Static Privacy_Notice readable with no Session, naming the health-related data stored, the storage region, and how a Patient removes it
    - _Requirements: 12.1, 12.2, 12.10_

  - [ ]* 10.17 Write unit tests for the Privacy_Notice and link placement
    - Assert the required statements and the region naming are present, and that the link appears in the signup form and on the account settings page
    - _Requirements: 12.1, 12.2, 12.10_

- [x] 11. Checkpoint — full feature wired end to end
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Deployment configuration and committed infrastructure artifacts

  - [x] 12.1 Update `.env.local.example`, `next.config.mjs`, and add `vercel.json`
    - Append the `MEAL_PLAN_*`, `NEXT_PUBLIC_AUTH_PROVIDERS`, and `CRON_SECRET` placeholder block exactly as listed in the design; placeholders only, no real values
    - Add `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` via `next.config.mjs` headers
    - Add `vercel.json` with the cron entry `0 3 * * *` targeting `/api/internal/pending-deletion-sweep` — once daily is the Hobby maximum and exactly what the requirement needs
    - _Requirements: 11.7, 12.7, 12.8, 13.7_

  - [x] 12.2 Commit the table and IAM artifacts plus a setup checklist
    - `infra/dynamodb-table.json` describing `crohns-buddy-meal-plans` in us-east-1: partition key `userId` (S), sort key `mealPlanId` (S), `PAY_PER_REQUEST`, SSE enabled with the AWS-owned key, PITR disabled, no GSI, no TTL, no stream
    - `infra/meal-plan-store-policy.json` allowing only `GetItem`, `PutItem`, `UpdateItem`, `DeleteItem`, `Query`, `BatchWriteItem`, and `TransactWriteItems` on `arn:aws:dynamodb:us-east-1:*:table/crohns-buddy-meal-plans` — no `Scan`, no other table, no other service
    - `infra/README.md` with the ordered console checklist for the steps that cannot be scripted from this repo: create the IAM user and attach the policy, create the table from the committed JSON, set the Vercel environment variables, enable the Google Identity_Provider in the Firebase console, and create the AWS Budgets alarm at US$20.00 publishing to an SNS topic subscribed to the owner contact address
    - _Requirements: 7.5, 12.6, 13.3, 13.7, 13.8_

  - [x] 12.3 Write `docs/hosting.md`
    - Platform selection and the `iad1`/us-east-1 region pin with its reasoning
    - The cost estimate table at Monthly_Reference_Load with its total, and the free-tier allowance table with a named quantity limit and consequence per allowance
    - The non-commercial restriction, the assessment against this site, the four migration triggers, and AWS Amplify Hosting named as the pre-selected alternative
    - The spend-alert threshold and the contact address
    - Structure the document so the machine-readable assertions in the next task can parse it
    - _Requirements: 13.1, 13.2, 13.4, 13.5, 13.6, 13.9, 13.10, 13.12_

  - [ ]* 12.4 Write unit tests that parse `docs/hosting.md`
    - Requirements 13.9 and 13.10 make the document's content a deliverable, so assert mechanically: the platform name, a dollar figure, a quantity limit per named allowance, and the non-commercial restriction statement
    - _Requirements: 13.9, 13.10_

  - [x] 12.5 Write `scripts/verify-deployment.ts` smoke checks
    - `DescribeTable`: `BillingMode` is `PAY_PER_REQUEST` and SSE is enabled
    - IAM policy resource ARN names exactly the one table and grants no `Scan`
    - No `MEAL_PLAN_*` or `AWS_BEARER_TOKEN_BEDROCK` value appears in the built client bundle, checked by grepping `.next/static` for the access-key-id pattern
    - `MEAL_PLAN_AWS_REGION` equals the Bedrock region
    - TLS certificate is platform-managed and its `notAfter` is more than 15 days out
    - An AWS Budgets alarm exists at $20.00 with a subscribed contact address
    - The committed cron expression runs at most once per day, so the deploy cannot fail on the Hobby frequency limit
    - Add an npm script entry for it; exit non-zero on any failed check
    - _Requirements: 7.5, 11.7, 12.6, 12.7, 13.3, 13.4, 13.6, 13.7, 13.8_

  - [x] 12.6 Add the `no-console` ESLint rule for server store modules
    - Configure `.eslintrc.json` so `console.*` is an error under `src/lib/server/**` and `src/app/api/**`, with an allowlist entry for `src/lib/server/storeLog.ts`
    - Fix any violation the rule surfaces
    - _Requirements: 7.6_

- [x] 13. Final checkpoint — full suite and build
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Sub-tasks marked with `*` are test tasks and can be skipped for a faster MVP; every core implementation task is unmarked.
- All 23 correctness properties from the design are assigned: P1 → 2.6, P2 → 2.7, P3 → 2.8, P4 → 2.10, P5 → 4.6, P6 → 7.5, P7 → 5.6, P8 → 5.7, P9 → 2.4, P10 → 4.7, P11 → 4.8, P12 → 4.9, P13 → 7.7, P14 → 7.3, P15 → 9.6, P16 → 9.4, P17 → 9.5, P18 → 4.3, P19 → 1.4, P20 → 9.8, P21 → 7.10, P22 → 10.13, P23 → 10.6.
- Property test files follow the design's Testing Strategy mapping, and each test carries the `// Feature: user-auth-and-cloud-storage, Property N: ...` tag comment so a failure points back to the design.
- Integration tests against a real DynamoDB table and Firebase project run outside `npm test` and are not tasks here; the design lists them separately from the unit and property layers.
- The existing 80% coverage thresholds in `vitest.config.ts` stay unchanged.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "1.5", "2.1", "2.3", "2.11", "12.1"] },
    { "id": 2, "tasks": ["1.4", "2.2", "2.4", "2.5", "2.12"] },
    { "id": 3, "tasks": ["2.9", "4.1", "4.2", "5.1", "9.1"] },
    { "id": 4, "tasks": ["2.6", "4.3", "4.4", "5.2", "9.2"] },
    { "id": 5, "tasks": ["2.7", "4.5", "5.3", "9.3", "10.1"] },
    { "id": 6, "tasks": ["2.8", "4.6", "4.10", "5.4", "9.9", "10.3"] },
    { "id": 7, "tasks": ["2.10", "4.7", "4.11", "5.5", "9.4", "10.4", "10.5"] },
    { "id": 8, "tasks": ["4.8", "5.6", "9.5", "10.7", "12.2"] },
    { "id": 9, "tasks": ["4.9", "5.7", "7.1", "9.6", "10.9", "12.3"] },
    { "id": 10, "tasks": ["7.2", "7.11", "9.7", "10.2", "12.4", "12.6"] },
    { "id": 11, "tasks": ["7.4", "7.6", "7.8", "7.9", "9.8", "10.6", "10.8"] },
    { "id": 12, "tasks": ["7.3", "7.5", "7.7", "7.10", "10.10", "10.12", "10.16"] },
    { "id": 13, "tasks": ["10.11", "10.13", "10.14", "10.15", "10.17"] },
    { "id": 14, "tasks": ["12.5"] }
  ]
}
```
