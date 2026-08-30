import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { assertServerEnv, missingCredentialGroups, REQUIRED } from './env';

const ALL_VARS = [
  ...REQUIRED.AUTH_SERVICE,
  ...REQUIRED.AI_INFERENCE,
  ...REQUIRED.MEAL_PLAN_STORE,
];

function emptyEnv(): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test' } as NodeJS.ProcessEnv;
}

function envWithAllPresent(): NodeJS.ProcessEnv {
  const env = emptyEnv();
  for (const name of ALL_VARS) env[name] = `value-for-${name}`;
  return env;
}

describe('assertServerEnv', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = envWithAllPresent();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('does not throw when every variable of every requested group is present', () => {
    expect(() =>
      assertServerEnv(['AUTH_SERVICE', 'AI_INFERENCE', 'MEAL_PLAN_STORE']),
    ).not.toThrow();
  });

  it('does not throw when no group is requested', () => {
    process.env = emptyEnv();
    expect(() => assertServerEnv([])).not.toThrow();
  });

  it('allows the AI inference group to use an AWS execution role', () => {
    delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    expect(() => assertServerEnv(['AI_INFERENCE'])).not.toThrow();
  });

  it('treats an empty-string value as absent', () => {
    process.env.MEAL_PLAN_TABLE_NAME = '';
    expect(() => assertServerEnv(['MEAL_PLAN_STORE'])).toThrow(/MEAL_PLAN_STORE/);
  });

  it('names every group that has a missing variable', () => {
    delete process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    delete process.env.MEAL_PLAN_TABLE_NAME;

    let message = '';
    try {
      assertServerEnv(['AUTH_SERVICE', 'AI_INFERENCE', 'MEAL_PLAN_STORE']);
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain('AUTH_SERVICE');
    expect(message).toContain('MEAL_PLAN_STORE');
    expect(message).not.toContain('AI_INFERENCE');
  });

  it('ignores groups that were not requested', () => {
    delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    expect(() => assertServerEnv(['AUTH_SERVICE'])).not.toThrow();
  });

  it('accepts execution-role credentials when both static store keys are absent', () => {
    delete process.env.MEAL_PLAN_AWS_ACCESS_KEY_ID;
    delete process.env.MEAL_PLAN_AWS_SECRET_ACCESS_KEY;
    expect(() => assertServerEnv(['MEAL_PLAN_STORE'])).not.toThrow();
  });

  it('rejects a partial static store credential pair', () => {
    process.env.MEAL_PLAN_AWS_ACCESS_KEY_ID = 'AKIAEXAMPLE';
    delete process.env.MEAL_PLAN_AWS_SECRET_ACCESS_KEY;
    expect(() => assertServerEnv(['MEAL_PLAN_STORE'])).toThrow(
      /MEAL_PLAN_AWS_SECRET_ACCESS_KEY/
    );
  });

  it('substitutes no value for an absent variable', () => {
    delete process.env.MEAL_PLAN_AWS_REGION;
    expect(() => assertServerEnv(['MEAL_PLAN_STORE'])).toThrow();
    expect(process.env.MEAL_PLAN_AWS_REGION).toBeUndefined();
  });

  it('reports each missing group once, in requested order', () => {
    process.env = emptyEnv();
    expect(
      missingCredentialGroups(['MEAL_PLAN_STORE', 'AUTH_SERVICE', 'MEAL_PLAN_STORE']),
    ).toEqual(['MEAL_PLAN_STORE', 'AUTH_SERVICE']);
  });
});
