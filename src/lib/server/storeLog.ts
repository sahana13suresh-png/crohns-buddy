/**
 * Meal_Plan_Store operation logging (Requirement 7.6).
 *
 * This module exports exactly one function, and its parameter type is closed:
 * the Meal_Plan_Id, the operation name, the outcome, an optional failure
 * category, and the operation timestamp. There is no `unknown`, no index
 * signature, and no `userId` field, so Meal_Plan content, quiz answers, email
 * addresses, display names, and Auth_Token values cannot be logged even by
 * accident — passing one is a compile error rather than a runtime leak.
 *
 * This is the only module permitted to emit store-operation output through
 * `console.*`; every other server module routes its store outcomes here.
 */

/** The store operations that may be logged. */
export type StoreOp = 'create' | 'update' | 'rename' | 'get' | 'list' | 'delete' | 'purge';

/** A store operation either succeeded or failed; there is no third outcome. */
export type StoreOutcome = 'success' | 'failure';

/** The failure categories a failed operation may report. */
export type StoreFailureCategory =
  | 'not-found'
  | 'cap'
  | 'size'
  | 'throttled'
  | 'unavailable'
  | 'validation';

/**
 * The complete set of fields a store-operation log entry may carry. Adding a
 * field here would widen what can be logged, so this type is deliberately
 * closed and mirrors Requirement 7.6 one-to-one.
 */
export interface StoreLogEntry {
  mealPlanId: string;
  op: StoreOp;
  outcome: StoreOutcome;
  failureCategory?: StoreFailureCategory;
  atMs: number;
}

/**
 * Emits one store-operation log line.
 *
 * The emitted line carries the five permitted fields and nothing else:
 * `failureCategory` is omitted entirely when absent rather than written as
 * `null` or `''`. Every value comes straight from the closed parameter type, so
 * no content or personal data can reach the output stream.
 */
export function logStoreOp(entry: {
  mealPlanId: string;
  op: StoreOp;
  outcome: StoreOutcome;
  failureCategory?: StoreFailureCategory;
  atMs: number;
}): void {
  const line: StoreLogEntry = {
    mealPlanId: entry.mealPlanId,
    op: entry.op,
    outcome: entry.outcome,
    ...(entry.failureCategory === undefined ? {} : { failureCategory: entry.failureCategory }),
    atMs: entry.atMs,
  };

  // This module is the single allowed `console.*` site for store operations; the
  // `no-console` allowlist entry in `.eslintrc.json` is what permits it here and
  // makes it an error everywhere else under `src/lib/server` and `src/app/api`.
  console.info(JSON.stringify({ event: 'mealPlanStoreOp', ...line }));
}
