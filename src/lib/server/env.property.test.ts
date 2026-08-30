/**
 * Property 19: Credential-group validation fails startup naming every missing group
 *
 * **Validates: Requirements 13.11**
 *
 * *For any* subset of required environment variables removed from the server
 * environment, `assertServerEnv` throws if and only if at least one variable
 * required by a requested credential group is absent, the thrown error names
 * every credential group with a missing variable, and no default or placeholder
 * value is substituted for any absent variable.
 *
 * The generator removes variables in both ways the implementation must treat as
 * absent — deleting the key and setting the empty string — so an empty-string
 * credential can never pass as supplied. Requested group lists are drawn as
 * arbitrary multisets, including the empty list and lists with repeats, because
 * route modules choose their own group set and may name a group twice.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fc from 'fast-check';

import { assertServerEnv, REQUIRED, type CredentialGroup } from './env';

const GROUPS: CredentialGroup[] = ['AUTH_SERVICE', 'AI_INFERENCE', 'MEAL_PLAN_STORE'];

const ALL_VARS: string[] = GROUPS.flatMap((group) => REQUIRED[group]);

/** How a variable is made absent. Both readings must count as absent. */
type Removal = 'delete' | 'empty';

/**
 * A generated environment scenario: which variables are absent (and how), plus
 * the credential groups the route module asks for.
 */
interface Scenario {
  readonly absences: ReadonlyArray<readonly [string, Removal]>;
  readonly requested: readonly CredentialGroup[];
}

const arbScenario: fc.Arbitrary<Scenario> = fc.record({
  // A subset of the required variables, each paired with a way of being absent.
  absences: fc.uniqueArray(
    fc.tuple(fc.constantFrom(...ALL_VARS), fc.constantFrom<Removal>('delete', 'empty')),
    { selector: ([name]) => name, maxLength: ALL_VARS.length },
  ),
  // Includes the empty list and lists that repeat a group.
  requested: fc.array(fc.constantFrom(...GROUPS), { maxLength: 5 }),
});

/**
 * Installs an environment where every required variable is present, then applies
 * the scenario's absences. Returns the absent-variable names.
 */
function installEnv(scenario: Scenario): Set<string> {
  const env = { NODE_ENV: 'test' } as NodeJS.ProcessEnv;
  for (const name of ALL_VARS) env[name] = `value-for-${name}`;
  const absent = new Set<string>();
  for (const [name, removal] of scenario.absences) {
    if (removal === 'delete') delete env[name];
    else env[name] = '';
    absent.add(name);
  }
  process.env = env;
  return absent;
}

describe('Property 19: credential-group validation fails startup naming every missing group', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  it('throws exactly when a requested group has an absent variable, naming every such group', () => {
    fc.assert(
      fc.property(arbScenario, (scenario) => {
        const absent = installEnv(scenario);

        // The expectation, computed independently of the implementation.
        const requestedSet = new Set(scenario.requested);
        const expectedMissingGroups = GROUPS.filter(
          (group) => requestedSet.has(group) && REQUIRED[group].some((name) => absent.has(name)),
        );

        let thrown: Error | undefined;
        try {
          assertServerEnv([...scenario.requested]);
        } catch (err) {
          thrown = err as Error;
        }

        // Throws if and only if a requested group has at least one absent variable.
        expect(thrown !== undefined).toBe(expectedMissingGroups.length > 0);

        if (thrown !== undefined) {
          const message = thrown.message;
          // Names every credential group with a missing variable...
          for (const group of expectedMissingGroups) expect(message).toContain(group);
          // ...and names no other group.
          for (const group of GROUPS) {
            if (!expectedMissingGroups.includes(group)) expect(message).not.toContain(group);
          }
        }

        // No default or placeholder is substituted for any absent variable: a
        // deleted key stays deleted and an empty value stays empty.
        for (const [name, removal] of scenario.absences) {
          if (removal === 'delete') expect(process.env[name]).toBeUndefined();
          else expect(process.env[name]).toBe('');
        }
        // Present variables are left exactly as supplied.
        for (const name of ALL_VARS) {
          if (!absent.has(name)) expect(process.env[name]).toBe(`value-for-${name}`);
        }
      }),
      { numRuns: 300 },
    );
  });
});
