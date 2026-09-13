import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ACCESS_KEY_ID_PATTERN,
  assertReadOnly,
  checkClientBundle,
  checkCronFrequency,
  checkIamPolicy,
  classifyAwsFailure,
  compareRegions,
  describeSseState,
  evaluateCertificate,
  evaluateTableDescription,
  findSpendBudget,
  inspectPolicy,
  misprefixedServerVariables,
  ownerContactAddress,
  readCommittedTable,
  resolveTargetHost,
  runsAtMostOncePerDay,
  secretValuesToScan,
} from './verify-deployment';

/** Vitest runs from the repository root. */
const REPO_ROOT = process.cwd();
const committed = readCommittedTable();

describe('cron frequency (Requirement 11.7)', () => {
  it('accepts a fixed minute and hour', () => {
    expect(runsAtMostOncePerDay('0 3 * * *')).toBe(true);
    expect(runsAtMostOncePerDay('30 23 * * 1')).toBe(true);
  });

  it('rejects any expression that fires more than once per day', () => {
    expect(runsAtMostOncePerDay('*/5 * * * *')).toBe(false);
    expect(runsAtMostOncePerDay('0 * * * *')).toBe(false);
    expect(runsAtMostOncePerDay('0 3,15 * * *')).toBe(false);
    expect(runsAtMostOncePerDay('0 0-6 * * *')).toBe(false);
  });

  it('rejects a malformed expression', () => {
    expect(runsAtMostOncePerDay('0 3 * *')).toBe(false);
    expect(runsAtMostOncePerDay('99 3 * * *')).toBe(false);
  });

  it('accepts an EventBridge cron expression', () => {
    expect(runsAtMostOncePerDay('cron(0 3 * * ? *)')).toBe(true);
  });

  it('passes against the committed AWS template', () => {
    const result = checkCronFrequency();
    expect(result.status).toBe('pass');
  });
});

describe('IAM policy scope (Requirement 7.5)', () => {
  const expectedArn = `arn:aws:dynamodb:${committed.region}:*:table/${committed.tableName}`;

  it('passes against the committed policy', () => {
    expect(checkIamPolicy().status).toBe('pass');
    const policy: unknown = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'infra', 'meal-plan-store-policy.json'), 'utf8'),
    );
    expect(inspectPolicy(policy, expectedArn).problems).toEqual([]);
  });

  it('rejects a policy that grants Scan', () => {
    const policy = {
      Statement: [{ Effect: 'Allow', Action: ['dynamodb:Query', 'dynamodb:Scan'], Resource: expectedArn }],
    };
    expect(inspectPolicy(policy, expectedArn).problems.join(' ')).toContain('dynamodb:Scan');
  });

  it('rejects a wildcard resource or a second table', () => {
    const wildcard = {
      Statement: [{ Effect: 'Allow', Action: ['dynamodb:Query'], Resource: 'arn:aws:dynamodb:*:*:table/*' }],
    };
    expect(inspectPolicy(wildcard, expectedArn).problems.join(' ')).toContain('expected');

    const twoTables = {
      Statement: [
        { Effect: 'Allow', Action: ['dynamodb:Query'], Resource: [expectedArn, `${expectedArn}-staging`] },
      ],
    };
    expect(inspectPolicy(twoTables, expectedArn).problems.join(' ')).toContain('exactly 1 resource ARN');
  });

  it('rejects a grant outside DynamoDB and a wildcard action', () => {
    const policy = {
      Statement: [{ Effect: 'Allow', Action: ['s3:GetObject', 'dynamodb:*'], Resource: expectedArn }],
    };
    const problems = inspectPolicy(policy, expectedArn).problems.join(' ');
    expect(problems).toContain('outside DynamoDB');
    expect(problems).toContain('wildcard action');
  });
});

describe('live table configuration (Requirements 13.3, 12.6)', () => {
  it('treats an absent SSEDescription as encrypted at rest with the AWS owned key', () => {
    const table = { BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' } };
    expect(evaluateTableDescription(table, 'PAY_PER_REQUEST')).toEqual([]);
    expect(describeSseState(table)).toContain('AWS owned key');
  });

  it('accepts an enabled KMS key', () => {
    const table = {
      BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
      SSEDescription: { Status: 'ENABLED', SSEType: 'KMS' },
    };
    expect(evaluateTableDescription(table, 'PAY_PER_REQUEST')).toEqual([]);
  });

  it('rejects a KMS key that is not in force', () => {
    const table = {
      BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
      SSEDescription: { Status: 'DISABLED' },
    };
    expect(evaluateTableDescription(table, 'PAY_PER_REQUEST').join(' ')).toContain('DISABLED');
  });

  it('rejects provisioned capacity', () => {
    const table = {
      BillingModeSummary: { BillingMode: 'PROVISIONED' },
      ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
    };
    expect(evaluateTableDescription(table, 'PAY_PER_REQUEST').join(' ')).toContain('PROVISIONED');
  });

  it('rejects a table that reports no billing mode but holds provisioned capacity', () => {
    const table = { ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 } };
    expect(evaluateTableDescription(table, 'PAY_PER_REQUEST').join(' ')).toContain('PROVISIONED');
  });
});

describe('region agreement (Requirement 13.6)', () => {
  it('passes when the store, the inference endpoint, and the artifacts agree', () => {
    const result = compareRegions({
      mealPlanRegion: committed.region,
      bedrockRegion: committed.region,
      mealPlanTableName: committed.tableName,
      committed,
    });
    expect(result.status).toBe('pass');
  });

  it('fails when the store region differs from the Bedrock region', () => {
    const result = compareRegions({
      mealPlanRegion: 'eu-west-1',
      bedrockRegion: committed.region,
      committed,
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('eu-west-1');
  });

  it('applies the code default when AWS_REGION is unset', () => {
    expect(compareRegions({ mealPlanRegion: 'us-east-1', committed }).status).toBe('pass');
    const mismatch = compareRegions({ mealPlanRegion: 'us-west-2', committed });
    expect(mismatch.status).toBe('fail');
    expect(mismatch.detail).toContain('AWS_REGION unset');
  });

  it('fails when only the table name moved', () => {
    const result = compareRegions({
      mealPlanRegion: committed.region,
      bedrockRegion: committed.region,
      mealPlanTableName: 'some-other-table',
      committed,
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('some-other-table');
  });

  it('skips when the deployment environment is not loaded', () => {
    expect(compareRegions({ committed }).status).toBe('skip');
  });
});

describe('client bundle scan (Requirements 7.5, 13.7)', () => {
  it('flags a server-only variable carrying the NEXT_PUBLIC_ prefix', () => {
    expect(misprefixedServerVariables({ NEXT_PUBLIC_MEAL_PLAN_TABLE_NAME: 'x' })).toEqual([
      'NEXT_PUBLIC_MEAL_PLAN_TABLE_NAME',
    ]);
    expect(misprefixedServerVariables({ NEXT_PUBLIC_AWS_BEARER_TOKEN_BEDROCK: 'x' })).toHaveLength(1);
    expect(misprefixedServerVariables({ NEXT_PUBLIC_FIREBASE_API_KEY: 'x', MEAL_PLAN_TABLE_NAME: 'y' })).toEqual([]);
  });

  it('scans only server-only values long enough to match unambiguously', () => {
    const scanned = secretValuesToScan({
      MEAL_PLAN_AWS_SECRET_ACCESS_KEY: 'a-long-secret-value',
      MEAL_PLAN_AWS_REGION: 'us-east-1',
      NEXT_PUBLIC_FIREBASE_API_KEY: 'a-long-public-value',
    });
    expect(scanned.map((entry) => entry.name)).toEqual(['MEAL_PLAN_AWS_SECRET_ACCESS_KEY']);
  });

  it('matches an access key id and not an ordinary identifier', () => {
    expect(ACCESS_KEY_ID_PATTERN.test(['AKIA', 'A'.repeat(16)].join(''))).toBe(true);
    expect(ACCESS_KEY_ID_PATTERN.test(['ASIA', 'A'.repeat(16)].join(''))).toBe(true);
    expect(ACCESS_KEY_ID_PATTERN.test('crohns-buddy-meal-plans')).toBe(false);
  });

  it('fails when a store credential is misprefixed, before looking at any file', () => {
    const result = checkClientBundle('/nonexistent', { NEXT_PUBLIC_MEAL_PLAN_AWS_ACCESS_KEY_ID: 'leaked' });
    expect(result.status).toBe('fail');
  });

  it('skips when no build output is present', () => {
    const result = checkClientBundle(path.join(REPO_ROOT, '.next', 'static-does-not-exist'), {});
    expect(result.status).toBe('skip');
    expect(result.detail).toContain('npm run build');
  });
});

describe('AWS access is read-only and unavailability is distinguished from failure', () => {
  it('allows describe, list, and get operations', () => {
    expect(() => assertReadOnly(['dynamodb', 'describe-table'])).not.toThrow();
    expect(() => assertReadOnly(['budgets', 'describe-budgets'])).not.toThrow();
    expect(() => assertReadOnly(['sns', 'list-subscriptions-by-topic'])).not.toThrow();
    expect(() => assertReadOnly(['sts', 'get-caller-identity'])).not.toThrow();
  });

  it('refuses anything that could change state', () => {
    expect(() => assertReadOnly(['dynamodb', 'delete-table'])).toThrow();
    expect(() => assertReadOnly(['dynamodb', 'update-table'])).toThrow();
    expect(() => assertReadOnly(['budgets', 'create-budget'])).toThrow();
  });

  it('treats missing or expired credentials as unavailability and other errors as failures', () => {
    expect(classifyAwsFailure('Unable to locate credentials')).toBe('unavailable');
    expect(classifyAwsFailure('An error occurred (ExpiredToken) when calling ...')).toBe('unavailable');
    expect(classifyAwsFailure('AccessDeniedException')).toBe('unavailable');
    expect(classifyAwsFailure('ResourceNotFoundException: Requested resource not found')).toBe('error');
  });
});

describe('spend alert (Requirement 13.8)', () => {
  it('matches the monthly cost budget at the threshold', () => {
    const budgets = [
      { BudgetName: 'usage', BudgetType: 'USAGE', BudgetLimit: { Amount: '20.0', Unit: 'USD' } },
      { BudgetName: 'other-currency', BudgetType: 'COST', BudgetLimit: { Amount: '20.0', Unit: 'EUR' } },
      { BudgetName: 'spend', BudgetType: 'COST', BudgetLimit: { Amount: '20.0', Unit: 'USD' } },
    ];
    expect(findSpendBudget(budgets, 20)?.BudgetName).toBe('spend');
  });

  it('does not match a budget at a different amount', () => {
    const budgets = [{ BudgetName: 'spend', BudgetType: 'COST', BudgetLimit: { Amount: '10.0', Unit: 'USD' } }];
    expect(findSpendBudget(budgets, 20)).toBeUndefined();
  });

  it('reads the owner contact address from docs/hosting.md', () => {
    expect(ownerContactAddress()).toMatch(/^[^@\s]+@[^@\s]+$/);
  });

  it('returns no address when the document is absent', () => {
    expect(ownerContactAddress(path.join(REPO_ROOT, 'docs', 'no-such-doc.md'))).toBeUndefined();
  });
});

describe('TLS certificate (Requirement 13.4)', () => {
  const now = new Date('2025-01-01T00:00:00.000Z');
  const daysFromNow = (days: number) => new Date(now.getTime() + days * 86_400_000);

  it('accepts a platform-managed certificate well before expiry', () => {
    const evaluation = evaluateCertificate(
      { issuer: "Let's Encrypt", validFrom: daysFromNow(-30), validTo: daysFromNow(60) },
      now,
    );
    expect(evaluation.problems).toEqual([]);
    expect(Math.round(evaluation.daysRemaining)).toBe(60);
    expect(Math.round(evaluation.lifetimeDays)).toBe(90);
  });

  it('fails inside the 15-day renewal margin', () => {
    const evaluation = evaluateCertificate(
      { issuer: "Let's Encrypt", validFrom: daysFromNow(-80), validTo: daysFromNow(10) },
      now,
    );
    expect(evaluation.problems.join(' ')).toContain('renewal margin');
  });

  it('fails a certificate no platform renews', () => {
    const evaluation = evaluateCertificate(
      { issuer: 'Self-Signed Corp', validFrom: daysFromNow(-1), validTo: daysFromNow(365) },
      now,
    );
    expect(evaluation.problems.join(' ')).toContain('not a platform-managed CA');
  });
});

describe('target host resolution', () => {
  it('prefers the flag, then the environment', () => {
    expect(resolveTargetHost(['--url=https://example.com/path'], {})).toBe('example.com');
    expect(resolveTargetHost([], { VERIFY_DEPLOYMENT_URL: 'example.org' })).toBe('example.org');
    expect(resolveTargetHost([], { VERCEL_PROJECT_PRODUCTION_URL: 'app.vercel.app' })).toBe('app.vercel.app');
  });

  it('returns nothing when no target is supplied', () => {
    expect(resolveTargetHost([], {})).toBeUndefined();
    expect(resolveTargetHost([], { VERIFY_DEPLOYMENT_URL: '' })).toBeUndefined();
  });
});
