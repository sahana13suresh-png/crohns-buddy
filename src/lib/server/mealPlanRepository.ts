/**
 * The Meal_Plan_Store port.
 *
 * Route handlers depend on {@link MealPlanRepository} and never on the AWS SDK, so the
 * in-memory implementation can substitute in tests and serve as the model for the
 * model-based ordering, pagination, and cap properties. Two implementations satisfy it:
 * `dynamoMealPlanRepository.ts` in production and `inMemoryMealPlanRepository.ts` in
 * tests; both reimplement the same conditions, so a property that holds against one is
 * meaningful about the other.
 *
 * Two shapes of the port are load-bearing:
 *
 * 1. **Every method takes `userId` as its first parameter, and no method accepts a scan
 *    or any other cross-partition read.** There is no operation here capable of reading
 *    more than one User_Id, which is how Requirement 7.2's "no operation that reads
 *    across more than one User_Id" is enforced — by the absence of the affordance rather
 *    than by a guard an implementation could forget. The `userId` passed is always the
 *    one derived from the verified Auth_Token (Requirements 7.1, 7.7); nothing in this
 *    module accepts a User_Id supplied by a request.
 * 2. **The clock and the id generator are injected**, as {@link Clock} and
 *    {@link MealPlanIdGenerator}, rather than called directly. Requirements 5.2, 8.4, and
 *    9.1 all constrain timestamp behavior, and the property tests need those
 *    deterministic.
 *
 * This module declares the contract only — it holds no implementation and performs no
 * I/O, so it is safe to import from anywhere on the server.
 */

import type { MealPlanRecord, MealPlanSummary, PendingDeletion } from '../types';

// ─── Injected dependencies ─────────────────────────────────────────────────────

/**
 * Current time in milliseconds since the Unix epoch. Injected rather than reading
 * `Date.now()` so timestamp behavior is deterministic under test (Requirements 5.2,
 * 8.4, 9.1).
 */
export type Clock = () => number;

/**
 * Produces a fresh Meal_Plan_Id. Injected rather than generating inline so id assignment
 * is deterministic under test; the production generator derives the ULID from the same
 * {@link Clock}, keeping the id's embedded millisecond timestamp equal to `createdAt`.
 */
export type MealPlanIdGenerator = () => string;

/** The two injected collaborators every {@link MealPlanRepository} implementation needs. */
export interface MealPlanRepositoryDeps {
  /** Current time in epoch milliseconds. */
  now: Clock;
  /** Fresh Meal_Plan_Id for a record being created. */
  newMealPlanId: MealPlanIdGenerator;
}

// ─── Store constants ───────────────────────────────────────────────────────────

/** Most Meal_Plan_Records one Account may hold (Requirements 5.8, 5.9). */
export const MEAL_PLAN_RECORD_CAP = 100;

/** Records returned per listing page (Requirements 6.2, 6.3). */
export const MEAL_PLAN_PAGE_SIZE = 20;

/**
 * Sort key of the per-Account metadata item holding the record counter and the storage
 * acknowledgment. `#` is outside the letters-digits-hyphens charset Requirement 7.8
 * permits, so this key can never be reached through a request, and every Crockford
 * base-32 id sorts strictly above it — which is what lets a listing exclude it in the
 * key condition rather than by a post-filter.
 */
export const META_SORT_KEY = '#meta';

/**
 * Reserved partition key holding the pending-deletion entries (Requirement 11.7). It
 * cannot collide with a Firebase uid, which is 28 alphanumeric characters.
 */
export const PENDING_DELETION_PARTITION = 'PENDING#DELETION';

// ─── Results ───────────────────────────────────────────────────────────────────

/**
 * One page of Meal_Plan_Summary values, newest first. `nextCursor` is absent — never
 * `null` or `''` — on the final page (Requirements 6.2, 6.3, 6.8).
 */
export interface ListPage {
  items: MealPlanSummary[];
  nextCursor?: string;
}

/**
 * Outcome of a create, update, or rename. Every failure an implementation can encounter
 * without throwing is a member here, so a caller mapping outcomes to statuses cannot
 * silently miss one.
 */
export type SaveOutcome =
  | { kind: 'created'; mealPlanId: string }
  | { kind: 'updated' }
  | { kind: 'cap-reached' } // Req 5.9 → 409
  | { kind: 'ack-required' } // Req 12.3 → 428
  | { kind: 'not-found' }; // Req 7.3, 7.4 → 404

// ─── The port ──────────────────────────────────────────────────────────────────

/**
 * Every Meal_Plan_Store operation the application needs, each confined to a single
 * User_Id partition.
 */
export interface MealPlanRepository {
  /**
   * Writes a new Meal_Plan_Record, atomically with the record counter and the storage
   * acknowledgment, so the cap and the acknowledgment gate either both hold or nothing
   * is written (Requirements 5.2, 5.8, 5.9, 12.3, 12.5).
   *
   * @param userId - User_Id derived from the verified Auth_Token
   * @param record - The record to write, already validated and within the size ceiling
   * @param ackStorage - Whether this request carries the Patient's acknowledgment of the
   *   storage notice; a first save without a recorded acknowledgment and without this
   *   flag writes nothing and yields `ack-required`
   * @returns `created` with the assigned Meal_Plan_Id, `cap-reached` when the Account
   *   already holds {@link MEAL_PLAN_RECORD_CAP} records, or `ack-required`
   */
  create(userId: string, record: MealPlanRecord, ackStorage: boolean): Promise<SaveOutcome>;

  /**
   * Replaces the content and title of an existing record, setting `updatedAt` while
   * structurally preserving `mealPlanId` and `createdAt` (Requirements 5.3, 5.4).
   *
   * @returns `updated`, or `not-found` when the Account holds no such record
   */
  update(userId: string, record: MealPlanRecord): Promise<SaveOutcome>;

  /**
   * Changes only the title of an existing record, leaving its content untouched and
   * setting `updatedAt` (Requirements 8.4, 8.6).
   *
   * @param nowMs - Timestamp to record as `updatedAt`, from the injected {@link Clock}
   * @returns `updated`, or `not-found` when the Account holds no such record
   */
  rename(userId: string, mealPlanId: string, title: string, nowMs: number): Promise<SaveOutcome>;

  /**
   * Reads one full Meal_Plan_Record (Requirement 6.4).
   *
   * @returns The record, or `null` when the Account holds no record under that id — the
   *   same result a record owned by another Account produces, since the read cannot
   *   leave this Account's partition (Requirements 7.3, 7.4, 7.7)
   */
  get(userId: string, mealPlanId: string): Promise<MealPlanRecord | null>;

  /**
   * Reads one page of at most {@link MEAL_PLAN_PAGE_SIZE} summaries, newest first, with
   * the metadata item excluded (Requirements 6.1, 6.2, 6.3, 6.8).
   *
   * @param cursor - Continuation token from a previous page; the page returned starts
   *   strictly after the sort-key position it names. The cursor carries no User_Id, so
   *   one lifted from another Account names a position inside this caller's own
   *   partition and nothing more.
   */
  list(userId: string, cursor?: string): Promise<ListPage>;

  /**
   * Reads every Meal_Plan_Record the Account holds, in full and with no page limit, for
   * the data export (Requirement 10.2). Bounded by {@link MEAL_PLAN_RECORD_CAP}.
   */
  listAll(userId: string): Promise<MealPlanRecord[]>;

  /**
   * Removes one Meal_Plan_Record. Idempotent: an already-absent record is not an error,
   * so a repeated deletion reports the same success (Requirements 8.1, 8.3).
   */
  delete(userId: string, mealPlanId: string): Promise<void>;

  /**
   * Removes every Meal_Plan_Record the Account holds, for account deletion
   * (Requirement 11.3).
   *
   * @returns How many records were removed and how many remain; a non-zero `remaining`
   *   is what the caller turns into a pending-deletion entry (Requirements 11.7, 11.9)
   */
  purge(userId: string): Promise<{ deletedCount: number; remaining: number }>;

  /**
   * Records that records remain for a User_Id whose Account has been removed, so the
   * sweep can finish the removal later (Requirement 11.7). Idempotent for a User_Id
   * already on the list.
   */
  enqueuePendingDeletion(userId: string): Promise<void>;

  /**
   * Reads the pending-deletion entries due at `nowMs`, for the sweep (Requirement 11.7).
   * Touches nothing outside the {@link PENDING_DELETION_PARTITION} partition and accepts
   * no request-controlled User_Id.
   *
   * @param nowMs - Current time in epoch milliseconds, from the injected {@link Clock}
   */
  listPendingDeletions(nowMs: number): Promise<PendingDeletion[]>;
}
