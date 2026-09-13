/**
 * Property-based tests for the Meal_Plan_Store port.
 *
 * Feature: user-auth-and-cloud-storage.
 *
 * Every property in this file runs against `createInMemoryMealPlanRepository`,
 * which reimplements the DynamoDB adapter's key schema and conditions rather
 * than stubbing them, so a statement that holds here is a statement about the
 * production store's semantics. The shared scaffolding — the seeded-state index,
 * the operation union, and the page traversal — lives at module scope, since the
 * remaining store properties assert over the same operation set.
 *
 * Properties covered so far:
 *
 * - Property 5: Every store operation is confined to the derived User_Id.
 * - Property 6: Unusable Meal_Plan_Id references are indistinguishable.
 * - Property 10: Save and delete sequences preserve identity and respect the record cap.
 * - Property 11: Pagination is complete, duplicate-free, ordered, and terminating.
 * - Property 12: Oversized plans are rejected without a write.
 */

import fc from 'fast-check';
import { factory as ulidFactory } from 'ulid';
import { describe, expect, it } from 'vitest';

import { mealPlanIdTimestampMs, newMealPlanId } from '../mealPlanId';
import {
  MAX_SERIALIZED_BYTES,
  SERIALIZER_BOUNDS,
  serializeMealPlanRecord,
  serializedByteLength,
} from '../mealPlanSerializer';
import { decodeCursor, encodeCursor } from '../pagination';
import type {
  MealEntry,
  MealPlanContent,
  MealPlanItemEntry,
  MealPlanRecord,
  MealPlanSummary,
} from '../types';
import { NOT_FOUND_BODY } from './apiErrors';
import type { AuthTokenVerifier, VerifiedIdentity } from './authTokenVerifier';
import {
  createInMemoryMealPlanRepository,
  type InMemoryMealPlanRepository,
} from './inMemoryMealPlanRepository';
import { createMealPlanItemRouteHandlers } from './mealPlanItemRoute';
import {
  MEAL_PLAN_PAGE_SIZE,
  MEAL_PLAN_RECORD_CAP,
  PENDING_DELETION_PARTITION,
  type ListPage,
  type SaveOutcome,
} from './mealPlanRepository';
import {
  arbCommandSequence,
  arbMealPlanRecord,
  arbMultiAccountStore,
  arbTrickyString,
  type CommandSequence,
  type MultiAccountStore,
  type StoreCommand,
} from '@/test/arbitraries';

// ─── Shared scaffolding ────────────────────────────────────────────────────────

/**
 * One repository operation, as data.
 *
 * The set is exactly the one Property 5 enumerates — get, list, listAll, create,
 * update, rename, delete, purge. The two pending-deletion methods are excluded
 * deliberately: they address a reserved partition rather than an Account's, and
 * they run after the Account no longer exists, so they are Property 21's subject.
 */
type StoreOperation =
  | { kind: 'get'; mealPlanId: string }
  | { kind: 'list' }
  | { kind: 'listAll' }
  | { kind: 'create'; record: MealPlanRecord; ackStorage: boolean }
  | { kind: 'update'; record: MealPlanRecord }
  | { kind: 'rename'; mealPlanId: string; title: string; renamedAtMs: number }
  | { kind: 'delete'; mealPlanId: string }
  | { kind: 'purge' };

type OperationKind = StoreOperation['kind'];

/** Operations that read. Each must leave the whole table untouched. */
const READ_KINDS: OperationKind[] = ['get', 'list', 'listAll'];

/** Operations that write. Each must touch the caller's partition and no other. */
const WRITE_KINDS: OperationKind[] = ['create', 'update', 'rename', 'delete', 'purge'];

const ALL_KINDS: OperationKind[] = [...READ_KINDS, ...WRITE_KINDS];

/**
 * Page budget for a full traversal: the record cap divided by the page size,
 * plus the trailing empty page a cap-multiple Account produces, plus slack. A
 * traversal exceeding it is a non-terminating cursor, not a slow test.
 */
const MAX_TRAVERSAL_PAGES = Math.ceil(MEAL_PLAN_RECORD_CAP / MEAL_PLAN_PAGE_SIZE) + 3;

/**
 * Method names that would let a caller read or write outside one partition.
 * Requirement 7.2 is enforced by the absence of the affordance, so the port is
 * asserted not to have grown one.
 */
const CROSS_PARTITION_METHODS = [
  'scan',
  'query',
  'getAny',
  'findByMealPlanId',
  'listAllAccounts',
  'listAllRecords',
  'deleteByMealPlanId',
];

/** Every seeded record, indexed by partition key then sort key. */
function indexSeeds(store: MultiAccountStore): Map<string, Map<string, MealPlanRecord>> {
  const index = new Map<string, Map<string, MealPlanRecord>>();
  for (const seed of store.seeds) {
    const partition = new Map<string, MealPlanRecord>();
    for (const record of seed.records ?? []) partition.set(record.mealPlanId, record);
    index.set(seed.userId, partition);
  }
  return index;
}

/** Sort keys the given Account holds, ascending. */
function ownIdsOf(store: MultiAccountStore, userId: string): string[] {
  return store.placements
    .filter((placement) => placement.userId === userId)
    .map((placement) => placement.mealPlanId)
    .sort();
}

/** Every partition key the seeded state can hold, including the reserved one. */
function allPartitionKeys(store: MultiAccountStore): string[] {
  return [...store.userIds, store.absentUserId, PENDING_DELETION_PARTITION];
}

/**
 * Stable serialization of every partition except `callerUserId`, so a mutation
 * outside the caller's own partition shows up as a byte difference.
 */
function otherPartitions(
  repo: InMemoryMealPlanRepository,
  store: MultiAccountStore,
  callerUserId: string,
): string {
  return allPartitionKeys(store)
    .filter((key) => key !== callerUserId)
    .sort()
    .map((key) => `${key}=${repo.snapshotPartition(key)}`)
    .join('\n');
}

/** A seeded repository with a fixed clock and id generator, and an empty ledger. */
function buildRepository(store: MultiAccountStore, nowMs: number): InMemoryMealPlanRepository {
  const repo = createInMemoryMealPlanRepository({
    now: () => nowMs,
    newMealPlanId: () => newMealPlanId(nowMs),
  });
  repo.seed(store.seeds);
  repo.clearCalls();
  return repo;
}

/** Walks every page of a listing, guarding against a cursor that never ends. */
async function traverseList(
  repo: InMemoryMealPlanRepository,
  userId: string,
): Promise<MealPlanSummary[]> {
  const items: MealPlanSummary[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TRAVERSAL_PAGES; page += 1) {
    const result = await repo.list(userId, cursor);
    items.push(...result.items);
    if (result.nextCursor === undefined) return items;
    cursor = result.nextCursor;
  }
  throw new Error(`list: traversal for ${userId} exceeded ${MAX_TRAVERSAL_PAGES} pages`);
}

/**
 * Runs one operation against one Account.
 *
 * @returns For a read, the records or summaries returned; for a write, an empty
 *   list, since a write returns an outcome rather than records.
 */
async function applyOperation(
  repo: InMemoryMealPlanRepository,
  userId: string,
  operation: StoreOperation,
): Promise<Array<MealPlanRecord | MealPlanSummary>> {
  switch (operation.kind) {
    case 'get': {
      const record = await repo.get(userId, operation.mealPlanId);
      return record === null ? [] : [record];
    }
    case 'list':
      return traverseList(repo, userId);
    case 'listAll':
      return repo.listAll(userId);
    case 'create':
      await repo.create(userId, operation.record, operation.ackStorage);
      return [];
    case 'update':
      await repo.update(userId, operation.record);
      return [];
    case 'rename':
      await repo.rename(
        userId,
        operation.mealPlanId,
        operation.title,
        operation.renamedAtMs,
      );
      return [];
    case 'delete':
      await repo.delete(userId, operation.mealPlanId);
      return [];
    case 'purge':
      await repo.purge(userId);
      return [];
  }
}

// ─── Generators ────────────────────────────────────────────────────────────────

/** A plausible wall-clock instant for an acknowledgment or a rename. */
const arbNowMs = fc.integer({ min: Date.UTC(2024, 0, 1), max: Date.UTC(2035, 0, 1) });

/**
 * A Meal_Plan_Id worth aiming an operation at: one the caller holds, one only
 * another Account holds, one several Accounts hold under different content, and
 * one no Account holds at all. The overlapping cases are the ones that make
 * confinement falsifiable — a read that leaked across partitions would return a
 * record rather than nothing.
 */
function arbTargetMealPlanId(
  store: MultiAccountStore,
  callerUserId: string,
): fc.Arbitrary<string> {
  const own = ownIdsOf(store, callerUserId);
  const foreign = store.placements
    .filter((placement) => placement.userId !== callerUserId)
    .map((placement) => placement.mealPlanId)
    .filter((mealPlanId) => !own.includes(mealPlanId));

  const candidates = Array.from(
    new Set([...own, ...foreign, ...store.sharedMealPlanIds, store.absentMealPlanId]),
  );
  return fc.constantFrom(...candidates);
}

/**
 * A well-formed record placed at `mealPlanId` and *claiming* `claimedUserId` as
 * its owner. The claim is drawn independently of the calling Account on purpose:
 * a record asserting a different owner must still land in the caller's own
 * partition (Requirements 7.1, 7.7), so the argument has to win over the body.
 *
 * `createdAt` is taken from the id's embedded millisecond timestamp, which is
 * the agreement the serializer enforces.
 */
function arbRecordAt(claimedUserId: string, mealPlanId: string): fc.Arbitrary<MealPlanRecord> {
  const createdAt = new Date(mealPlanIdTimestampMs(mealPlanId)).toISOString();
  return arbMealPlanRecord().map((base) => ({
    ...base,
    userId: claimedUserId,
    mealPlanId,
    createdAt,
    updatedAt: createdAt,
  }));
}

/** One operation aimed at the given Account, drawn from `kinds`. */
function arbOperation(
  store: MultiAccountStore,
  callerUserId: string,
  kinds: readonly OperationKind[],
): fc.Arbitrary<StoreOperation> {
  const arbClaimedUserId = fc.constantFrom(...store.userIds, store.absentUserId);

  return fc.constantFrom(...kinds).chain((kind): fc.Arbitrary<StoreOperation> => {
    switch (kind) {
      case 'list':
        return fc.constant<StoreOperation>({ kind: 'list' });
      case 'listAll':
        return fc.constant<StoreOperation>({ kind: 'listAll' });
      case 'purge':
        return fc.constant<StoreOperation>({ kind: 'purge' });
      case 'get':
        return arbTargetMealPlanId(store, callerUserId).map((mealPlanId) => ({
          kind: 'get',
          mealPlanId,
        }));
      case 'delete':
        return arbTargetMealPlanId(store, callerUserId).map((mealPlanId) => ({
          kind: 'delete',
          mealPlanId,
        }));
      case 'rename':
        return fc
          .tuple(arbTargetMealPlanId(store, callerUserId), arbTrickyString(1, 40), arbNowMs)
          .map(([mealPlanId, title, renamedAtMs]) => ({
            kind: 'rename',
            mealPlanId,
            title,
            renamedAtMs,
          }));
      case 'create':
        return fc
          .tuple(arbTargetMealPlanId(store, callerUserId), arbClaimedUserId, fc.boolean())
          .chain(([mealPlanId, claimedUserId, ackStorage]) =>
            arbRecordAt(claimedUserId, mealPlanId).map<StoreOperation>((record) => ({
              kind: 'create',
              record,
              ackStorage,
            })),
          );
      case 'update':
        return fc
          .tuple(arbTargetMealPlanId(store, callerUserId), arbClaimedUserId)
          .chain(([mealPlanId, claimedUserId]) =>
            arbRecordAt(claimedUserId, mealPlanId).map<StoreOperation>((record) => ({
              kind: 'update',
              record,
            })),
          );
    }
  });
}

/** A seeded multi-Account state, a calling Account, and one operation for it. */
interface ConfinementCase {
  store: MultiAccountStore;
  /** The User_Id the Meal_Plan_API would have derived from the verified token. */
  callerUserId: string;
  operation: StoreOperation;
  nowMs: number;
}

/**
 * The caller is drawn from the seeded Accounts plus `absentUserId`, so an
 * operation issued by an Account holding nothing is exercised too.
 */
function arbConfinementCase(kinds: readonly OperationKind[]): fc.Arbitrary<ConfinementCase> {
  return arbMultiAccountStore().chain((store) =>
    fc
      .tuple(fc.constantFrom(...store.userIds, store.absentUserId), arbNowMs)
      .chain(([callerUserId, nowMs]) =>
        arbOperation(store, callerUserId, kinds).map((operation) => ({
          store,
          callerUserId,
          operation,
          nowMs,
        })),
      ),
  );
}

// ─── Property 5 ────────────────────────────────────────────────────────────────

describe('Property 5: every store operation is confined to the derived User_Id', () => {
  // Feature: user-auth-and-cloud-storage, Property 5: Every store operation is
  // confined to the derived User_Id
  //
  // **Validates: Requirements 7.1, 7.2, 7.7, 8.7, 10.5, 11.3**
  it('returns only Meal_Plan_Records stored under the derived User_Id', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbConfinementCase(READ_KINDS),
        async ({ store, callerUserId, operation, nowMs }) => {
          const repo = buildRepository(store, nowMs);
          const seeded = indexSeeds(store);
          const ownIds = ownIdsOf(store, callerUserId);
          const before = repo.snapshot();

          const returned = await applyOperation(repo, callerUserId, operation);

          // Nothing surfaces that the caller does not hold, whatever the id's
          // status elsewhere in the table (Requirements 7.2, 10.5).
          for (const entry of returned) {
            expect(ownIds).toContain(entry.mealPlanId);
            if ('userId' in entry) expect(entry.userId).toBe(callerUserId);
          }

          if (operation.kind === 'get') {
            const own = seeded.get(callerUserId)?.get(operation.mealPlanId);
            if (own === undefined) {
              // Owned elsewhere, or owned nowhere: the same nothing either way
              // (Requirements 7.3, 7.4).
              expect(returned).toEqual([]);
            } else {
              // The caller's own version of a shared id, not another Account's —
              // the seeds give the same id different titles per Account.
              expect(returned).toHaveLength(1);
              const record = returned[0] as MealPlanRecord;
              expect(record.userId).toBe(callerUserId);
              expect(record.title).toBe(own.title);
              expect(record.createdAt).toBe(own.createdAt);
            }
          } else {
            // A full traversal and an export both see the caller's whole
            // partition and nothing beyond it (Requirements 7.2, 10.5).
            expect(returned.map((entry) => entry.mealPlanId).sort()).toEqual(ownIds);
          }

          // A read mutates nothing anywhere.
          expect(repo.snapshot()).toBe(before);
        },
      ),
      { numRuns: 250 },
    );
  });

  // Feature: user-auth-and-cloud-storage, Property 5: Every store operation is
  // confined to the derived User_Id
  //
  // **Validates: Requirements 7.1, 7.2, 7.7, 8.7, 10.5, 11.3**
  it("leaves every other Account's partition byte-for-byte unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbConfinementCase(ALL_KINDS),
        async ({ store, callerUserId, operation, nowMs }) => {
          const repo = buildRepository(store, nowMs);
          const before = otherPartitions(repo, store, callerUserId);

          await applyOperation(repo, callerUserId, operation);

          // A create claiming another owner, an update or rename or delete aimed
          // at an id another Account holds, and a purge all stop at the caller's
          // partition boundary (Requirements 7.1, 7.7, 8.7, 11.3).
          expect(otherPartitions(repo, store, callerUserId)).toBe(before);

          // Guard against a vacuous pass: a create that clears the gates really
          // did write, and it wrote into the caller's own partition — including
          // when the record claimed a different owner. Seeded Accounts hold at
          // most 21 records, so the cap is never the reason a create stops here.
          if (operation.kind === 'create') {
            const seed = store.seeds.find((entry) => entry.userId === callerUserId);
            const acknowledged = operation.ackStorage || seed?.storageAckAt !== undefined;
            const alreadyHeld = ownIdsOf(store, callerUserId).includes(
              operation.record.mealPlanId,
            );
            if (acknowledged && !alreadyHeld) {
              expect(repo.snapshotPartition(callerUserId)).toContain(
                operation.record.mealPlanId,
              );
            }
          }
        },
      ),
      { numRuns: 250 },
    );
  });

  // Feature: user-auth-and-cloud-storage, Property 5: Every store operation is
  // confined to the derived User_Id
  //
  // **Validates: Requirements 7.1, 7.2, 7.7**
  it('names the derived User_Id on every store command and offers no cross-partition read', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbConfinementCase(ALL_KINDS),
        async ({ store, callerUserId, operation, nowMs }) => {
          const repo = buildRepository(store, nowMs);

          await applyOperation(repo, callerUserId, operation);

          // At least one command was issued, and every one of them carried the
          // derived partition key — none omitted it, and none addressed another
          // Account's partition or the reserved one (Requirements 7.1, 7.2).
          expect(repo.calls.length).toBeGreaterThan(0);
          for (const call of repo.calls) {
            expect(call.userId).toBe(callerUserId);
            expect(call.userId.length).toBeGreaterThan(0);
          }

          // The port itself offers no scan or cross-partition lookup, which is
          // what makes "no operation reads across more than one User_Id" a
          // structural guarantee rather than a runtime check.
          for (const method of CROSS_PARTITION_METHODS) {
            expect(method in repo).toBe(false);
          }
        },
      ),
      { numRuns: 250 },
    );
  });
});

// ─── Property 10: reference model ──────────────────────────────────────────────

/**
 * One record as the reference model holds it.
 *
 * The model is written from the acceptance criteria rather than from the
 * repository, which is what makes the comparison meaningful: it keeps records in
 * a plain map keyed by Meal_Plan_Id, derives the record count from that map's
 * size rather than from a stored counter, and knows nothing of `#meta`, sort
 * keys, or serialized items. A disagreement is therefore either a repository bug
 * or a criterion the model reads differently.
 */
interface ModelRecord {
  title: string;
  createdAt: string;
  updatedAt: string;
  content: MealPlanContent;
}

/**
 * What a command is expected to return.
 *
 * `delete` returns nothing from the port, so its outcome is the constant
 * {@link NO_CONTENT} — which is exactly Requirement 8.3's claim that a delete
 * answers 204 whether or not the Account still holds the record.
 */
type CommandOutcome = SaveOutcome | { kind: 'no-content' };

const NO_CONTENT: CommandOutcome = { kind: 'no-content' };

/** Deep copy, so neither the model nor the repository can reach the other's state. */
function copyContent(content: MealPlanContent): MealPlanContent {
  return JSON.parse(JSON.stringify(content)) as MealPlanContent;
}

/**
 * Applies one command to the model, returning the outcome the repository owes.
 *
 * The three rules that matter, each straight from a criterion:
 *
 * - A create for an id the Account already holds writes nothing and still reports
 *   success, so one id means one record however often the save is resubmitted
 *   (Requirement 5.4).
 * - A create is refused once the Account holds {@link MEAL_PLAN_RECORD_CAP}
 *   records, and only then (Requirements 5.8, 5.9).
 * - An update or a rename keeps `createdAt`, and a rename keeps the content
 *   (Requirements 5.3, 8.4). Both are expressed here by carrying the existing
 *   fields forward rather than by trusting the command's copies of them.
 */
function applyToModel(model: Map<string, ModelRecord>, command: StoreCommand): CommandOutcome {
  switch (command.kind) {
    case 'create': {
      const { mealPlanId, title, createdAt, updatedAt, content } = command.record;
      if (model.has(mealPlanId)) return { kind: 'created', mealPlanId };
      if (model.size >= MEAL_PLAN_RECORD_CAP) return { kind: 'cap-reached' };
      model.set(mealPlanId, {
        title,
        createdAt,
        // A created record has `updatedAt` equal to `createdAt` (Requirement 5.2).
        updatedAt,
        content: copyContent(content),
      });
      return { kind: 'created', mealPlanId };
    }
    case 'update': {
      const { mealPlanId, title, updatedAt, content } = command.record;
      const existing = model.get(mealPlanId);
      if (existing === undefined) return { kind: 'not-found' };
      model.set(mealPlanId, {
        title,
        createdAt: existing.createdAt,
        updatedAt,
        content: copyContent(content),
      });
      return { kind: 'updated' };
    }
    case 'rename': {
      const existing = model.get(command.mealPlanId);
      if (existing === undefined) return { kind: 'not-found' };
      model.set(command.mealPlanId, {
        ...existing,
        title: command.title,
        updatedAt: new Date(command.atMs).toISOString(),
      });
      return { kind: 'updated' };
    }
    case 'delete':
      model.delete(command.mealPlanId);
      return NO_CONTENT;
  }
}

/** The Meal_Plan_Id a command is aimed at, whichever shape carries it. */
function targetOf(command: StoreCommand): string {
  return command.kind === 'create' || command.kind === 'update'
    ? command.record.mealPlanId
    : command.mealPlanId;
}

/** Runs one command against the repository. */
async function applyCommand(
  repo: InMemoryMealPlanRepository,
  userId: string,
  command: StoreCommand,
): Promise<CommandOutcome> {
  switch (command.kind) {
    case 'create':
      return repo.create(userId, command.record, command.ackStorage);
    case 'update':
      return repo.update(userId, command.record);
    case 'rename':
      return repo.rename(userId, command.mealPlanId, command.title, command.atMs);
    case 'delete':
      await repo.delete(userId, command.mealPlanId);
      return NO_CONTENT;
  }
}

/** Every summary the Account holds except the one for `mealPlanId`, newest first. */
async function siblingsOf(
  repo: InMemoryMealPlanRepository,
  userId: string,
  mealPlanId: string,
): Promise<MealPlanSummary[]> {
  const held = await traverseList(repo, userId);
  return held.filter((summary) => summary.mealPlanId !== mealPlanId);
}

/**
 * An empty repository whose clock is pinned to the sequence's first instant.
 *
 * `buildRepository` above is not reused because it seeds a multi-Account state,
 * and Property 10 starts from an Account holding nothing so the record count it
 * reaches is the sequence's own doing. The id generator is never reached: every
 * create in a sequence carries its own Meal_Plan_Id.
 */
function emptyRepository(sequence: CommandSequence): InMemoryMealPlanRepository {
  const startMs = sequence.commands[0].atMs;
  return createInMemoryMealPlanRepository({
    now: () => startMs,
    newMealPlanId: () => newMealPlanId(startMs),
  });
}

// ─── Property 10 ───────────────────────────────────────────────────────────────

describe('Property 10: save and delete sequences preserve identity and respect the record cap', () => {
  // Feature: user-auth-and-cloud-storage, Property 10: Save and delete sequences
  // preserve identity and respect the record cap
  //
  // **Validates: Requirements 5.2, 5.3, 5.4, 5.8, 5.9, 8.3, 8.4**
  it('agrees with an independent model command for command and never exceeds the record cap', async () => {
    await fc.assert(
      fc.asyncProperty(arbCommandSequence(), async (sequence) => {
        const repo = emptyRepository(sequence);
        const model = new Map<string, ModelRecord>();

        for (const [index, command] of sequence.commands.entries()) {
          const where = `command ${index} of ${sequence.shape} (${command.kind})`;
          const expected = applyToModel(model, command);

          expect(await applyCommand(repo, sequence.userId, command), where).toEqual(expected);

          // The cap holds after every command, and the counter the store keeps its
          // condition on agrees with the records actually held — a drift either way
          // would make the 409 fire at the wrong moment (Requirements 5.8, 5.9).
          const held = await traverseList(repo, sequence.userId);
          expect(held.length, where).toBeLessThanOrEqual(MEAL_PLAN_RECORD_CAP);
          expect(held.length, where).toBe(model.size);
        }

        // Every id in the store was introduced by a create in this sequence, and no
        // create introduced an id twice, so no id was assigned to two records
        // (Requirement 5.2).
        expect(new Set(sequence.createdMealPlanIds).size).toBe(
          sequence.createdMealPlanIds.length,
        );

        const stored = await repo.listAll(sequence.userId);
        expect([...stored].map((record) => record.mealPlanId).sort()).toEqual(
          [...model.keys()].sort(),
        );
        for (const record of stored) {
          expect(sequence.createdMealPlanIds).toContain(record.mealPlanId);
          const expectedRecord = model.get(record.mealPlanId);
          expect(expectedRecord).toBeDefined();
          expect(record).toStrictEqual({
            userId: sequence.userId,
            mealPlanId: record.mealPlanId,
            title: expectedRecord?.title,
            createdAt: expectedRecord?.createdAt,
            updatedAt: expectedRecord?.updatedAt,
            content: expectedRecord?.content,
          });
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: user-auth-and-cloud-storage, Property 10: Save and delete sequences
  // preserve identity and respect the record cap
  //
  // **Validates: Requirements 5.2, 5.3, 5.4, 8.3, 8.4**
  it('preserves identity on update and rename, and leaves repeats and absent deletes untouched', async () => {
    await fc.assert(
      fc.asyncProperty(arbCommandSequence(), async (sequence) => {
        const repo = emptyRepository(sequence);
        const userId = sequence.userId;

        for (const [index, command] of sequence.commands.entries()) {
          const where = `command ${index} of ${sequence.shape} (${command.kind})`;
          const mealPlanId = targetOf(command);
          const before = await repo.get(userId, mealPlanId);

          // A delete is the command whose blast radius the criteria name explicitly,
          // so its siblings are captured either side of it (Requirement 8.3).
          const siblingsBefore =
            command.kind === 'delete' ? await siblingsOf(repo, userId, mealPlanId) : [];

          const outcome = await applyCommand(repo, userId, command);
          const after = await repo.get(userId, mealPlanId);

          switch (command.kind) {
            case 'create':
              if (before !== null) {
                // A resubmitted save leaves the one record it already wrote exactly
                // as it stood, content, title, and `createdAt` alike, and still
                // reports success (Requirement 5.4).
                expect(outcome, where).toEqual({ kind: 'created', mealPlanId });
                expect(after, where).toStrictEqual(before);
              } else if (outcome.kind === 'created') {
                expect(after, where).not.toBeNull();
                expect(after?.mealPlanId, where).toBe(mealPlanId);
                expect(after?.createdAt, where).toBe(command.record.createdAt);
                // A created record's two timestamps are equal (Requirement 5.2).
                expect(after?.updatedAt, where).toBe(after?.createdAt);
              } else {
                // The only other answer is the cap, and it wrote nothing
                // (Requirement 5.9).
                expect(outcome, where).toEqual({ kind: 'cap-reached' });
                expect(after, where).toBeNull();
              }
              break;

            case 'update':
            case 'rename':
              if (before === null) {
                expect(outcome, where).toEqual({ kind: 'not-found' });
                expect(after, where).toBeNull();
                break;
              }
              expect(outcome, where).toEqual({ kind: 'updated' });
              // The id and the creation instant survive; the modification instant
              // never moves backwards (Requirements 5.3, 8.4).
              expect(after?.mealPlanId, where).toBe(before.mealPlanId);
              expect(after?.createdAt, where).toBe(before.createdAt);
              expect(Date.parse(after?.updatedAt ?? ''), where).toBeGreaterThanOrEqual(
                Date.parse(before.updatedAt),
              );
              if (command.kind === 'rename') {
                expect(after?.title, where).toBe(command.title);
                // A rename touches the title and nothing else (Requirement 8.4).
                expect(after?.content, where).toStrictEqual(before.content);
              }
              break;

            case 'delete':
              // 204 whether or not the record was still there, and the rest of the
              // Account is untouched either way (Requirement 8.3).
              expect(outcome, where).toEqual(NO_CONTENT);
              expect(after, where).toBeNull();
              expect(await siblingsOf(repo, userId, mealPlanId), where).toEqual(
                siblingsBefore,
              );
              break;
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 11: pagination scaffolding ───────────────────────────────────────

/** A seeded multi-Account state and the Account whose listing is walked. */
interface PaginationCase {
  store: MultiAccountStore;
  /** The User_Id the Meal_Plan_API would have derived from the verified token. */
  userId: string;
  nowMs: number;
}

/**
 * The caller includes `absentUserId`, so a traversal of an Account holding
 * nothing is exercised alongside the 1, 2, 3, 5, 19, 20, and 21-record shapes
 * `arbMultiAccountStore` draws — which is where the page boundary lives.
 */
function arbPaginationCase(): fc.Arbitrary<PaginationCase> {
  return arbMultiAccountStore().chain((store) =>
    fc
      .tuple(fc.constantFrom(...store.userIds, store.absentUserId), arbNowMs)
      .map(([userId, nowMs]) => ({ store, userId, nowMs })),
  );
}

/** A cursor issued while listing one Account, replayed by a different one. */
interface CursorReplayCase {
  store: MultiAccountStore;
  /** The Account whose traversal issued the cursor. */
  sourceUserId: string;
  /** The Account that replays it — always a different one. */
  replayUserId: string;
  nowMs: number;
}

function arbCursorReplayCase(): fc.Arbitrary<CursorReplayCase> {
  return arbMultiAccountStore().chain((store) => {
    const callers = [...store.userIds, store.absentUserId];
    return fc
      .tuple(fc.constantFrom(...callers), fc.constantFrom(...callers), arbNowMs)
      .filter(([sourceUserId, replayUserId]) => sourceUserId !== replayUserId)
      .map(([sourceUserId, replayUserId, nowMs]) => ({
        store,
        sourceUserId,
        replayUserId,
        nowMs,
      }));
  });
}

/**
 * Every page of a listing, kept whole rather than flattened.
 *
 * {@link traverseList} discards the page structure, and the page structure is
 * half of what Property 11 claims — the size bound and the cursor's presence are
 * statements about pages. The same {@link MAX_TRAVERSAL_PAGES} budget applies: a
 * traversal that exceeds it is a cursor that never terminates.
 */
async function collectPages(
  repo: InMemoryMealPlanRepository,
  userId: string,
): Promise<ListPage[]> {
  const pages: ListPage[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TRAVERSAL_PAGES; page += 1) {
    const result = await repo.list(userId, cursor);
    pages.push(result);
    if (result.nextCursor === undefined) return pages;
    cursor = result.nextCursor;
  }
  throw new Error(`list: traversal for ${userId} exceeded ${MAX_TRAVERSAL_PAGES} pages`);
}

/**
 * The order Requirement 6.2 asks for, derived from the seeded placements rather
 * than from the repository: creation timestamp descending, and records sharing a
 * creation timestamp by Meal_Plan_Id descending.
 *
 * The generator stamps records from a pool of one to three instants, so an
 * Account routinely holds several records with an identical `createdAt` and
 * distinct ULIDs. The tie-break below therefore decides real comparisons — an
 * implementation that ordered by timestamp alone would return a different
 * sequence, and one that ordered ascending would too.
 */
function expectedOrder(store: MultiAccountStore, userId: string): string[] {
  return store.placements
    .filter((placement) => placement.userId === userId)
    .slice()
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
      return a.mealPlanId < b.mealPlanId ? 1 : -1;
    })
    .map((placement) => placement.mealPlanId);
}

/** Sort keys the Account holds that sort strictly below `sk`, newest first. */
function ownIdsBelow(store: MultiAccountStore, userId: string, sk: string): string[] {
  return expectedOrder(store, userId).filter((mealPlanId) => mealPlanId < sk);
}

// ─── Property 11 ───────────────────────────────────────────────────────────────

describe('Property 11: pagination is complete, duplicate-free, ordered, and terminating', () => {
  // Feature: user-auth-and-cloud-storage, Property 11: Pagination is complete,
  // duplicate-free, ordered, and terminating
  //
  // **Validates: Requirements 6.2, 6.3, 6.8**
  it('yields pages of at most 20 records, each but the last carrying a continuation token', async () => {
    await fc.assert(
      fc.asyncProperty(arbPaginationCase(), async ({ store, userId, nowMs }) => {
        const repo = buildRepository(store, nowMs);

        // Reaching here at all is the termination claim: `collectPages` throws
        // rather than looping once the page budget is spent.
        const pages = await collectPages(repo, userId);
        expect(pages.length).toBeGreaterThan(0);

        for (const [index, page] of pages.entries()) {
          const where = `page ${index} of ${pages.length} for ${userId}`;
          expect(page.items.length, where).toBeLessThanOrEqual(MEAL_PLAN_PAGE_SIZE);

          const isFinal = index === pages.length - 1;
          if (isFinal) {
            // Requirement 6.8: the final page omits the token. An Account holding
            // exactly 20 records reaches it as an *empty* page, because a query
            // stopped by the limit hands back a position whether or not a record
            // remains — the same behavior the adapter inherits from the table.
            expect(page.nextCursor, where).toBeUndefined();
            continue;
          }

          // Requirement 6.3: more than 20 records means 20 records plus a token.
          expect(page.items.length, where).toBe(MEAL_PLAN_PAGE_SIZE);
          expect(page.nextCursor, where).toBeDefined();

          // The token names the page's last sort key, and the advance is strictly
          // exclusive — that key never comes back on a later page.
          const decoded = decodeCursor(page.nextCursor as string);
          expect(decoded.ok, where).toBe(true);
          const sk = decoded.ok ? decoded.sk : '';
          expect(sk, where).toBe(page.items[page.items.length - 1].mealPlanId);
          for (const later of pages.slice(index + 1)) {
            for (const summary of later.items) {
              expect(summary.mealPlanId < sk, where).toBe(true);
            }
          }
        }
      }),
      { numRuns: 250 },
    );
  });

  // Feature: user-auth-and-cloud-storage, Property 11: Pagination is complete,
  // duplicate-free, ordered, and terminating
  //
  // **Validates: Requirements 6.2, 6.3, 6.8**
  it("concatenates to the Account's whole partition exactly once, newest first with the Meal_Plan_Id tie-break", async () => {
    await fc.assert(
      fc.asyncProperty(arbPaginationCase(), async ({ store, userId, nowMs }) => {
        const repo = buildRepository(store, nowMs);

        const pages = await collectPages(repo, userId);
        const walked = pages.flatMap((page) => page.items);
        const ids = walked.map((summary) => summary.mealPlanId);

        // No omissions, no duplicates, and in exactly the order Requirement 6.2
        // specifies — including for the ids the Account shares with others, whose
        // `createdAt` values collide inside this partition.
        expect(ids).toEqual(expectedOrder(store, userId));
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.sort()).toEqual(ownIdsOf(store, userId));

        // The same order stated as a local invariant, so a coincidental agreement
        // with the reference sequence is not the only thing being checked.
        for (let i = 1; i < walked.length; i += 1) {
          const previous = walked[i - 1];
          const current = walked[i];
          expect(previous.createdAt >= current.createdAt).toBe(true);
          if (previous.createdAt === current.createdAt) {
            expect(previous.mealPlanId > current.mealPlanId).toBe(true);
          }
        }

        // `#meta` is excluded by the key condition, so the counter item never
        // appears as a row (Requirement 6.2).
        for (const summary of walked) {
          expect(summary.mealPlanId).not.toBe('#meta');
          expect(summary.title.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 250 },
    );
  });

  // Feature: user-auth-and-cloud-storage, Property 11: Pagination is complete,
  // duplicate-free, ordered, and terminating
  //
  // **Validates: Requirements 6.2, 6.3, 6.8**
  it('returns identical page sequences for two consecutive traversals of an unchanged Account', async () => {
    await fc.assert(
      fc.asyncProperty(arbPaginationCase(), async ({ store, userId, nowMs }) => {
        const repo = buildRepository(store, nowMs);

        const first = await collectPages(repo, userId);
        const second = await collectPages(repo, userId);

        // Requirement 6.2's "repeated list requests for an unchanged Account
        // return the same order": the tokens match too, so a client resuming from
        // a stored cursor lands where it did before.
        expect(second).toStrictEqual(first);
      }),
      { numRuns: 250 },
    );
  });

  // Feature: user-auth-and-cloud-storage, Property 11: Pagination is complete,
  // duplicate-free, ordered, and terminating
  //
  // **Validates: Requirements 6.3, 6.8**
  it("treats a cursor issued for another Account as a sort-key position inside the replaying caller's own partition", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbCursorReplayCase(),
        async ({ store, sourceUserId, replayUserId, nowMs }) => {
          const repo = buildRepository(store, nowMs);

          // Cursors the source Account's own traversal handed out, plus one built
          // at every sort key it holds — the id pool overlaps across Accounts, so
          // these are often positions the replaying Account also holds a record at.
          const issued = (await collectPages(repo, sourceUserId))
            .map((page) => page.nextCursor)
            .filter((cursor): cursor is string => cursor !== undefined);
          const cursors = [
            ...issued,
            ...ownIdsOf(store, sourceUserId).map((mealPlanId) => encodeCursor(mealPlanId)),
          ];

          for (const cursor of cursors) {
            const decoded = decodeCursor(cursor);
            expect(decoded.ok).toBe(true);
            const sk = decoded.ok ? decoded.sk : '';

            const page = await repo.list(replayUserId, cursor);

            // The cursor carries no User_Id, so replaying it changes nothing about
            // whose partition is read: the page is the replaying Account's own
            // records below that sort key, and it is exactly what a cursor the
            // replaying Account had issued itself at that key would return
            // (Requirements 6.3, 6.8).
            const expected = ownIdsBelow(store, replayUserId, sk).slice(0, MEAL_PLAN_PAGE_SIZE);
            expect(page.items.map((summary) => summary.mealPlanId)).toEqual(expected);
            for (const summary of page.items) {
              expect(ownIdsOf(store, replayUserId)).toContain(summary.mealPlanId);
            }
          }

          // Resuming from a foreign cursor still terminates, and still sees only
          // the replaying Account's own records.
          if (cursors.length > 0) {
            const items: MealPlanSummary[] = [];
            let cursor: string | undefined = cursors[0];
            for (let page = 0; page < MAX_TRAVERSAL_PAGES; page += 1) {
              const result: ListPage = await repo.list(replayUserId, cursor);
              items.push(...result.items);
              cursor = result.nextCursor;
              if (cursor === undefined) break;
            }
            expect(cursor).toBeUndefined();
            expect(items.map((summary) => summary.mealPlanId)).toEqual(
              ownIdsBelow(
                store,
                replayUserId,
                decodeCursor(cursors[0]).ok
                  ? (decodeCursor(cursors[0]) as { ok: true; sk: string }).sk
                  : '',
              ),
            );
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});
// ─── Property 12: size-guard scaffolding ───────────────────────────────────────

/**
 * Which side of the boundary this property is asserted on, and why.
 *
 * The design places the 100 KB check in the Meal_Plan_API, *before* it delegates
 * to the Meal_Plan_Store: the failure table records "Store touched: No" for the
 * 413 row, and the traceability table names `serializedByteLength` check before
 * write as the mechanism. So the subject here is that composition —
 * `serializedByteLength` over the serialized item, then a store call only if the
 * measurement fits — rather than the DynamoDB adapter's own belt-and-braces
 * `MealPlanTooLargeError`, which fires after the request has already reached the
 * adapter and needs a live client to observe.
 *
 * {@link saveThroughSizeGuard} is that composition, standing in for the route
 * handler that task 6 will write. What the property actually falsifies is not the
 * three lines of the guard but everything underneath them:
 *
 * - that `serializedByteLength` classifies a plan against the ceiling the way the
 *   stored item really measures — in UTF-8 bytes of the item the SDK puts on the
 *   wire, not in characters, so a plan of 40,000 CJK code points is over the
 *   ceiling while one of 90,000 ASCII characters is under it;
 * - that a rejected save leaves the store completely untouched, which the
 *   {@link InMemoryMealPlanRepository} `calls` ledger answers directly: it records
 *   every *attempted* operation before any condition is evaluated, so a write that
 *   was issued and then refused would still appear;
 * - that the ceiling is exclusive, so a plan measuring exactly 102,400 bytes still
 *   saves and one measuring 102,401 does not.
 */
type SizeOp = 'create' | 'update';

/** What the Meal_Plan_API answers for a save, reduced to what Requirement 5.7 fixes. */
interface GuardResult {
  status: 200 | 201 | 413;
  kind: 'too-large' | SaveOutcome['kind'];
  byteLength: number;
}

/**
 * The Meal_Plan_API's save path as far as Requirement 5.7 constrains it: measure
 * the serialized item, answer 413 without delegating when it exceeds the ceiling,
 * and otherwise hand the record to the store.
 *
 * `userId` wins over `record.userId`, as it does everywhere else in this file —
 * the API measures the item it would actually write (Requirement 4.4).
 */
async function saveThroughSizeGuard(
  repo: InMemoryMealPlanRepository,
  userId: string,
  record: MealPlanRecord,
  op: SizeOp,
): Promise<GuardResult> {
  const byteLength = serializedByteLength(serializeMealPlanRecord({ ...record, userId }));
  if (byteLength > MAX_SERIALIZED_BYTES) {
    return { status: 413, kind: 'too-large', byteLength };
  }

  const outcome =
    op === 'create'
      ? await repo.create(userId, record, true)
      : await repo.update(userId, record);
  return { status: op === 'create' ? 201 : 200, kind: outcome.kind, byteLength };
}

// ─── Fixtures large enough to cross the ceiling ────────────────────────────────

/** Meals and items per meal in a padded fixture: the maxima of Requirement 9.7. */
const PAD_MEALS = SERIALIZER_BOUNDS.meals.max;
const PAD_ITEMS = SERIALIZER_BOUNDS.itemsPerMeal.max;
const PAD_SLOTS = PAD_MEALS * PAD_ITEMS;

/** One-byte and three-byte padding characters, each exactly one code point. */
const NARROW_PAD = 'x';
const WIDE_PAD = '好';

/** UTF-8 cost of one padding character. */
function padCost(padChar: string): number {
  return new TextEncoder().encode(padChar).length;
}

/**
 * Padding capacity of one fixture, in characters.
 *
 * Every string starts one character long, so each slot can absorb its bound minus
 * one; the summary starts empty and can absorb its whole bound. The skeleton's
 * JSON structure is fixed across every fixture, which is what makes the byte
 * length linear in the number of padding characters added.
 */
const PAD_CAPACITY =
  PAD_SLOTS *
    (SERIALIZER_BOUNDS.itemNote.max -
      1 +
      (SERIALIZER_BOUNDS.itemName.max - 1) +
      (SERIALIZER_BOUNDS.portion.max - 1)) +
  SERIALIZER_BOUNDS.summary.max;

/** A deterministic ULID factory, so a reported counterexample replays exactly. */
const fixedUlid = ulidFactory(() => 0.5);

const FIXTURE_USER_ID = 'sizeGuardAccount0000000000';
const FIXTURE_CREATED_MS = Date.UTC(2031, 4, 17, 8, 30, 0, 0);
const FIXTURE_MEAL_PLAN_ID = fixedUlid(FIXTURE_CREATED_MS);
const FIXTURE_CREATED_AT = new Date(FIXTURE_CREATED_MS).toISOString();

/** How many padding characters each string of a fixture carries. */
interface PadPlan {
  notes: number[];
  names: number[];
  portions: number[];
  summary: number;
}

/**
 * Spreads `padChars` over the fixture's slots: notes first, then item names, then
 * portions, then the summary. The order is arbitrary; what matters is that the
 * result is a pure function of the count and that every bound stays satisfied.
 */
function planPadding(padChars: number): PadPlan {
  if (padChars < 0 || padChars > PAD_CAPACITY) {
    throw new RangeError(`planPadding: ${padChars} outside 0..${PAD_CAPACITY}`);
  }

  let left = padChars;
  const spread = (capacity: number): number[] => {
    const slots = new Array<number>(PAD_SLOTS).fill(0);
    for (let i = 0; i < PAD_SLOTS && left > 0; i += 1) {
      slots[i] = Math.min(capacity, left);
      left -= slots[i];
    }
    return slots;
  };

  const notes = spread(SERIALIZER_BOUNDS.itemNote.max - 1);
  const names = spread(SERIALIZER_BOUNDS.itemName.max - 1);
  const portions = spread(SERIALIZER_BOUNDS.portion.max - 1);
  const summary = Math.min(SERIALIZER_BOUNDS.summary.max, left);
  left -= summary;
  if (left > 0) throw new RangeError(`planPadding: ${padChars} did not fit`);

  return { notes, names, portions, summary };
}

/**
 * A Meal_Plan_Record satisfying every bound in Requirement 9.7, carrying
 * `padChars` copies of `padChar` beyond its one-character skeleton.
 *
 * The record is well-formed in every respect other than its size, which is the
 * "otherwise satisfies every bound" half of Property 12: a rejection can only be
 * about the ceiling, since nothing else is wrong with it.
 */
function paddedRecord(padChars: number, padChar: string): MealPlanRecord {
  const plan = planPadding(padChars);

  const meals: MealEntry[] = [];
  for (let m = 0; m < PAD_MEALS; m += 1) {
    const items: MealPlanItemEntry[] = [];
    for (let i = 0; i < PAD_ITEMS; i += 1) {
      const slot = m * PAD_ITEMS + i;
      items.push({
        name: NARROW_PAD + padChar.repeat(plan.names[slot]),
        portion: NARROW_PAD + padChar.repeat(plan.portions[slot]),
        notes: NARROW_PAD + padChar.repeat(plan.notes[slot]),
      });
    }
    meals.push({ mealName: NARROW_PAD, items });
  }

  return {
    userId: FIXTURE_USER_ID,
    mealPlanId: FIXTURE_MEAL_PLAN_ID,
    title: 'size guard fixture',
    createdAt: FIXTURE_CREATED_AT,
    updatedAt: FIXTURE_CREATED_AT,
    content: { meals, summary: padChar.repeat(plan.summary) },
  };
}

/** Serialized size of the unpadded fixture, from which every target is derived. */
const SKELETON_BYTES = serializedByteLength(serializeMealPlanRecord(paddedRecord(0, NARROW_PAD)));

/**
 * A fixture measuring exactly `targetBytes`.
 *
 * Padding with a one-byte character adds exactly one byte per character to the
 * item's JSON form, so the target is hit on the nose rather than approached — the
 * tests assert as much, which keeps a boundary case from silently landing a byte
 * off the boundary it was meant to sit on.
 */
function recordOfByteLength(targetBytes: number): MealPlanRecord {
  if (targetBytes < SKELETON_BYTES) {
    throw new RangeError(`recordOfByteLength: ${targetBytes} below skeleton ${SKELETON_BYTES}`);
  }
  return paddedRecord(targetBytes - SKELETON_BYTES, NARROW_PAD);
}

/** Largest wide-character padding that still fits under the ceiling. */
const WIDE_PAD_AT_CEILING = Math.floor((MAX_SERIALIZED_BYTES - SKELETON_BYTES) / padCost(WIDE_PAD));

/** Every Patient-authored string of a record, for a code point count. */
function codePointTotal(record: MealPlanRecord): number {
  const strings = [record.title, record.content.summary, ...(record.content.warnings ?? [])];
  for (const meal of record.content.meals) {
    strings.push(meal.mealName);
    for (const item of meal.items) strings.push(item.name, item.portion, item.notes ?? '');
  }
  return strings.reduce((total, value) => total + Array.from(value).length, 0);
}

/** The largest record Requirement 9.7 permits: every bound at its maximum. */
function saturatedRecord(): MealPlanRecord {
  const base = paddedRecord(PAD_CAPACITY, NARROW_PAD);
  return {
    ...base,
    title: NARROW_PAD.repeat(SERIALIZER_BOUNDS.title.max),
    content: {
      ...base.content,
      warnings: new Array<string>(SERIALIZER_BOUNDS.warnings.max).fill(
        NARROW_PAD.repeat(SERIALIZER_BOUNDS.warning.max),
      ),
    },
  };
}

// ─── Property 12 generators ────────────────────────────────────────────────────

/** A candidate save, with the measurement that decides its fate. */
interface SizeCase {
  record: MealPlanRecord;
  byteLength: number;
  oversized: boolean;
  /** How the record was built, so a counterexample says which shape broke. */
  label: string;
}

function classify(record: MealPlanRecord, label: string): SizeCase {
  const byteLength = serializedByteLength(serializeMealPlanRecord(record));
  return { record, byteLength, oversized: byteLength > MAX_SERIALIZED_BYTES, label };
}

/**
 * Plans over the ceiling, from a single byte over it to the largest record the
 * bounds permit, and including one whose code point count is well under 100,000
 * while its UTF-8 size is well over — the case a character-counting guard would
 * wave through.
 */
function arbOversizedCase(): fc.Arbitrary<SizeCase> {
  return fc.oneof(
    {
      weight: 4,
      arbitrary: fc
        .integer({ min: 1, max: 64 * 1024 })
        .map((over) =>
          classify(recordOfByteLength(MAX_SERIALIZED_BYTES + over), `${over} bytes over`),
        ),
    },
    {
      weight: 3,
      arbitrary: fc
        .integer({ min: WIDE_PAD_AT_CEILING + 1, max: 90_000 })
        .map((chars) => classify(paddedRecord(chars, WIDE_PAD), `${chars} wide characters`)),
    },
    { weight: 1, arbitrary: fc.constant(classify(saturatedRecord(), 'every bound at maximum')) },
  );
}

/**
 * Plans at or below the ceiling: ordinary generated records, fixtures sitting
 * within 8 KB of the ceiling including one measuring exactly 102,400 bytes, and
 * wide-character fixtures whose byte size approaches the ceiling from below.
 */
function arbWithinCeilingCase(): fc.Arbitrary<SizeCase> {
  return fc.oneof(
    {
      weight: 4,
      arbitrary: arbMealPlanRecord()
        .map((record) => classify(record, 'generated'))
        .filter((size) => !size.oversized),
    },
    {
      weight: 3,
      arbitrary: fc
        .integer({ min: 0, max: 8 * 1024 })
        .map((under) =>
          classify(recordOfByteLength(MAX_SERIALIZED_BYTES - under), `${under} bytes under`),
        ),
    },
    {
      weight: 1,
      arbitrary: fc
        .integer({ min: 1, max: WIDE_PAD_AT_CEILING })
        .map((chars) => classify(paddedRecord(chars, WIDE_PAD), `${chars} wide characters`)),
    },
  );
}

/**
 * A repository holding nothing for the calling Account beyond an acknowledgment —
 * and, for an update, one small record already stored under the same
 * Meal_Plan_Id, so an oversized update has something it could damage.
 */
function sizeGuardRepository(
  record: MealPlanRecord,
  userId: string,
  op: SizeOp,
  nowMs: number,
): InMemoryMealPlanRepository {
  const repo = createInMemoryMealPlanRepository({
    now: () => nowMs,
    newMealPlanId: () => record.mealPlanId,
  });
  repo.seed([
    {
      userId,
      // Acknowledged, so a create that clears the size guard is not stopped by the
      // storage-notice gate instead (Requirement 12.3) — which would make a "no
      // write happened" assertion pass for the wrong reason.
      storageAckAt: new Date(nowMs).toISOString(),
      records: op === 'update' ? [seededVariantOf(record, userId)] : [],
    },
  ]);
  repo.clearCalls();
  return repo;
}

/** A one-meal record at the same key, small enough to be nowhere near the ceiling. */
function seededVariantOf(record: MealPlanRecord, userId: string): MealPlanRecord {
  return {
    ...record,
    userId,
    title: 'already stored',
    content: {
      meals: [{ mealName: 'stored meal', items: [{ name: 'stored item', portion: '1 cup' }] }],
      summary: 'stored summary',
    },
  };
}

const arbSizeOp = fc.constantFrom<SizeOp[]>('create', 'update');

// ─── Property 12 ───────────────────────────────────────────────────────────────

describe('Property 12: oversized plans are rejected without a write', () => {
  // Feature: user-auth-and-cloud-storage, Property 12: Oversized plans are
  // rejected without a write
  //
  // **Validates: Requirements 5.7**
  it('answers 413 and issues no store command at all for a plan over the ceiling', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbOversizedCase(),
        arbSizeOp,
        arbNowMs,
        async (size, op, nowMs) => {
          const userId = size.record.userId;
          const repo = sizeGuardRepository(size.record, userId, op, nowMs);
          const before = repo.snapshot();
          const where = `${op} of ${size.label} (${size.byteLength} bytes)`;

          // Guard against a vacuous pass: the fixture really is over the ceiling.
          expect(size.byteLength, where).toBeGreaterThan(MAX_SERIALIZED_BYTES);

          const result = await saveThroughSizeGuard(repo, userId, size.record, op);

          expect(result.status, where).toBe(413);
          expect(result.kind, where).toBe('too-large');

          // The ledger records every *attempted* operation, so an issued-then-refused
          // write would appear here. Nothing does: the store was never reached
          // (Requirement 5.7, "Store touched: No").
          expect(repo.calls, where).toEqual([]);
          expect(repo.snapshot(), where).toBe(before);

          // An oversized update leaves the record it addressed exactly as it stood.
          if (op === 'update') {
            const stored = await repo.get(userId, size.record.mealPlanId);
            expect(stored?.title, where).toBe('already stored');
            expect(stored?.content, where).toStrictEqual(
              seededVariantOf(size.record, userId).content,
            );
          }
        },
      ),
      { numRuns: 150 },
    );
  });

  // Feature: user-auth-and-cloud-storage, Property 12: Oversized plans are
  // rejected without a write
  //
  // **Validates: Requirements 5.7**
  it('does not reject a plan at or below the ceiling for size, and stores it', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbWithinCeilingCase(),
        arbSizeOp,
        arbNowMs,
        async (size, op, nowMs) => {
          const userId = size.record.userId;
          const repo = sizeGuardRepository(size.record, userId, op, nowMs);
          const where = `${op} of ${size.label} (${size.byteLength} bytes)`;

          expect(size.byteLength, where).toBeLessThanOrEqual(MAX_SERIALIZED_BYTES);

          const result = await saveThroughSizeGuard(repo, userId, size.record, op);

          // No 413, and the save went through on its merits rather than being held
          // back by the size check.
          expect(result.status, where).not.toBe(413);
          expect(result.kind, where).toBe(op === 'create' ? 'created' : 'updated');

          // Exactly one store command was attempted, it was the save, and it named
          // the derived User_Id.
          expect(repo.calls.map((call) => call.op), where).toEqual([op]);
          expect(repo.calls[0].access, where).toBe('write');
          expect(repo.calls[0].userId, where).toBe(userId);

          // And the plan really is in the store, content and all.
          const stored = await repo.get(userId, size.record.mealPlanId);
          expect(stored, where).not.toBeNull();
          expect(stored?.content, where).toStrictEqual(size.record.content);
        },
      ),
      { numRuns: 150 },
    );
  });

  // Feature: user-auth-and-cloud-storage, Property 12: Oversized plans are
  // rejected without a write
  //
  // **Validates: Requirements 5.7**
  it('treats the ceiling as exclusive and measured in UTF-8 bytes, not characters', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -2, max: 2 }),
        arbSizeOp,
        arbNowMs,
        async (offset, op, nowMs) => {
          const target = MAX_SERIALIZED_BYTES + offset;
          const record = recordOfByteLength(target);
          const userId = record.userId;
          const where = `${op} at ${target} bytes`;

          // The fixture sits exactly on its target, so the boundary being probed is
          // the real one.
          expect(serializedByteLength(serializeMealPlanRecord(record)), where).toBe(target);

          const repo = sizeGuardRepository(record, userId, op, nowMs);
          const result = await saveThroughSizeGuard(repo, userId, record, op);

          if (offset > 0) {
            expect(result.status, where).toBe(413);
            expect(repo.calls, where).toEqual([]);
          } else {
            // 102,400 bytes exactly is not "exceeds 100 kilobytes".
            expect(result.status, where).not.toBe(413);
            expect(repo.calls.map((call) => call.op), where).toEqual([op]);
          }

          // The same boundary, drawn in three-byte characters: both fixtures below
          // hold roughly 30,000 code points — two orders of magnitude under the
          // 102,400 the ceiling names — yet one crosses it and the other does not,
          // which only holds if the measure is bytes.
          const fits = paddedRecord(WIDE_PAD_AT_CEILING, WIDE_PAD);
          const spills = paddedRecord(WIDE_PAD_AT_CEILING + 1, WIDE_PAD);
          expect(codePointTotal(spills)).toBeLessThan(MAX_SERIALIZED_BYTES);

          const fitsRepo = sizeGuardRepository(fits, userId, op, nowMs);
          expect((await saveThroughSizeGuard(fitsRepo, userId, fits, op)).status).not.toBe(413);

          const spillsRepo = sizeGuardRepository(spills, userId, op, nowMs);
          expect((await saveThroughSizeGuard(spillsRepo, userId, spills, op)).status).toBe(413);
          expect(spillsRepo.calls).toEqual([]);
        },
      ),
      { numRuns: 60 },
    );
  });
});

// ─── Property 6: unusable-id scaffolding ───────────────────────────────────────

/**
 * What this property drives, and why it lives in this file.
 *
 * Property 6 is a statement about the Meal_Plan_API's *responses*, not about the
 * store, so it runs the real `/api/meal-plans/{mealPlanId}` handlers — the ones
 * `createMealPlanItemRouteHandlers` builds — over `createInMemoryMealPlanRepository`
 * with a stubbed {@link AuthTokenVerifier}. The repository is the same one every
 * other property in this file uses, which is what lets a single case assert both
 * halves of the claim: what came back over the wire, and that the table underneath
 * did not move. Its `calls` ledger records every *attempted* operation before any
 * condition is evaluated, so Requirement 7.8's "no read or write" is answered
 * directly rather than inferred from unchanged state.
 *
 * The three classes of unusable reference, as Requirements 7.3, 7.4, and 7.8
 * define them:
 *
 * - **owned-elsewhere** — a Meal_Plan_Id another Account holds and the caller does
 *   not. `arbMultiAccountStore` gives the same id different content in different
 *   partitions, so a handler that leaked would return a plausible record rather
 *   than nothing.
 * - **nonexistent** — a charset-valid id no Account holds: the store's
 *   `absentMealPlanId` (a ULID outside the seeded pool) and lowercase ids that no
 *   uppercase ULID can equal, including one at the 64-character boundary.
 * - **malformed** — empty, longer than 64 characters, or carrying a character
 *   outside letters, digits, and hyphens. Reserved keys such as `#meta` and
 *   `PENDING#DELETION` fall in here, which is what keeps a crafted id from
 *   addressing them.
 *
 * `DELETE` is asserted separately, and the split is the design's, not a
 * concession. The endpoint table fixes `DELETE` at `204` "also when already
 * absent" (Requirement 8.3) with `404` reserved for a malformed id
 * (Requirement 7.8). So for `DELETE` the indistinguishability claim is that
 * owned-elsewhere, nonexistent, and *the caller's own held record* all answer with
 * the same 204 and the same empty body — ownership is unobservable — while a
 * malformed id is refused before the store is reached at all.
 */

/** The four methods `/api/meal-plans/{mealPlanId}` serves. */
type ItemMethod = 'GET' | 'PUT' | 'PATCH' | 'DELETE';

/** How a Meal_Plan_Id reference is unusable (Requirements 7.3, 7.4, 7.8). */
type UnusableIdClass = 'owned-elsewhere' | 'nonexistent' | 'malformed';

const UNUSABLE_ID_CLASSES: readonly UnusableIdClass[] = [
  'owned-elsewhere',
  'nonexistent',
  'malformed',
];

/** The methods whose answer is the frozen 404 for all three classes alike. */
const NOT_FOUND_METHODS: readonly ItemMethod[] = ['GET', 'PUT', 'PATCH'];

const ALL_ITEM_METHODS: readonly ItemMethod[] = ['GET', 'PUT', 'PATCH', 'DELETE'];

/** The exact bytes and field set every unusable-id answer must carry. */
const NOT_FOUND_JSON_BYTES = JSON.stringify(NOT_FOUND_BODY);
const NOT_FOUND_FIELDS = Object.keys(NOT_FOUND_BODY).sort();

/** Characters a Meal_Plan_Id may contain (Requirement 7.8). */
const ID_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-'.split('');

/** Characters it may not, including the `#` of the store's reserved keys. */
const ID_FOREIGN_CHARS = [' ', '#', '_', '/', '.', '%', ':', '*', '?', '+', '=', '\n', 'é', '好'];

/** A malformed Meal_Plan_Id, with the shape named so a counterexample is legible. */
interface MalformedId {
  id: string;
  shape: 'empty' | 'too-long' | 'foreign-character' | 'reserved-key';
}

const arbValidCharRun = (min: number, max: number): fc.Arbitrary<string> =>
  fc.array(fc.constantFrom(...ID_CHARSET), { minLength: min, maxLength: max }).map((chars) =>
    chars.join(''),
  );

/**
 * Every way Requirement 7.8 says an id can be malformed: empty, over 64
 * characters, and carrying a character outside the charset — the last including
 * the store's own reserved keys, whose `#` is precisely what excludes them.
 */
function arbMalformedMealPlanId(): fc.Arbitrary<MalformedId> {
  return fc.oneof(
    { weight: 1, arbitrary: fc.constant<MalformedId>({ id: '', shape: 'empty' }) },
    {
      weight: 3,
      arbitrary: arbValidCharRun(65, 128).map<MalformedId>((id) => ({ id, shape: 'too-long' })),
    },
    {
      weight: 4,
      arbitrary: fc
        .tuple(arbValidCharRun(0, 20), fc.constantFrom(...ID_FOREIGN_CHARS), arbValidCharRun(0, 20))
        .map<MalformedId>(([head, foreign, tail]) => ({
          id: `${head}${foreign}${tail}`,
          shape: 'foreign-character',
        })),
    },
    {
      weight: 2,
      arbitrary: fc
        .constantFrom('#meta', 'PENDING#DELETION', '#meta#', 'PENDING#DELETION#0')
        .map<MalformedId>((id) => ({ id, shape: 'reserved-key' })),
    },
  );
}

/**
 * A charset-valid Meal_Plan_Id no Account holds: the seeded state's own
 * `absentMealPlanId`, or a lowercase id — which no uppercase Crockford ULID can
 * equal — at lengths up to the 64-character bound.
 *
 * The lowercase ids are deliberately not ULIDs. Such an id passes the charset
 * check and so must not be refused before the store is reached, yet it can name
 * no stored record, which is the "exists under no Account" case at its most
 * awkward.
 */
function arbNonexistentMealPlanId(store: MultiAccountStore): fc.Arbitrary<string> {
  const arbLowercase = (length: number): fc.Arbitrary<string> =>
    fc
      .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')), {
        minLength: length - 1,
        maxLength: length - 1,
      })
      .map((chars) => `x${chars.join('')}`);

  return fc.oneof(
    { weight: 3, arbitrary: fc.constant(store.absentMealPlanId) },
    { weight: 3, arbitrary: fc.integer({ min: 1, max: 40 }).chain(arbLowercase) },
    // The upper bound of the accepted range, which is accepted rather than refused.
    { weight: 1, arbitrary: arbLowercase(64) },
  );
}

/** A rename title inside Requirement 8.4's bound, so `PATCH` reaches the store. */
const arbRenameTitle = arbTrickyString(1, 40).map((raw) => {
  const trimmed = raw.trim();
  return trimmed.length === 0 ? 'Renamed plan' : trimmed;
});

/** A `PUT` body: valid content, and small. */
interface SaveBody {
  title: string;
  content: MealPlanContent;
}

/**
 * A save body that satisfies every Requirement 9.7 bound and sits nowhere near
 * the 100 kilobyte ceiling, so a refusal can only be about the Meal_Plan_Id.
 *
 * The strings are still {@link arbTrickyString} draws — emoji, bidi marks, and
 * quotation marks all appear — but one meal of one item keeps the serialized item
 * a few hundred bytes rather than the tens of thousands a full record reaches.
 * That matters twice over: an oversized body would answer 413 instead of the 404
 * under test, and serializing one per request is what made this property slow.
 */
const arbSaveBody: fc.Arbitrary<SaveBody> = fc
  .record({
    title: arbTrickyString(1, 40),
    mealName: arbTrickyString(1, 20),
    name: arbTrickyString(1, 20),
    portion: arbTrickyString(1, 20),
    notes: fc.option(arbTrickyString(1, 40), { nil: undefined }),
    summary: arbTrickyString(0, 60),
  })
  .map(({ title, mealName, name, portion, notes, summary }) => ({
    title,
    content: {
      meals: [
        {
          mealName,
          items: [notes === undefined ? { name, portion } : { name, portion, notes }],
        },
      ],
      summary,
    },
  }));

/** One id from each class, aimed at one Account of a seeded multi-Account state. */
interface UnusableIdCase {
  store: MultiAccountStore;
  /** The User_Id the Meal_Plan_API would have derived from the verified token. */
  callerUserId: string;
  /** Held by another Account, not by the caller (Requirement 7.3). */
  ownedElsewhereId: string;
  /** Held by no Account at all (Requirement 7.4). */
  nonexistentId: string;
  /** Empty, over-long, or outside the charset (Requirement 7.8). */
  malformed: MalformedId;
  /** An id the caller does hold, when it holds any: the control case. */
  ownId: string | undefined;
  nowMs: number;
  /** A valid `PUT` body, so a rejection can only be about the id. */
  save: SaveBody;
  /** A valid `PATCH` title, for the same reason. */
  renameTitle: string;
}

/** Ids some other Account holds and this one does not. */
function foreignIdsOf(store: MultiAccountStore, callerUserId: string): string[] {
  const own = new Set(ownIdsOf(store, callerUserId));
  return Array.from(
    new Set(
      store.placements
        .filter((placement) => placement.userId !== callerUserId)
        .map((placement) => placement.mealPlanId)
        .filter((mealPlanId) => !own.has(mealPlanId)),
    ),
  );
}

/** The record another Account holds at `mealPlanId`, for the leak check. */
function recordHeldElsewhere(
  store: MultiAccountStore,
  callerUserId: string,
  mealPlanId: string,
): MealPlanRecord {
  for (const seed of store.seeds) {
    if (seed.userId === callerUserId) continue;
    const found = (seed.records ?? []).find((record) => record.mealPlanId === mealPlanId);
    if (found !== undefined) return found;
  }
  throw new Error(`recordHeldElsewhere: ${mealPlanId} is held by no other Account`);
}

/**
 * The caller is drawn from the Accounts for which an owned-elsewhere id exists at
 * all, which always includes `absentUserId` — an Account holding nothing, for
 * which every seeded id is foreign.
 */
function arbUnusableIdCase(): fc.Arbitrary<UnusableIdCase> {
  return arbMultiAccountStore()
    .filter((store) => store.placements.length > 0)
    .chain((store) => {
      const callers = [...store.userIds, store.absentUserId].filter(
        (userId) => foreignIdsOf(store, userId).length > 0,
      );
      return fc
        .tuple(
          fc.constantFrom(...callers),
          arbNowMs,
          arbMalformedMealPlanId(),
          arbNonexistentMealPlanId(store),
          arbSaveBody,
          arbRenameTitle,
        )
        .chain(([callerUserId, nowMs, malformed, nonexistentId, save, renameTitle]) =>
          fc.constantFrom(...foreignIdsOf(store, callerUserId)).map((ownedElsewhereId) => ({
            store,
            callerUserId,
            ownedElsewhereId,
            nonexistentId,
            malformed,
            ownId: ownIdsOf(store, callerUserId)[0],
            nowMs,
            save,
            renameTitle,
          })),
        );
    });
}

/** A verifier that always yields `userId`, so the handlers run past `withAuth`. */
function verifierFor(userId: string, nowMs: number): AuthTokenVerifier {
  const identity: VerifiedIdentity = {
    userId,
    authTimeMs: nowMs,
    email: 'patient@example.com',
    displayName: 'Patient',
  };
  return { verifyAuthToken: async () => ({ ok: true, identity }) };
}

/** Everything Property 6 compares between one request and another. */
interface RouteObservation {
  status: number;
  /** The response body's exact bytes, as text. */
  body: string;
  /** Response field names, sorted. Empty for a bodiless response. */
  fields: string[];
  /** Response headers as sorted `name: value` lines — also part of what must not vary. */
  headers: string;
  /** Store commands *attempted* by this request, including any the store refused. */
  storeCalls: number;
}

/** One seeded store with the real handlers mounted over it. */
interface ItemRouteHarness {
  repo: InMemoryMealPlanRepository;
  /** Issues one request and reports everything observable about the answer. */
  request(method: ItemMethod, mealPlanId: string): Promise<RouteObservation>;
  /** Stable serialization of the whole table. */
  snapshot(): string;
}

/**
 * Mounts the handlers over one seeded store.
 *
 * One harness serves every request a case needs rather than one per request: the
 * seeded state runs to a hundred records of tricky content, so building and
 * snapshotting it is the expensive part, and a request that answers with the
 * frozen 404 changes nothing that a later request in the same case could see. The
 * `calls` ledger is emptied before each request so the count reported is that
 * request's own. The delete control, which does mutate, takes its own harness.
 */
function harnessFor(idCase: UnusableIdCase): ItemRouteHarness {
  const { store, callerUserId, nowMs, save, renameTitle } = idCase;
  const repo = buildRepository(store, nowMs);
  const handlers = createMealPlanItemRouteHandlers({
    repository: repo,
    now: () => nowMs,
    verifier: verifierFor(callerUserId, nowMs),
  });

  return {
    repo,
    snapshot: () => repo.snapshot(),
    async request(method, mealPlanId): Promise<RouteObservation> {
      const url = `https://example.com/api/meal-plans/${encodeURIComponent(mealPlanId)}`;
      const request =
        method === 'GET' || method === 'DELETE'
          ? new Request(url, { method })
          : new Request(url, {
              method,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(method === 'PUT' ? save : { title: renameTitle }),
            });

      repo.clearCalls();
      const response = await handlers[method](request, { params: { mealPlanId } });
      const body = await response.text();

      return {
        status: response.status,
        body,
        fields: body === '' ? [] : Object.keys(JSON.parse(body) as Record<string, unknown>).sort(),
        headers: Array.from(response.headers.entries())
          .map(([name, value]) => `${name}: ${value}`)
          .sort()
          .join('\n'),
        storeCalls: repo.calls.length,
      };
    },
  };
}

/** The id of the given class, for the given case. */
function idOfClass(idCase: UnusableIdCase, unusable: UnusableIdClass): string {
  switch (unusable) {
    case 'owned-elsewhere':
      return idCase.ownedElsewhereId;
    case 'nonexistent':
      return idCase.nonexistentId;
    case 'malformed':
      return idCase.malformed.id;
  }
}

/**
 * Strings from a record held elsewhere that must not appear in any response.
 *
 * Only values of eight characters or more are collected: a one or two character
 * meal name can occur inside "That meal plan was not found." by coincidence,
 * which would make a leak check fail for a reason that is not a leak. The owner's
 * User_Id, the record's title, and both timestamps clear that bar comfortably, so
 * the four things Requirement 7.3 names are all covered.
 */
function longSecretsOf(record: MealPlanRecord): string[] {
  const values = [
    record.userId,
    record.title,
    record.createdAt,
    record.updatedAt,
    record.content.summary,
    ...(record.content.warnings ?? []),
  ];
  for (const meal of record.content.meals) {
    values.push(meal.mealName);
    for (const item of meal.items) values.push(item.name, item.portion, item.notes ?? '');
  }
  return values.filter((value) => value.length >= 8);
}

// ─── Property 6 ────────────────────────────────────────────────────────────────

describe('Property 6: unusable Meal_Plan_Id references are indistinguishable', () => {
  // Feature: user-auth-and-cloud-storage, Property 6: Unusable Meal_Plan_Id
  // references are indistinguishable
  //
  // **Validates: Requirements 7.3, 7.4, 7.8**
  it('answers read, update, and rename with the frozen 404 byte for byte, whichever way the id is unusable', async () => {
    await fc.assert(
      fc.asyncProperty(arbUnusableIdCase(), async (idCase) => {
        const harness = harnessFor(idCase);
        const before = harness.snapshot();

        for (const method of NOT_FOUND_METHODS) {
          const observations: RouteObservation[] = [];

          for (const unusable of UNUSABLE_ID_CLASSES) {
            const where = `${method} of ${unusable} (${idCase.malformed.shape})`;
            const observed = await harness.request(method, idOfClass(idCase, unusable));

            // One status, one body, one field set — the frozen constant, whatever
            // the cause (Requirements 7.3, 7.4, 7.8).
            expect(observed.status, where).toBe(404);
            expect(observed.body, where).toBe(NOT_FOUND_JSON_BYTES);
            expect(observed.fields, where).toEqual(NOT_FOUND_FIELDS);

            observations.push(observed);
          }

          const [first, ...rest] = observations;
          for (const [index, other] of rest.entries()) {
            const where = `${method}: ${UNUSABLE_ID_CLASSES[index + 1]} against owned-elsewhere`;
            expect(other.status, where).toBe(first.status);
            expect(other.body, where).toBe(first.body);
            expect(other.fields, where).toEqual(first.fields);
            // Headers carry no request-derived value either, so they cannot tell
            // the classes apart.
            expect(other.headers, where).toBe(first.headers);
          }
        }

        // Every stored Meal_Plan_Record is left as it was — the caller's partition
        // and every other, across all nine requests (Requirements 7.3, 7.8).
        expect(harness.snapshot()).toBe(before);

        // Guard against a vacuous pass: an id the caller really holds is not
        // answered with a 404, so the equality above is indistinguishability
        // rather than a handler that refuses everything.
        if (idCase.ownId !== undefined) {
          const held = await harness.request('GET', idCase.ownId);
          expect(held.status).toBe(200);
          expect(held.fields).toEqual(['record']);
        }
      }),
      { numRuns: 40 },
    );
  });

  // Feature: user-auth-and-cloud-storage, Property 6: Unusable Meal_Plan_Id
  // references are indistinguishable
  //
  // **Validates: Requirements 7.3, 7.4**
  it("reveals no title, content, timestamp, or owner identity of another Account's record", async () => {
    await fc.assert(
      fc.asyncProperty(arbUnusableIdCase(), async (idCase) => {
        const foreign = recordHeldElsewhere(
          idCase.store,
          idCase.callerUserId,
          idCase.ownedElsewhereId,
        );
        const secrets = longSecretsOf(foreign);
        const harness = harnessFor(idCase);
        const before = harness.snapshot();

        for (const method of ALL_ITEM_METHODS) {
          const where = `${method} of an id held by ${foreign.userId}`;
          const observed = await harness.request(method, idCase.ownedElsewhereId);

          for (const secret of secrets) {
            expect(observed.body.includes(secret), `${where} leaked ${secret}`).toBe(false);
          }
          expect(observed.headers.includes(foreign.userId), where).toBe(false);
        }

        // The record itself, and the whole partition holding it, are untouched by
        // every one of the four methods (Requirement 7.3).
        const after = harness.snapshot();
        expect(after).toBe(before);
        expect(after.includes(idCase.ownedElsewhereId)).toBe(true);
      }),
      { numRuns: 40 },
    );
  });

  // Feature: user-auth-and-cloud-storage, Property 6: Unusable Meal_Plan_Id
  // references are indistinguishable
  //
  // **Validates: Requirements 7.8**
  it('performs no read and no write for a malformed id, on every method', async () => {
    await fc.assert(
      fc.asyncProperty(arbUnusableIdCase(), async (idCase) => {
        const harness = harnessFor(idCase);
        const before = harness.snapshot();

        for (const method of ALL_ITEM_METHODS) {
          const where = `${method} of ${idCase.malformed.shape} id ${JSON.stringify(idCase.malformed.id)}`;
          const observed = await harness.request(method, idCase.malformed.id);

          // The ledger records every attempted operation before any condition is
          // evaluated, so an issued-then-refused command would still appear here.
          expect(observed.storeCalls, where).toBe(0);

          // And the answer is the same frozen 404 an id owned elsewhere gets —
          // `DELETE` included, which is the one method whose 404 is reserved for
          // exactly this case.
          expect(observed.status, where).toBe(404);
          expect(observed.body, where).toBe(NOT_FOUND_JSON_BYTES);
          expect(observed.fields, where).toEqual(NOT_FOUND_FIELDS);
        }

        expect(harness.snapshot()).toBe(before);

        // Non-vacuous: a charset-valid id that names nothing does reach the store,
        // so the zero above is the validation gate rather than a handler that
        // never calls the repository at all.
        const reached = await harness.request('GET', idCase.nonexistentId);
        expect(reached.storeCalls).toBe(1);
      }),
      { numRuns: 40 },
    );
  });

  // Feature: user-auth-and-cloud-storage, Property 6: Unusable Meal_Plan_Id
  // references are indistinguishable
  //
  // **Validates: Requirements 7.3, 7.4, 7.8**
  it('answers a delete identically whether the id is held elsewhere, held nowhere, or held by the caller', async () => {
    await fc.assert(
      fc.asyncProperty(arbUnusableIdCase(), async (idCase) => {
        const harness = harnessFor(idCase);
        const before = harness.snapshot();

        const elsewhere = await harness.request('DELETE', idCase.ownedElsewhereId);
        const nowhere = await harness.request('DELETE', idCase.nonexistentId);

        // The design fixes `DELETE` at 204 including for an id the Account no
        // longer holds (Requirement 8.3), so for this method the indistinguishable
        // answer is that 204 and its empty body rather than the 404.
        for (const [label, observed] of [
          ['owned elsewhere', elsewhere],
          ['held nowhere', nowhere],
        ] as const) {
          expect(observed.status, label).toBe(204);
          expect(observed.body, label).toBe('');
          expect(observed.fields, label).toEqual([]);
        }
        expect(nowhere.status).toBe(elsewhere.status);
        expect(nowhere.body).toBe(elsewhere.body);
        expect(nowhere.headers).toBe(elsewhere.headers);

        // Neither delete removed anything: the record under the other Account is
        // still there, and so is every one of the caller's own.
        expect(harness.snapshot()).toBe(before);

        // A record the caller does hold answers with the same bytes, so the
        // response says nothing about whether the id existed, or under whom. Its
        // own harness, since this one really does write.
        if (idCase.ownId !== undefined) {
          const control = harnessFor(idCase);
          const controlBefore = control.snapshot();
          const held = await control.request('DELETE', idCase.ownId);

          expect(held.status).toBe(elsewhere.status);
          expect(held.body).toBe(elsewhere.body);
          expect(held.fields).toEqual(elsewhere.fields);
          expect(held.headers).toBe(elsewhere.headers);
          // Non-vacuous: that delete really removed something.
          expect(control.snapshot()).not.toBe(controlBefore);
        }
      }),
      { numRuns: 40 },
    );
  });
});
