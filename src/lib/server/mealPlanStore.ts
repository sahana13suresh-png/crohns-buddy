/**
 * Production Meal_Plan_Store provider.
 *
 * Route handlers depend on the {@link MealPlanRepository} port, never on the AWS SDK, so
 * something has to decide which implementation a live request reaches. That decision
 * lives here rather than in a route module for two reasons:
 *
 * - **The client is built once, lazily.** A DynamoDB client per request would re-resolve
 *   credentials and re-create connection state on every invocation, which on a serverless
 *   platform is the difference between a warm function reusing a socket and one paying the
 *   handshake again (Requirement 13.6's cost posture). The first request to touch the
 *   store builds it; later requests in the same instance reuse it.
 * - **Construction stays out of module evaluation.** `assertServerEnv` runs at route
 *   module scope so an absent credential fails at startup (Requirements 13.7, 13.11), but
 *   building the client itself is deferred, so importing a route — as the route's own
 *   tests do — does not open a connection or require real AWS credentials.
 *
 * The clock and the id generator are the injected ones the design calls for
 * ({@link Clock}, {@link MealPlanIdGenerator}); the production values read the system
 * clock in exactly one place each.
 */

import { newMealPlanId } from '../mealPlanId';
import { createDynamoMealPlanRepository } from './dynamoMealPlanRepository';
import type { Clock, MealPlanIdGenerator, MealPlanRepository } from './mealPlanRepository';

/** The system clock, in milliseconds since the Unix epoch. */
export const systemClock: Clock = () => Date.now();

/**
 * Produces a Meal_Plan_Id whose embedded millisecond timestamp is the current time, which
 * is what keeps a stored record's id and its `createdAt` in agreement.
 */
export const systemMealPlanIdGenerator: MealPlanIdGenerator = () => newMealPlanId(Date.now());

/** Memoized production store, built on first use. */
let repository: MealPlanRepository | undefined;

/**
 * The production Meal_Plan_Store, built on first call and reused afterwards.
 *
 * @throws {Error} When a `MEAL_PLAN_STORE` variable is absent — the same error
 *   `assertServerEnv` raises, naming the group (Requirement 13.11)
 */
export function getMealPlanRepository(): MealPlanRepository {
  repository ??= createDynamoMealPlanRepository({
    now: systemClock,
    newMealPlanId: systemMealPlanIdGenerator,
  });
  return repository;
}

/**
 * Replaces the memoized store, or clears it when passed `undefined`.
 *
 * Present so a test can drive a route over the in-memory repository without reaching
 * DynamoDB. Production code never calls this.
 */
export function setMealPlanRepository(next: MealPlanRepository | undefined): void {
  repository = next;
}
