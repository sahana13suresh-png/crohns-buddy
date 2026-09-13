/**
 * Property-based tests for the Account_Deletion_Flow.
 *
 * Feature: user-auth-and-cloud-storage.
 *
 * Properties covered so far:
 *
 * - Property 20: Account deletion removes nothing before its gates pass, then proceeds in
 *   order.
 * - Property 21: The pending-deletion sweep retries boundedly and converges.
 *
 * Property 20 drives the browser half of the flow — the state machine in
 * `accountDeletion.ts` — over generated event sequences and scripted port outcomes. Its
 * own harness and generators live beside it further down the file.
 *
 * The sweep is driven directly through `runPendingDeletionSweep` over
 * `createInMemoryMealPlanRepository`, with no HTTP layer in between: the cron credential
 * and the response shape are settled by example in
 * `src/lib/server/pendingDeletionSweep.test.ts`, and what is left for a property is the
 * behaviour that only shows up across many failure patterns — how many purges an entry
 * gets, when the retry loop stops, which entries are removed, and whether a second run
 * changes anything. The in-memory store reimplements the partition, the key-scoped delete,
 * and the idempotent purge rather than stubbing them, so a statement proved here is a
 * statement about the DynamoDB adapter's semantics too.
 *
 * ## The store model
 *
 * A `purge` is scripted per Account and per attempt, from the four outcomes the sweep can
 * actually observe: it reports no remaining record, it reports records remaining with
 * nothing deleted (a throttled `BatchWriteItem`), it deletes all but one stubborn record
 * and reports that one remaining (a partial purge), or it throws (an unreachable store).
 * Each attempt also consumes generated wall-clock time, drawn around the 60-second budget
 * boundary, so the budget check is exercised at, just below, and just past its edge.
 *
 * Two modelling choices are deliberate:
 *
 * 1. **A failing purge never empties the partition.** A partial purge stops at one
 *    survivor, so an Account that entered the sweep holding records still holds at least
 *    one after any failing attempt. That is what makes "removed exactly when no record
 *    remains" a testable biconditional rather than a claim about a store that lies.
 * 2. **A throwing purge is only scripted for an Account that holds records.** An entry
 *    whose store is unreachable while its partition is *already* empty is a state the
 *    sweep cannot observe — it has no way to learn that nothing remains — and the design's
 *    biconditional does not speak to it. For those Accounts a throw is replaced by a
 *    stall, which reports the true (zero) remaining count.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { AccountPurgeResult } from '@/app/api/account/purge/accountPurge';
import {
  advanceAccountDeletion,
  CONFIRMATION_TEXT,
  confirmAccountDeletion,
  DELETION_TRANSITIONS,
  DESTRUCTIVE_EFFECT_ORDER,
  EFFECT_FOR_STATE,
  hasRemovedData,
  initialDeletionContext,
  isConfirmEnabled,
  reduceDeletion,
  REAUTH_WINDOW_MS,
  submitReauthentication,
  type AccountDeletionPorts,
  type AccountRemovalOutcome,
  type DeletionContext,
  type DeletionEffect,
  type DeletionEvent,
  type ReauthOutcome,
} from './accountDeletion';
import type { ApiResult } from './apiClient';
import { newMealPlanId } from './mealPlanId';
import {
  createInMemoryMealPlanRepository,
  type InMemoryMealPlanRepository,
} from './server/inMemoryMealPlanRepository';
import { PENDING_DELETION_PARTITION, type MealPlanRepository } from './server/mealPlanRepository';
import {
  SWEEP_ENTRY_BUDGET_MS,
  SWEEP_PURGE_ATTEMPTS,
  runPendingDeletionSweep,
  type PendingDeletionSweepResult,
} from './server/pendingDeletionSweep';
import { arbMultiAccountStore, type MultiAccountStore } from '@/test/arbitraries';

// ─── The scripted store ────────────────────────────────────────────────────────

/**
 * What one scripted `purge` attempt does. Named for what the store *reports*, since that
 * is all the sweep can see.
 *
 * - `empty` — the real purge runs and reports no remaining Meal_Plan_Record
 * - `stall` — nothing is deleted and the true remaining count is reported
 * - `partial` — every record but the oldest is deleted, and that survivor is reported
 * - `throw` — the store is unreachable
 */
type PurgeOutcome = 'empty' | 'stall' | 'partial' | 'throw';

/** One Account's scripted behaviour, one entry per attempt the sweep might make. */
interface PurgeScript {
  outcomes: PurgeOutcome[];
  /** Wall-clock milliseconds each attempt consumes, in attempt order. */
  deltas: number[];
}

/** One observed purge attempt, recorded whether it returned or threw. */
interface PurgeAttempt {
  /** Clock reading when the attempt began, i.e. when the sweep chose to make it. */
  startedAtMs: number;
  /** Clock reading when it finished, i.e. what the next budget check would see. */
  endedAtMs: number;
  outcome: PurgeOutcome;
  /** Remaining count reported, or `undefined` when the attempt threw. */
  reportedRemaining?: number;
}

/** A seeded store, a pending-deletion list, and a purge script for every listed Account. */
interface SweepCase {
  store: MultiAccountStore;
  /** Clock reading at which the entries are enqueued and the sweep starts. */
  nowMs: number;
  /** User_Ids on the pending-deletion list, distinct and non-empty. */
  pending: string[];
  scripts: Map<string, PurgeScript>;
}

/**
 * One attempt's elapsed time. Weighted onto the budget boundary, because the retry gate is
 * `now > deadline` and the interesting cases are exactly 60 seconds, one millisecond short,
 * and one millisecond over.
 */
const arbAttemptDelta = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(0, 1, 250, 5_000) },
  {
    weight: 3,
    arbitrary: fc.constantFrom(
      SWEEP_ENTRY_BUDGET_MS - 1,
      SWEEP_ENTRY_BUDGET_MS,
      SWEEP_ENTRY_BUDGET_MS + 1
    ),
  },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 2 * SWEEP_ENTRY_BUDGET_MS }) }
);

/** Failure-heavy, so retries and leftover entries are common rather than incidental. */
const arbPurgeOutcome = fc.oneof(
  { weight: 3, arbitrary: fc.constant<PurgeOutcome>('empty') },
  { weight: 3, arbitrary: fc.constant<PurgeOutcome>('stall') },
  { weight: 3, arbitrary: fc.constant<PurgeOutcome>('throw') },
  { weight: 2, arbitrary: fc.constant<PurgeOutcome>('partial') }
);

/**
 * One more outcome and delta than the sweep is allowed to consume, so an implementation
 * that retried a fourth time would find a script waiting for it rather than running off
 * the end of the array.
 */
const SCRIPT_LENGTH = SWEEP_PURGE_ATTEMPTS + 1;

const arbPurgeScript: fc.Arbitrary<PurgeScript> = fc.record({
  outcomes: fc.array(arbPurgeOutcome, { minLength: SCRIPT_LENGTH, maxLength: SCRIPT_LENGTH }),
  deltas: fc.array(arbAttemptDelta, { minLength: SCRIPT_LENGTH, maxLength: SCRIPT_LENGTH }),
});

/** How many Meal_Plan_Records the seeds place under one Account. */
function seededRecordCount(store: MultiAccountStore, userId: string): number {
  return store.placements.filter((placement) => placement.userId === userId).length;
}

/**
 * Generates a seeded multi-Account store, a pending-deletion list drawn from it, and a
 * purge script per listed Account.
 *
 * The list is drawn from the seeded Accounts *and* `absentUserId`, so an entry for an
 * Account whose partition holds nothing at all — the ordinary case, since the flow enqueues
 * only after a purge already ran — is exercised alongside entries with records left over.
 * Accounts left off the list are the bystanders the sweep must not touch.
 */
function arbSweepCase(): fc.Arbitrary<SweepCase> {
  return arbMultiAccountStore().chain((store) => {
    const candidates = [...store.userIds, store.absentUserId];
    return fc
      .record({
        nowMs: fc.integer({ min: Date.UTC(2025, 0, 1), max: Date.UTC(2027, 0, 1) }),
        pendingFlags: fc.array(fc.boolean(), {
          minLength: candidates.length,
          maxLength: candidates.length,
        }),
        scripts: fc.array(arbPurgeScript, {
          minLength: candidates.length,
          maxLength: candidates.length,
        }),
      })
      .map(({ nowMs, pendingFlags, scripts }) => {
        const pending = candidates.filter((_userId, index) => pendingFlags[index]);
        // An empty list is covered by example; a property run with nothing to sweep would
        // assert nothing, so at least one entry is always listed.
        if (pending.length === 0) pending.push(candidates[0]);

        const scripted = new Map<string, PurgeScript>();
        for (const userId of pending) {
          const script = scripts[candidates.indexOf(userId)];
          const holdsRecords = seededRecordCount(store, userId) > 0;
          scripted.set(userId, {
            // See the file header: a throw against an already-empty partition is a state
            // the sweep cannot observe, so it reports the true zero remaining instead.
            outcomes: holdsRecords
              ? script.outcomes
              : script.outcomes.map((outcome) => (outcome === 'throw' ? 'stall' : outcome)),
            deltas: script.deltas,
          });
        }

        return { store, nowMs, pending, scripts: scripted };
      });
  });
}

// ─── Harness ───────────────────────────────────────────────────────────────────

/** A seeded store with a scripted purge, an advancing clock, and per-entry observations. */
interface SweepHarness {
  /** The unscripted store, for inspecting state and comparing snapshots. */
  repo: InMemoryMealPlanRepository;
  now(): number;
  /** Enqueues the case's pending entries at `nowMs`, before the clock advances. */
  enqueuePending(): Promise<void>;
  /** Runs one sweep, returning its result and the attempts each entry received. */
  run(): Promise<{ result: PendingDeletionSweepResult; observed: Map<string, PurgeAttempt[]> }>;
  /** Meal_Plan_Records the Account currently holds. */
  recordCount(userId: string): Promise<number>;
}

function buildHarness(kase: SweepCase): SweepHarness {
  // The only thing that moves the clock is a scripted purge attempt, so the reading the
  // sweep sees at the start of an entry is exactly that entry's first attempt time.
  let clockMs = kase.nowMs;

  const repo = createInMemoryMealPlanRepository({
    now: () => clockMs,
    newMealPlanId: () => newMealPlanId(clockMs),
  });
  repo.seed(kase.store.seeds);

  let observed = new Map<string, PurgeAttempt[]>();

  async function scriptedPurge(userId: string): Promise<{ deletedCount: number; remaining: number }> {
    const script = kase.scripts.get(userId);
    // Only a User_Id read from the reserved partition may be purged. An unscripted one
    // means the sweep invented a target, which is a failure, not a missing fixture.
    if (script === undefined) throw new Error(`purge: no script for ${userId}`);

    const attempts = observed.get(userId) ?? [];
    observed.set(userId, attempts);
    // Beyond the script's length the last entry repeats, so an over-retrying sweep is
    // caught by the attempt count rather than by an index error.
    const step = Math.min(attempts.length, SCRIPT_LENGTH - 1);
    const outcome = script.outcomes[step];

    const startedAtMs = clockMs;
    clockMs += script.deltas[step];
    const endedAtMs = clockMs;
    const observe = (reportedRemaining?: number): void => {
      attempts.push({ startedAtMs, endedAtMs, outcome, reportedRemaining });
    };

    switch (outcome) {
      case 'empty': {
        const outcomeCounts = await repo.purge(userId);
        observe(outcomeCounts.remaining);
        return outcomeCounts;
      }
      case 'stall': {
        const remaining = await harnessRecordCount(userId);
        observe(remaining);
        return { deletedCount: 0, remaining };
      }
      case 'partial': {
        const records = await repo.listAll(userId);
        // Newest first, so the oldest record is the survivor. Deleting down to one and no
        // further keeps a failing attempt from emptying the partition.
        const doomed = records.slice(0, Math.max(0, records.length - 1));
        for (const record of doomed) await repo.delete(userId, record.mealPlanId);
        const remaining = records.length === 0 ? 0 : 1;
        observe(remaining);
        return { deletedCount: doomed.length, remaining };
      }
      case 'throw': {
        observe(undefined);
        throw new Error('ProvisionedThroughputExceededException');
      }
    }
  }

  async function harnessRecordCount(userId: string): Promise<number> {
    return (await repo.listAll(userId)).length;
  }

  const scriptedStore: MealPlanRepository = { ...repo, purge: scriptedPurge };

  return {
    repo,
    now: () => clockMs,
    async enqueuePending(): Promise<void> {
      for (const userId of kase.pending) await repo.enqueuePendingDeletion(userId);
    },
    async run() {
      // A fresh ledger per run: the second run replays each script from its first attempt,
      // which is what "running the sweep again" means.
      observed = new Map();
      const result = await runPendingDeletionSweep({
        repository: scriptedStore,
        now: () => clockMs,
      });
      return { result, observed };
    },
    recordCount: harnessRecordCount,
  };
}

/** The User_Ids currently on the pending-deletion list, ascending. */
async function listedUserIds(harness: SweepHarness): Promise<string[]> {
  const entries = await harness.repo.listPendingDeletions(harness.now());
  return entries.map((entry) => entry.userId).sort();
}

// ─── Property 21 ───────────────────────────────────────────────────────────────

describe('Property 21: the pending-deletion sweep retries boundedly and converges', () => {
  // Feature: user-auth-and-cloud-storage, Property 21: The pending-deletion sweep
  // retries boundedly and converges
  //
  // **Validates: Requirements 11.7**
  it('gives each entry at most 3 purges, starts none past the 60-second budget, and stops early only on success or an exhausted budget', async () => {
    await fc.assert(
      fc.asyncProperty(arbSweepCase(), async (kase) => {
        const harness = buildHarness(kase);
        await harness.enqueuePending();

        const { observed } = await harness.run();

        // Every listed entry was attempted, and nothing else was.
        expect([...observed.keys()].sort()).toStrictEqual([...kase.pending].sort());

        for (const userId of kase.pending) {
          const attempts = observed.get(userId) ?? [];

          // At least one attempt always runs, and never more than the bound — an entry
          // cannot be skipped, and cannot consume the run.
          expect(attempts.length).toBeGreaterThanOrEqual(1);
          expect(attempts.length).toBeLessThanOrEqual(SWEEP_PURGE_ATTEMPTS);

          const deadlineMs = attempts[0].startedAtMs + SWEEP_ENTRY_BUDGET_MS;
          for (const retry of attempts.slice(1)) {
            // Every retry began inside the per-entry budget.
            expect(retry.startedAtMs).toBeLessThanOrEqual(deadlineMs);
          }

          const last = attempts[attempts.length - 1];
          const succeeded = last.reportedRemaining === 0;
          if (attempts.length < SWEEP_PURGE_ATTEMPTS && !succeeded) {
            // Stopping short of the bound without success is only allowed because the
            // budget was spent — otherwise the sweep gave up early.
            expect(last.endedAtMs).toBeGreaterThan(deadlineMs);
          }
          if (succeeded) {
            // A purge reporting the partition clear ends the entry: exactly one attempt
            // reported it, and it was the last one made.
            expect(attempts.filter((attempt) => attempt.reportedRemaining === 0)).toHaveLength(1);
          }
        }
      }),
      { numRuns: 120 }
    );
  });

  // Feature: user-auth-and-cloud-storage, Property 21: The pending-deletion sweep
  // retries boundedly and converges
  //
  // **Validates: Requirements 11.7**
  it('removes an entry exactly when no Meal_Plan_Record remains for that User_Id, and leaves Accounts off the list untouched', async () => {
    await fc.assert(
      fc.asyncProperty(arbSweepCase(), async (kase) => {
        const harness = buildHarness(kase);
        await harness.enqueuePending();

        const bystanders = [...kase.store.userIds, kase.store.absentUserId].filter(
          (userId) => !kase.pending.includes(userId)
        );
        const bystandersBefore = bystanders.map((userId) => harness.repo.snapshotPartition(userId));

        const { result } = await harness.run();

        const listedAfter = new Set(await listedUserIds(harness));
        for (const userId of kase.pending) {
          const remaining = await harness.recordCount(userId);
          // The biconditional: the entry survives exactly when a record does.
          expect(listedAfter.has(userId)).toBe(remaining > 0);
        }

        // The counts describe that same partition of the list, and nothing is lost from it.
        expect(result.processed).toBe(kase.pending.length);
        expect(result.stillPending).toBe(listedAfter.size);
        expect(result.cleared).toBe(kase.pending.length - listedAfter.size);
        expect(result.cleared + result.stillPending).toBe(result.processed);

        // No User_Id came from anywhere but the reserved partition, so an Account that was
        // never listed keeps every record it had.
        bystanders.forEach((userId, index) => {
          expect(harness.repo.snapshotPartition(userId)).toBe(bystandersBefore[index]);
        });
      }),
      { numRuns: 120 }
    );
  });

  // Feature: user-auth-and-cloud-storage, Property 21: The pending-deletion sweep
  // retries boundedly and converges
  //
  // **Validates: Requirements 11.7**
  it('reaches the same end state on a second run over the same list', async () => {
    await fc.assert(
      fc.asyncProperty(arbSweepCase(), async (kase) => {
        const harness = buildHarness(kase);
        await harness.enqueuePending();

        const first = await harness.run();
        const afterFirst = harness.repo.snapshot();
        const listedAfterFirst = await listedUserIds(harness);

        // The same store, the same list, and each script replayed from its first attempt:
        // an entry that failed its way through the budget fails the same way again, and an
        // entry that was cleared is no longer listed to be cleared twice.
        const second = await harness.run();

        expect(harness.repo.snapshot()).toBe(afterFirst);
        expect(await listedUserIds(harness)).toStrictEqual(listedAfterFirst);
        expect(second.result.processed).toBe(first.result.stillPending);
        expect(second.result.stillPending).toBe(first.result.stillPending);
        expect(second.result.cleared).toBe(0);
        // The reserved partition is the only place the second run read its targets from.
        expect([...second.observed.keys()].sort()).toStrictEqual([...listedAfterFirst].sort());
        expect(listedAfterFirst).not.toContain(PENDING_DELETION_PARTITION);
      }),
      { numRuns: 120 }
    );
  });
});

// ─── Property 20: the flow under test ──────────────────────────────────────────

/**
 * The browser half of the flow is driven through its three entry points —
 * `confirmAccountDeletion`, `submitReauthentication`, and `advanceAccountDeletion` — over
 * generated step sequences, with the five ports replaced by fakes that record their own
 * call order. Nothing here touches Firebase, `fetch`, or localStorage: the real ports are
 * `createBrowserDeletionPorts`, and they are covered by example in `accountDeletion.test.ts`.
 *
 * The call log, not the context, is what the ordering claims are read from. `completedEffects`
 * says what the machine *believes* happened; `ports.calls` says what was actually asked of
 * the Auth_Service and the store, and the two are compared against each other rather than
 * either being trusted alone.
 *
 * Two modelling choices are deliberate:
 *
 * 1. **A step sequence is generated, not scripted.** Steps are drawn independently of the
 *    state they land in, so most of them are events the current state does not admit —
 *    confirming while the prompt is open, restarting mid-purge, typing during
 *    re-authentication. That is the point: the gates have to hold against a caller
 *    dispatching things in the wrong order, not only against the happy path.
 * 2. **`clearTrackerEntries` and `endSession` never fail.** Their interface says they must
 *    not throw, so a failing fake would be testing a contract violation rather than the
 *    requirement. Failure is scripted where the requirements distinguish it: the purge and
 *    the Account removal.
 */

/**
 * What the purge port reports. `cleared` and `pending` are the two 200 shapes;
 * `no-body` is an `ok` result with `data` absent, which the flow must read as a failed
 * purge rather than as a clean one.
 */
type PurgePortOutcome =
  | 'cleared'
  | 'pending'
  | 'no-body'
  | 'unauthorized'
  | 'unavailable'
  | 'timeout';

/** Outcomes under which no Meal_Plan_Record was removed. */
const FAILED_PURGE_OUTCOMES: readonly PurgePortOutcome[] = [
  'no-body',
  'unauthorized',
  'unavailable',
  'timeout',
];

function purgeSucceeded(outcome: PurgePortOutcome): boolean {
  return !FAILED_PURGE_OUTCOMES.includes(outcome);
}

/**
 * One thing the Patient (or the Session) does. `expire` is the mid-flow Session expiry of
 * Requirement 11.6, which arrives without the Patient doing anything.
 */
type DeletionStep =
  | { readonly kind: 'type'; readonly text: string }
  | { readonly kind: 'confirm'; readonly authAgeMs: number }
  | { readonly kind: 'reauth'; readonly outcome: ReauthOutcome }
  | { readonly kind: 'restart' }
  | { readonly kind: 'expire' };

/** A step sequence together with the outcomes the two failable ports will report. */
interface DeletionCase {
  readonly steps: readonly DeletionStep[];
  readonly purgeOutcomes: readonly PurgePortOutcome[];
  readonly accountOutcomes: readonly AccountRemovalOutcome[];
  readonly deletedCount: number;
  /** Records a `pending` purge reports left behind; always 1 or more. */
  readonly remaining: number;
}

/** Fixed wall clock. Only the *age* of the authentication matters to the gate. */
const NOW_MS = Date.UTC(2026, 4, 17, 9, 30);

// ─── Generators ────────────────────────────────────────────────────────────────

/**
 * What the Patient types. Weighted onto `DELETE` and onto the near-misses an exact-match
 * gate has to reject — case folds, surrounding whitespace, a trailing newline, a fullwidth
 * letter, and a repeat — since those are the values a `trim()` or a `toUpperCase()` in the
 * predicate would wrongly admit.
 */
const arbConfirmationTextInput = fc.oneof(
  { weight: 6, arbitrary: fc.constant(CONFIRMATION_TEXT) },
  {
    weight: 6,
    arbitrary: fc.constantFrom(
      'delete',
      'Delete',
      'dELETE',
      ' DELETE',
      'DELETE ',
      'DELETE\n',
      '\tDELETE',
      'DELET',
      'DELETED',
      'DELETE DELETE',
      'DELETE\u200b',
      'DELＥTE',
      ''
    ),
  },
  { weight: 2, arbitrary: fc.string({ maxLength: 12 }) }
);

/**
 * How old the most recent successful authentication is at the moment of the confirmation.
 * Weighted onto the 5-minute boundary, because the gate is `now - authTime > window` and
 * the interesting cases are exactly 5 minutes, one millisecond short, and one over.
 */
const arbAuthAgeMs = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(0, 1, 1_000, 60_000) },
  {
    weight: 4,
    arbitrary: fc.constantFrom(REAUTH_WINDOW_MS - 1, REAUTH_WINDOW_MS, REAUTH_WINDOW_MS + 1),
  },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 4 * REAUTH_WINDOW_MS }) }
);

const arbDeletionStep: fc.Arbitrary<DeletionStep> = fc.oneof(
  {
    weight: 4,
    arbitrary: arbConfirmationTextInput.map((text): DeletionStep => ({ kind: 'type', text })),
  },
  {
    weight: 5,
    arbitrary: arbAuthAgeMs.map((authAgeMs): DeletionStep => ({ kind: 'confirm', authAgeMs })),
  },
  {
    weight: 3,
    arbitrary: fc
      .constantFrom<ReauthOutcome[]>('succeeded', 'failed', 'cancelled')
      .map((outcome): DeletionStep => ({ kind: 'reauth', outcome })),
  },
  { weight: 1, arbitrary: fc.constant<DeletionStep>({ kind: 'restart' }) },
  { weight: 1, arbitrary: fc.constant<DeletionStep>({ kind: 'expire' }) }
);

/** Failure-heavy, so a purge that removes nothing is common rather than incidental. */
const arbPurgePortOutcome = fc.oneof(
  { weight: 4, arbitrary: fc.constant<PurgePortOutcome>('cleared') },
  { weight: 2, arbitrary: fc.constant<PurgePortOutcome>('pending') },
  { weight: 1, arbitrary: fc.constant<PurgePortOutcome>('no-body') },
  { weight: 2, arbitrary: fc.constant<PurgePortOutcome>('unauthorized') },
  { weight: 2, arbitrary: fc.constant<PurgePortOutcome>('unavailable') },
  { weight: 1, arbitrary: fc.constant<PurgePortOutcome>('timeout') }
);

const arbAccountRemovalOutcome = fc.oneof(
  { weight: 4, arbitrary: fc.constant<AccountRemovalOutcome>('removed') },
  { weight: 2, arbitrary: fc.constant<AccountRemovalOutcome>('requires-recent-login') },
  { weight: 2, arbitrary: fc.constant<AccountRemovalOutcome>('failed') }
);

function arbDeletionCase(): fc.Arbitrary<DeletionCase> {
  return fc.record({
    // Long enough for an abort, a restart, and a second full attempt to fit in one case.
    steps: fc.array(arbDeletionStep, { minLength: 1, maxLength: 14 }),
    purgeOutcomes: fc.array(arbPurgePortOutcome, { minLength: 1, maxLength: 5 }),
    accountOutcomes: fc.array(arbAccountRemovalOutcome, { minLength: 1, maxLength: 5 }),
    deletedCount: fc.nat({ max: 500 }),
    remaining: fc.integer({ min: 1, max: 50 }),
  });
}

// ─── Recording ports ───────────────────────────────────────────────────────────

type PortCall = DeletionEffect | 'reauthenticate';

interface RecordingPorts extends AccountDeletionPorts {
  /** Every port call, in the order it happened. */
  readonly calls: PortCall[];
  /** What each purge call reported, in call order. */
  readonly purgeReports: PurgePortOutcome[];
  /** Sets what the next `reauthenticate` call returns. */
  scriptReauth(outcome: ReauthOutcome): void;
}

function recordingPorts(kase: DeletionCase): RecordingPorts {
  const calls: PortCall[] = [];
  const purgeReports: PurgePortOutcome[] = [];
  let accountCalls = 0;
  let nextReauth: ReauthOutcome = 'succeeded';

  // Past the end of a script its last entry repeats, so an implementation that called a
  // port more often than the script anticipated is caught by the call log rather than by
  // an index error.
  const scripted = <T>(script: readonly T[], index: number): T =>
    script[Math.min(index, script.length - 1)];

  return {
    calls,
    purgeReports,
    scriptReauth(outcome) {
      nextReauth = outcome;
    },

    purgeRecords: async () => {
      calls.push('remove-records');
      const outcome = scripted(kase.purgeOutcomes, purgeReports.length);
      purgeReports.push(outcome);
      switch (outcome) {
        case 'cleared':
          return {
            ok: true,
            data: { deletedCount: kase.deletedCount, remaining: 0, pendingDeletion: false },
          };
        case 'pending':
          return {
            ok: true,
            data: {
              deletedCount: kase.deletedCount,
              remaining: kase.remaining,
              pendingDeletion: true,
            },
          };
        case 'no-body':
          // `callApi` produces this for a 204: `ok` with no `data`.
          return { ok: true } as ApiResult<AccountPurgeResult>;
        default:
          return { ok: false, kind: outcome, message: outcome };
      }
    },

    removeAccount: async () => {
      calls.push('remove-account');
      const outcome = scripted(kase.accountOutcomes, accountCalls);
      accountCalls += 1;
      return outcome;
    },

    clearTrackerEntries: () => {
      calls.push('clear-tracker');
    },

    endSession: async () => {
      calls.push('end-session');
    },

    reauthenticate: async () => {
      calls.push('reauthenticate');
      return nextReauth;
    },
  };
}

// ─── Harness ───────────────────────────────────────────────────────────────────

/** One step, with the contexts either side of it and everything the ports did during it. */
interface StepObservation {
  step: DeletionStep;
  before: DeletionContext;
  after: DeletionContext;
  /** Destructive port calls made during this step, in the order they happened. */
  destructive: DeletionEffect[];
  reauthCalled: boolean;
  /** What the purge reported during this step, or `undefined` if it did not run. */
  purge?: PurgePortOutcome;
}

function isDestructive(call: PortCall): call is DeletionEffect {
  return call !== 'reauthenticate';
}

/**
 * Both gates, computed from the step and the context the step began in rather than read
 * back off the machine: the exact-match test of Requirements 11.2 and 11.8, and the
 * 5-minute freshness test of Requirement 11.5.
 */
function gatesPass(before: DeletionContext, step: DeletionStep): boolean {
  return (
    step.kind === 'confirm' &&
    before.state === 'confirming' &&
    before.confirmationText === CONFIRMATION_TEXT &&
    step.authAgeMs <= REAUTH_WINDOW_MS
  );
}

/**
 * Replays a case one step at a time, recording what each step did.
 *
 * Every step ends with `advanceAccountDeletion`, including the ones that only edit the
 * confirmation field. That way a state which names no effect is *shown* to reach no port
 * rather than assumed to.
 */
async function runDeletionCase(
  kase: DeletionCase
): Promise<{ observations: StepObservation[]; ports: RecordingPorts }> {
  const ports = recordingPorts(kase);
  const observations: StepObservation[] = [];
  let context = initialDeletionContext();

  for (const step of kase.steps) {
    const before = context;
    const callMark = ports.calls.length;
    const purgeMark = ports.purgeReports.length;

    switch (step.kind) {
      case 'type':
        context = await advanceAccountDeletion(
          reduceDeletion(before, { type: 'confirmation-text-changed', text: step.text }),
          ports
        );
        break;
      case 'confirm':
        context = await confirmAccountDeletion(before, ports, NOW_MS - step.authAgeMs, NOW_MS);
        break;
      case 'reauth':
        ports.scriptReauth(step.outcome);
        context = await advanceAccountDeletion(
          await submitReauthentication(before, ports, 'pw'),
          ports
        );
        break;
      case 'restart':
        context = await advanceAccountDeletion(reduceDeletion(before, { type: 'restart' }), ports);
        break;
      case 'expire':
        context = await advanceAccountDeletion(
          reduceDeletion(before, { type: 'session-expired' }),
          ports
        );
        break;
    }

    const made = ports.calls.slice(callMark);
    observations.push({
      step,
      before,
      after: context,
      destructive: made.filter(isDestructive),
      reauthCalled: made.includes('reauthenticate'),
      // A step reaches `purging` at most once, so at most one report belongs to it.
      purge: ports.purgeReports.slice(purgeMark)[0],
    });
  }

  return { observations, ports };
}

/** Every event the machine defines, with payloads drawn from the case. */
function everyDeletionEvent(kase: DeletionCase): readonly DeletionEvent[] {
  const result: AccountPurgeResult = {
    deletedCount: kase.deletedCount,
    remaining: kase.remaining,
    pendingDeletion: true,
  };
  return [
    { type: 'confirmation-text-changed', text: CONFIRMATION_TEXT },
    { type: 'confirm-submitted', authTimeMs: NOW_MS, nowMs: NOW_MS },
    { type: 'reauth-succeeded' },
    { type: 'reauth-failed' },
    { type: 'reauth-cancelled' },
    { type: 'session-expired' },
    { type: 'purge-succeeded', result },
    { type: 'purge-failed' },
    { type: 'account-removed' },
    { type: 'account-removal-requires-recent-login' },
    { type: 'account-removal-failed' },
    { type: 'tracker-cleared' },
    { type: 'session-ended' },
    { type: 'restart' },
  ];
}

// ─── Property 20 ───────────────────────────────────────────────────────────────

describe('Property 20: account deletion removes nothing before its gates pass, then proceeds in order', () => {
  // Feature: user-auth-and-cloud-storage, Property 20: Account deletion removes nothing
  // before its gates pass, then proceeds in order
  //
  // **Validates: Requirements 11.2, 11.5, 11.8**
  it('removes nothing unless the confirmation text is exactly DELETE and the authentication is no more than 5 minutes old', async () => {
    await fc.assert(
      fc.asyncProperty(arbDeletionCase(), async (kase) => {
        const { observations, ports } = await runDeletionCase(kase);

        let opened = 0;
        for (const obs of observations) {
          const gated = gatesPass(obs.before, obs.step);
          if (gated) opened += 1;

          if (gated) {
            // The gates are the only thing holding the removal back: once both pass, the
            // record removal is reached, and it is reached first.
            expect(obs.destructive[0]).toBe('remove-records');
          } else {
            // Every other step — a mismatch, a stale authentication, an edit, a prompt, a
            // restart, an expiry, or an event the state does not admit — removes nothing.
            expect(obs.destructive).toStrictEqual([]);
            expect(obs.after.completedEffects).toStrictEqual(obs.before.completedEffects);
          }

          // Re-authentication is the one port a non-destructive step may reach, and only
          // from the prompt.
          expect(obs.reauthCalled).toBe(
            obs.step.kind === 'reauth' && obs.before.state === 'reauthenticating'
          );

          if (obs.step.kind === 'confirm' && obs.before.state === 'confirming' && !gated) {
            const typedExactly = obs.before.confirmationText === CONFIRMATION_TEXT;
            // 11.8: a mismatch keeps the flow open at the confirmation step with the text
            // the Patient typed still in the field. 11.5: exact text with a stale
            // authentication prompts instead, and still removes nothing.
            expect(obs.after.state).toBe(typedExactly ? 'reauthenticating' : 'confirming');
            expect(obs.after.message).toBe(
              typedExactly ? 'reauth-required' : 'confirmation-mismatch'
            );
            if (!typedExactly) {
              expect(obs.after.confirmationText).toBe(obs.before.confirmationText);
              expect(isConfirmEnabled(obs.after)).toBe(false);
            }
          }
        }

        // Counted over the whole sequence: one purge per confirmation that passed both
        // gates, and not one more — including across aborts and restarts.
        expect(ports.calls.filter((call) => call === 'remove-records')).toHaveLength(opened);

        // Up to the first such confirmation, nothing had been removed at all.
        const first = observations.findIndex((obs) => gatesPass(obs.before, obs.step));
        const before = first === -1 ? observations : observations.slice(0, first);
        for (const obs of before) {
          expect(obs.after.completedEffects).toStrictEqual([]);
          expect(hasRemovedData(obs.after)).toBe(false);
        }
      }),
      { numRuns: 120 }
    );
  });

  // Feature: user-auth-and-cloud-storage, Property 20: Account deletion removes nothing
  // before its gates pass, then proceeds in order
  //
  // **Validates: Requirements 11.3, 11.9**
  it('runs record removal, then Account removal, then tracker clearing, then Session end, and removes nothing at all when the record removal fails', async () => {
    await fc.assert(
      fc.asyncProperty(arbDeletionCase(), async (kase) => {
        const { observations, ports } = await runDeletionCase(kase);

        let completions = 0;
        let purgesSucceeded = 0;

        for (const obs of observations) {
          // The observed-order log only ever grows, and only at its end.
          expect(
            obs.after.completedEffects.slice(0, obs.before.completedEffects.length)
          ).toStrictEqual(obs.before.completedEffects);
          const appended = obs.after.completedEffects.slice(obs.before.completedEffects.length);

          if (obs.destructive.length === 0) {
            expect(appended).toStrictEqual([]);
            continue;
          }

          // 11.3: what this attempt asked of the ports is the required order truncated
          // wherever a port refused — never reordered, and never skipping a step. An
          // attempt always begins at the record removal, so this holds on the second and
          // third attempts of a restarted flow too.
          expect(obs.destructive).toStrictEqual(
            DESTRUCTIVE_EFFECT_ORDER.slice(0, obs.destructive.length)
          );
          // The log agrees with the calls: the same order, and every call but at most the
          // last one succeeded.
          expect(appended).toStrictEqual(DESTRUCTIVE_EFFECT_ORDER.slice(0, appended.length));
          expect(appended.length).toBeGreaterThanOrEqual(obs.destructive.length - 1);
          expect(appended.length).toBeLessThanOrEqual(obs.destructive.length);

          if (obs.purge !== undefined && !purgeSucceeded(obs.purge)) {
            // 11.9: the record removal failed before the Account was removed, so nothing
            // was removed at all. The Auth_Service was never reached, the tracker was
            // never cleared, and the Session was never ended.
            expect(obs.destructive).toStrictEqual(['remove-records']);
            expect(appended).toStrictEqual([]);
            expect(obs.after.completedEffects).toStrictEqual(obs.before.completedEffects);
            expect(obs.after.state).not.toBe('completed');
            // A credential refusal re-prompts (11.6); anything else stops with the
            // restart control of 11.9.
            const refused = obs.purge === 'unauthorized';
            expect(obs.after.state).toBe(refused ? 'reauthenticating' : 'aborted');
            expect(obs.after.message).toBe(refused ? 'session-expired' : 'deletion-incomplete');
          } else if (obs.purge !== undefined) {
            purgesSucceeded += 1;
          }

          if (obs.after.state === 'completed') {
            completions += 1;
            // Reaching the end means all four ran, in order, and all four succeeded.
            expect(obs.destructive).toStrictEqual([...DESTRUCTIVE_EFFECT_ORDER]);
            expect(appended).toStrictEqual([...DESTRUCTIVE_EFFECT_ORDER]);
          }
        }

        // The same counts read off the call log: the Auth_Service was reached once per
        // purge that actually removed records, and the Session was ended only on a run
        // that cleared the tracker first and completed.
        expect(ports.calls.filter((call) => call === 'remove-account')).toHaveLength(
          purgesSucceeded
        );
        expect(ports.calls.filter((call) => call === 'clear-tracker')).toHaveLength(completions);
        expect(ports.calls.filter((call) => call === 'end-session')).toHaveLength(completions);
      }),
      { numRuns: 120 }
    );
  });

  // Feature: user-auth-and-cloud-storage, Property 20: Account deletion removes nothing
  // before its gates pass, then proceeds in order
  //
  // **Validates: Requirements 11.2, 11.5**
  it('never advances from re-authentication into a destructive step without the confirmation text being typed again', async () => {
    // Exhaustive over the machine rather than over a sample of it: no entry in the
    // transition table leads from the prompt to any state that names a destructive effect.
    // This is a negative, so no amount of running the flow could establish it.
    expect(
      DELETION_TRANSITIONS.filter(
        (transition) =>
          transition.from === 'reauthenticating' && EFFECT_FOR_STATE[transition.to] !== undefined
      )
    ).toStrictEqual([]);

    await fc.assert(
      fc.asyncProperty(arbDeletionCase(), async (kase) => {
        const { observations } = await runDeletionCase(kase);
        const events = everyDeletionEvent(kase);

        // Every prompt the generated sequence actually reached, however it got there — a
        // stale authentication, a Session that expired mid-flow, a purge that came back
        // 401, or an Account removal that demanded a recent login.
        const prompts = observations
          .flatMap((obs) => [obs.before, obs.after])
          .filter((context) => context.state === 'reauthenticating');

        for (const prompt of prompts) {
          // Sitting at the prompt reaches no port at all.
          const idle = recordingPorts(kase);
          expect((await advanceAccountDeletion(prompt, idle)).state).toBe('reauthenticating');
          expect(idle.calls).toStrictEqual([]);

          for (const event of events) {
            const next = reduceDeletion(prompt, event);
            // Whatever arrives next — including the events a destructive state would have
            // admitted — cannot be a destructive state, and removes nothing.
            expect(EFFECT_FOR_STATE[next.state]).toBeUndefined();
            expect(next.completedEffects).toStrictEqual(prompt.completedEffects);
            if (next.state !== 'confirming') continue;

            // The only way back in is the confirmation step with the field emptied, so a
            // successful re-authentication cannot resume the removal on its own.
            expect(next.confirmationText).toBe('');
            expect(isConfirmEnabled(next)).toBe(false);

            const resubmitted = reduceDeletion(next, {
              type: 'confirm-submitted',
              authTimeMs: NOW_MS,
              nowMs: NOW_MS,
            });
            // Confirming again on the freshest possible authentication still removes
            // nothing, because the text is gone.
            expect(resubmitted.state).toBe('confirming');
            expect(resubmitted.message).toBe('confirmation-mismatch');
            expect(resubmitted.completedEffects).toStrictEqual(prompt.completedEffects);

            const probe = recordingPorts(kase);
            expect((await advanceAccountDeletion(resubmitted, probe)).state).toBe('confirming');
            expect(probe.calls).toStrictEqual([]);
          }
        }

        // And no step that began at the prompt removed anything.
        for (const obs of observations) {
          if (obs.before.state === 'reauthenticating') {
            expect(obs.destructive).toStrictEqual([]);
          }
        }
      }),
      { numRuns: 100 }
    );
  });
});
