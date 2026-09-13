/**
 * Deployment smoke checks — the machine-checked subset of infra/README.md.
 *
 * Run after a deploy:
 *
 *   npm run verify:deployment -- --url=https://your-domain.example
 *
 * Every check is READ ONLY. The AWS calls this script makes are limited to
 * `describe`, `list`, and `get` verbs (enforced by `assertReadOnly` below), so
 * running it can neither create, modify, nor delete a resource.
 *
 * Checks that need live state — the AWS account and the deployed TLS endpoint —
 * skip with a reason when credentials or a target URL are absent, so the script
 * is runnable locally. Only a genuine mismatch exits non-zero.
 *
 * Requires Node 22.6 or newer, which runs TypeScript directly.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { connect } from 'node:tls';
import type { PeerCertificate } from 'node:tls';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TABLE_ARTIFACT = path.join(REPO_ROOT, 'infra', 'dynamodb-table.json');
const POLICY_ARTIFACT = path.join(REPO_ROOT, 'infra', 'meal-plan-store-policy.json');
const AWS_TEMPLATE = path.join(REPO_ROOT, 'infra', 'aws', 'template.yaml');
const HOSTING_DOC = path.join(REPO_ROOT, 'docs', 'hosting.md');
const CLIENT_BUNDLE_DIR = path.join(REPO_ROOT, '.next', 'static');

/** Requirement 13.4: the certificate must be renewed no later than 15 days before expiry. */
const TLS_RENEWAL_MARGIN_DAYS = 15;
/** Requirement 13.8: the spend alert threshold, in US dollars. */
const SPEND_ALERT_USD = 20;
/** src/lib/bedrock.ts falls back to this region when AWS_REGION is unset. */
const DEFAULT_BEDROCK_REGION = 'us-east-1';

/**
 * Certificate authorities used by platform-managed (auto-renewed) TLS. A
 * certificate from anywhere else was uploaded by hand and nothing renews it.
 */
const PLATFORM_MANAGED_ISSUERS = [
  "Let's Encrypt",
  'ISRG',
  'Google Trust Services',
  'Amazon',
];

export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface CheckResult {
  name: string;
  requirements: string;
  status: CheckStatus;
  detail: string;
}

const pass = (name: string, requirements: string, detail: string): CheckResult => ({
  name,
  requirements,
  status: 'pass',
  detail,
});
const fail = (name: string, requirements: string, detail: string): CheckResult => ({
  name,
  requirements,
  status: 'fail',
  detail,
});
const skip = (name: string, requirements: string, detail: string): CheckResult => ({
  name,
  requirements,
  status: 'skip',
  detail,
});

// ---------------------------------------------------------------------------
// Committed artifacts
// ---------------------------------------------------------------------------

function readJsonFile(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8')) as unknown;
}

export interface CommittedTable {
  region: string;
  tableName: string;
  billingMode: string;
}

export function readCommittedTable(file: string = TABLE_ARTIFACT): CommittedTable {
  const artifact = readJsonFile(file) as {
    region?: string;
    createTable?: { TableName?: string; BillingMode?: string };
  };
  const region = artifact.region;
  const tableName = artifact.createTable?.TableName;
  const billingMode = artifact.createTable?.BillingMode;
  if (!region || !tableName || !billingMode) {
    throw new Error(
      `${path.relative(REPO_ROOT, file)} is missing region, createTable.TableName, or createTable.BillingMode`,
    );
  }
  return { region, tableName, billingMode };
}

// ---------------------------------------------------------------------------
// Check: committed cron frequency (Requirement 11.7)
// ---------------------------------------------------------------------------

/**
 * A Vixie or EventBridge cron expression runs at most once per day only when
 * both the minute and the hour field name a single fixed value.
 */
export function runsAtMostOncePerDay(expression: string): boolean {
  const unwrapped = expression.trim().replace(/^cron\((.*)\)$/, '$1');
  const fields = unwrapped.split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) return false;
  const [minute, hour] = fields;
  const isFixed = (field: string, max: number): boolean =>
    /^\d{1,2}$/.test(field) && Number(field) <= max;
  return isFixed(minute, 59) && isFixed(hour, 23);
}

export function checkCronFrequency(file: string = AWS_TEMPLATE): CheckResult {
  const name = 'Committed cron expression runs at most once per day';
  const requirements = '11.7';
  const template = readFileSync(file, 'utf8');
  const schedules = Array.from(
    template.matchAll(/ScheduleExpression:\s*['"]?(cron\([^)]+\))['"]?/g),
    (match) => match[1],
  );
  if (schedules.length === 0) {
    return fail(name, requirements, 'the AWS template declares no EventBridge cron schedule');
  }
  const offenders = schedules.filter((schedule) => !runsAtMostOncePerDay(schedule));
  if (offenders.length > 0) {
    return fail(
      name,
      requirements,
      `these EventBridge schedules fire more than once per day: ${offenders.join(', ')}`,
    );
  }
  return pass(name, requirements, `${schedules.length} EventBridge schedule: ${schedules.join(', ')}`);
}

// ---------------------------------------------------------------------------
// Check: IAM policy scope (Requirement 7.5)
// ---------------------------------------------------------------------------

export interface PolicyFinding {
  resources: string[];
  actions: string[];
  problems: string[];
}

/**
 * The policy must name exactly one table and must not grant `dynamodb:Scan` —
 * the one DynamoDB read that spans partitions.
 */
export function inspectPolicy(policy: unknown, expectedArn: string): PolicyFinding {
  const statements = ((policy as { Statement?: unknown }).Statement ?? []) as {
    Effect?: string;
    Action?: string | string[];
    Resource?: string | string[];
    NotAction?: unknown;
    NotResource?: unknown;
  }[];
  const problems: string[] = [];
  const resources: string[] = [];
  const actions: string[] = [];

  if (statements.length !== 1) {
    problems.push(`expected exactly 1 statement, found ${statements.length}`);
  }

  for (const statement of statements) {
    if (statement.Effect !== 'Allow') problems.push(`statement Effect is "${statement.Effect}", expected "Allow"`);
    if (statement.NotAction !== undefined) problems.push('statement uses NotAction, which grants by exclusion');
    if (statement.NotResource !== undefined) problems.push('statement uses NotResource, which grants by exclusion');
    resources.push(...toArray(statement.Resource));
    actions.push(...toArray(statement.Action));
  }

  if (resources.length !== 1) {
    problems.push(`expected exactly 1 resource ARN, found ${resources.length}: ${resources.join(', ') || 'none'}`);
  } else if (resources[0] !== expectedArn) {
    problems.push(`resource ARN is "${resources[0]}", expected "${expectedArn}"`);
  }

  for (const action of actions) {
    if (/scan/i.test(action)) problems.push(`grants "${action}", which reads across User_Ids`);
    if (action.includes('*')) problems.push(`grants the wildcard action "${action}"`);
    if (!action.startsWith('dynamodb:')) problems.push(`grants "${action}", which is outside DynamoDB`);
  }
  if (actions.length === 0) problems.push('grants no action at all');

  return { resources, actions, problems };
}

function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export function checkIamPolicy(
  policyFile: string = POLICY_ARTIFACT,
  tableFile: string = TABLE_ARTIFACT,
): CheckResult {
  const name = 'IAM policy names exactly the one table and grants no Scan';
  const requirements = '7.5';
  const table = readCommittedTable(tableFile);
  const expectedArn = `arn:aws:dynamodb:${table.region}:*:table/${table.tableName}`;
  const finding = inspectPolicy(readJsonFile(policyFile), expectedArn);
  if (finding.problems.length > 0) {
    return fail(name, requirements, finding.problems.join('; '));
  }
  return pass(
    name,
    requirements,
    `${finding.actions.length} DynamoDB item actions on ${expectedArn}, no Scan`,
  );
}

// ---------------------------------------------------------------------------
// Check: region agreement (Requirements 13.6, 13.3 artifact coherence)
// ---------------------------------------------------------------------------

export interface RegionInputs {
  mealPlanRegion?: string;
  bedrockRegion?: string;
  mealPlanTableName?: string;
  committed: CommittedTable;
}

export function compareRegions(inputs: RegionInputs): CheckResult {
  const name = 'MEAL_PLAN_AWS_REGION equals the Bedrock region';
  const requirements = '13.6';
  const bedrock = inputs.bedrockRegion ?? DEFAULT_BEDROCK_REGION;
  if (!inputs.mealPlanRegion) {
    return skip(
      name,
      requirements,
      'MEAL_PLAN_AWS_REGION is not set in this environment; run with the deployment environment loaded',
    );
  }
  const problems: string[] = [];
  if (inputs.mealPlanRegion !== bedrock) {
    problems.push(
      `MEAL_PLAN_AWS_REGION is "${inputs.mealPlanRegion}" but the Bedrock region is "${bedrock}"${
        inputs.bedrockRegion ? '' : ' (AWS_REGION unset, so the code default applies)'
      }`,
    );
  }
  if (inputs.mealPlanRegion !== inputs.committed.region) {
    problems.push(
      `MEAL_PLAN_AWS_REGION is "${inputs.mealPlanRegion}" but infra/dynamodb-table.json pins "${inputs.committed.region}"`,
    );
  }
  if (inputs.mealPlanTableName && inputs.mealPlanTableName !== inputs.committed.tableName) {
    problems.push(
      `MEAL_PLAN_TABLE_NAME is "${inputs.mealPlanTableName}" but infra/dynamodb-table.json names "${inputs.committed.tableName}"`,
    );
  }
  if (problems.length > 0) return fail(name, requirements, problems.join('; '));
  return pass(name, requirements, `store, inference endpoint, and committed artifacts all in ${bedrock}`);
}

// ---------------------------------------------------------------------------
// Check: no credential reached the client bundle (Requirements 7.5, 13.7)
// ---------------------------------------------------------------------------

/** An AWS access key id, long-term (AKIA) or temporary (ASIA). */
export const ACCESS_KEY_ID_PATTERN = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/;

const SERVER_ONLY_PREFIXES = ['MEAL_PLAN_', 'AWS_BEARER_TOKEN_BEDROCK', 'CRON_SECRET', 'PERSPECTIVE_API_KEY'];

/**
 * A `NEXT_PUBLIC_` prefix is what tells Next.js to inline a value into the
 * browser bundle, so a server-only name carrying that prefix ships the
 * credential to every visitor whether or not this build happened to include it.
 */
export function misprefixedServerVariables(env: Record<string, string | undefined>): string[] {
  return Object.keys(env).filter(
    (key) =>
      key.startsWith('NEXT_PUBLIC_') &&
      SERVER_ONLY_PREFIXES.some((prefix) => key.slice('NEXT_PUBLIC_'.length).startsWith(prefix)),
  );
}

/**
 * The literal values worth grepping for: server-only variables whose value is
 * long enough that a match cannot be coincidence.
 */
export function secretValuesToScan(env: Record<string, string | undefined>): { name: string; value: string }[] {
  return Object.entries(env)
    .filter(([key]) => SERVER_ONLY_PREFIXES.some((prefix) => key.startsWith(prefix)))
    .filter(([, value]) => typeof value === 'string' && value.length >= 12)
    .map(([name, value]) => ({ name, value: value as string }));
}

function* walkFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

export function checkClientBundle(
  bundleDir: string = CLIENT_BUNDLE_DIR,
  env: Record<string, string | undefined> = process.env,
): CheckResult {
  const name = 'No store or inference credential appears in the client bundle';
  const requirements = '7.5, 13.7';

  const misprefixed = misprefixedServerVariables(env);
  if (misprefixed.length > 0) {
    return fail(
      name,
      requirements,
      `these variables carry a NEXT_PUBLIC_ prefix and are therefore inlined into the browser bundle: ${misprefixed.join(', ')}`,
    );
  }

  let exists = false;
  try {
    exists = statSync(bundleDir).isDirectory();
  } catch {
    exists = false;
  }
  if (!exists) {
    return skip(
      name,
      requirements,
      `${path.relative(REPO_ROOT, bundleDir)} not found; run "npm run build" first`,
    );
  }

  const secrets = secretValuesToScan(env);
  const findings: string[] = [];
  let scanned = 0;

  for (const file of walkFiles(bundleDir)) {
    scanned += 1;
    const contents = readFileSync(file, 'latin1');
    const relative = path.relative(REPO_ROOT, file);
    const keyMatch = ACCESS_KEY_ID_PATTERN.exec(contents);
    if (keyMatch) {
      findings.push(`${relative} contains an AWS access key id (${keyMatch[0].slice(0, 4)}…)`);
    }
    for (const secret of secrets) {
      if (contents.includes(secret.value)) {
        findings.push(`${relative} contains the value of ${secret.name}`);
      }
    }
  }

  if (findings.length > 0) return fail(name, requirements, findings.join('; '));
  return pass(
    name,
    requirements,
    `${scanned} bundle files scanned for the access-key-id pattern${
      secrets.length > 0 ? ` and ${secrets.length} server-only value(s) from this environment` : ''
    }`,
  );
}

// ---------------------------------------------------------------------------
// Live AWS state, read through the AWS CLI
// ---------------------------------------------------------------------------

export type AwsOutcome =
  | { ok: true; json: unknown }
  | { ok: false; reason: 'unavailable' | 'error'; message: string };

const READ_ONLY_VERBS = ['describe', 'list', 'get'];

/**
 * Guards the read-only promise structurally: an operation that is not a
 * `describe`, `list`, or `get` never reaches the CLI.
 */
export function assertReadOnly(args: string[]): void {
  const operation = args[1] ?? '';
  if (!READ_ONLY_VERBS.some((verb) => operation.startsWith(`${verb}-`) || operation === verb)) {
    throw new Error(`refusing to run non-read-only AWS operation "${args.join(' ')}"`);
  }
}

/**
 * Distinguishes "cannot look" from "looked and it is wrong". A missing CLI, an
 * absent credential, or an expired session is unavailability and skips; anything
 * else is reported so a real misconfiguration is not swallowed.
 */
export function classifyAwsFailure(message: string): 'unavailable' | 'error' {
  const unavailable = [
    'command not found',
    'ENOENT',
    'Unable to locate credentials',
    'You must specify a region',
    'ExpiredToken',
    'ExpiredTokenException',
    'InvalidClientTokenId',
    'AccessDenied',
    'AccessDeniedException',
    'UnrecognizedClientException',
    'SSO session',
    'sso session',
    'not authorized to perform',
  ];
  return unavailable.some((needle) => message.includes(needle)) ? 'unavailable' : 'error';
}

function awsJson(args: string[]): AwsOutcome {
  assertReadOnly(args);
  try {
    const stdout = execFileSync('aws', [...args, '--output', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    return { ok: true, json: stdout.trim() === '' ? {} : (JSON.parse(stdout) as unknown) };
  } catch (error: unknown) {
    const withOutput = error as { stderr?: string; message?: string; code?: string };
    const message = [withOutput.code, withOutput.stderr, withOutput.message]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join(' ')
      .trim();
    return { ok: false, reason: classifyAwsFailure(message), message: firstLine(message) };
  }
}

function firstLine(text: string): string {
  const line = text.split('\n').map((part) => part.trim()).find((part) => part.length > 0);
  return line ?? 'no output';
}

// ---------------------------------------------------------------------------
// Check: live table configuration (Requirements 13.3, 12.6)
// ---------------------------------------------------------------------------

export interface TableDescription {
  BillingModeSummary?: { BillingMode?: string };
  SSEDescription?: { Status?: string; SSEType?: string };
  ProvisionedThroughput?: { ReadCapacityUnits?: number; WriteCapacityUnits?: number };
}

/**
 * `SSESpecification.Enabled: false` selects the AWS owned key, and DynamoDB then
 * omits `SSEDescription` from DescribeTable entirely. Every DynamoDB table is
 * encrypted at rest unconditionally, so an absent `SSEDescription` is the
 * expected encrypted-at-rest state, not a missing one. A present
 * `SSEDescription` means a KMS key was selected instead, which is also encrypted
 * as long as it is enabled.
 */
export function evaluateTableDescription(table: TableDescription, expectedBillingMode: string): string[] {
  const problems: string[] = [];

  const billingMode =
    table.BillingModeSummary?.BillingMode ??
    // A table created before BillingModeSummary existed reports provisioned
    // throughput instead; either way, non-zero provisioned capacity is a charge.
    (table.ProvisionedThroughput?.ReadCapacityUnits ? 'PROVISIONED' : undefined);
  if (billingMode !== expectedBillingMode) {
    problems.push(`BillingMode is "${billingMode ?? 'unreported'}", expected "${expectedBillingMode}"`);
  }

  const sse = table.SSEDescription;
  if (sse !== undefined) {
    const status = sse.Status ?? 'unreported';
    if (status !== 'ENABLED' && status !== 'UPDATING') {
      problems.push(`SSEDescription.Status is "${status}", so the selected KMS key is not in force`);
    }
  }

  return problems;
}

export function describeSseState(table: TableDescription): string {
  const sse = table.SSEDescription;
  if (sse === undefined) return 'encrypted at rest with the AWS owned key (no SSEDescription, as expected)';
  return `encrypted at rest with ${sse.SSEType ?? 'a KMS key'} (status ${sse.Status ?? 'unreported'})`;
}

export function checkTableConfiguration(committed: CommittedTable, env: Record<string, string | undefined>): CheckResult {
  const name = 'Table billing mode is on-demand and records are encrypted at rest';
  const requirements = '13.3, 12.6';
  const tableName = env.MEAL_PLAN_TABLE_NAME ?? committed.tableName;
  const region = env.MEAL_PLAN_AWS_REGION ?? committed.region;

  const outcome = awsJson(['dynamodb', 'describe-table', '--table-name', tableName, '--region', region]);
  if (!outcome.ok) {
    if (outcome.reason === 'unavailable') {
      return skip(name, requirements, `DescribeTable not attempted: ${outcome.message}`);
    }
    return fail(name, requirements, `DescribeTable failed: ${outcome.message}`);
  }

  const table = ((outcome.json as { Table?: TableDescription }).Table ?? {}) as TableDescription;
  const problems = evaluateTableDescription(table, committed.billingMode);
  if (problems.length > 0) return fail(name, requirements, `${tableName} in ${region}: ${problems.join('; ')}`);
  return pass(
    name,
    requirements,
    `${tableName} in ${region}: ${committed.billingMode}, ${describeSseState(table)}`,
  );
}

// ---------------------------------------------------------------------------
// Check: spend alert (Requirement 13.8)
// ---------------------------------------------------------------------------

interface BudgetNotification {
  NotificationType?: string;
  ComparisonOperator?: string;
  Threshold?: number;
  ThresholdType?: string;
}

interface Budget {
  BudgetName?: string;
  BudgetType?: string;
  BudgetLimit?: { Amount?: string; Unit?: string };
}

export function findSpendBudget(budgets: Budget[], thresholdUsd: number): Budget | undefined {
  return budgets.find(
    (budget) =>
      budget.BudgetType === 'COST' &&
      budget.BudgetLimit?.Unit === 'USD' &&
      Number(budget.BudgetLimit?.Amount) === thresholdUsd,
  );
}

/** The owner contact address is recorded in docs/hosting.md; both alerts use it. */
export function ownerContactAddress(file: string = HOSTING_DOC): string | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const match = /Owner contact address:\s*([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/.exec(text);
  return match?.[1];
}

function confirmedTopicAddresses(topicArn: string): string[] {
  const region = topicArn.split(':')[3] ?? DEFAULT_BEDROCK_REGION;
  const outcome = awsJson(['sns', 'list-subscriptions-by-topic', '--topic-arn', topicArn, '--region', region]);
  if (!outcome.ok) return [];
  const subscriptions = ((outcome.json as { Subscriptions?: unknown[] }).Subscriptions ?? []) as {
    Protocol?: string;
    Endpoint?: string;
    SubscriptionArn?: string;
  }[];
  return subscriptions
    .filter((subscription) => subscription.Protocol === 'email' || subscription.Protocol === 'email-json')
    // An unconfirmed subscription delivers nothing, so the alarm would look
    // configured while being silently inert.
    .filter((subscription) => subscription.SubscriptionArn !== 'PendingConfirmation')
    .map((subscription) => subscription.Endpoint)
    .filter((endpoint): endpoint is string => typeof endpoint === 'string');
}

export function checkSpendAlert(): CheckResult {
  const name = `Spend alert exists at $${SPEND_ALERT_USD.toFixed(2)} with a subscribed contact address`;
  const requirements = '13.8';

  const identity = awsJson(['sts', 'get-caller-identity']);
  if (!identity.ok) {
    if (identity.reason === 'unavailable') {
      return skip(name, requirements, `AWS Budgets not queried: ${identity.message}`);
    }
    return fail(name, requirements, `could not resolve the AWS account: ${identity.message}`);
  }
  const accountId = (identity.json as { Account?: string }).Account;
  if (!accountId) return skip(name, requirements, 'AWS Budgets not queried: no account id in the caller identity');

  // Budgets is a global service with its endpoint in us-east-1.
  const budgetsOutcome = awsJson(['budgets', 'describe-budgets', '--account-id', accountId, '--region', 'us-east-1']);
  if (!budgetsOutcome.ok) {
    if (budgetsOutcome.reason === 'unavailable') {
      return skip(name, requirements, `AWS Budgets not queried: ${budgetsOutcome.message}`);
    }
    return fail(name, requirements, `DescribeBudgets failed: ${budgetsOutcome.message}`);
  }

  const budgets = ((budgetsOutcome.json as { Budgets?: Budget[] }).Budgets ?? []) as Budget[];
  const budget = findSpendBudget(budgets, SPEND_ALERT_USD);
  if (!budget?.BudgetName) {
    const listed =
      budgets
        .map((entry) => `${entry.BudgetName ?? '?'} (${entry.BudgetType ?? '?'} ${entry.BudgetLimit?.Amount ?? '?'} ${entry.BudgetLimit?.Unit ?? ''})`)
        .join(', ') || 'none';
    return fail(
      name,
      requirements,
      `no monthly cost budget at ${SPEND_ALERT_USD.toFixed(2)} USD in account ${accountId}; budgets found: ${listed}`,
    );
  }

  const notificationsOutcome = awsJson([
    'budgets',
    'describe-notifications-for-budget',
    '--account-id',
    accountId,
    '--budget-name',
    budget.BudgetName,
    '--region',
    'us-east-1',
  ]);
  if (!notificationsOutcome.ok) {
    if (notificationsOutcome.reason === 'unavailable') {
      return skip(name, requirements, `budget "${budget.BudgetName}" found, subscribers not readable: ${notificationsOutcome.message}`);
    }
    return fail(name, requirements, `DescribeNotificationsForBudget failed: ${notificationsOutcome.message}`);
  }

  const notifications = ((notificationsOutcome.json as { Notifications?: BudgetNotification[] }).Notifications ??
    []) as BudgetNotification[];
  const actualNotifications = notifications.filter((notification) => notification.NotificationType === 'ACTUAL');
  if (actualNotifications.length === 0) {
    return fail(
      name,
      requirements,
      `budget "${budget.BudgetName}" has no ACTUAL-cost notification, so it alerts on forecast rather than on the threshold being reached`,
    );
  }

  const addresses = new Set<string>();
  for (const notification of actualNotifications) {
    const subscribersOutcome = awsJson([
      'budgets',
      'describe-subscribers-for-notification',
      '--account-id',
      accountId,
      '--budget-name',
      budget.BudgetName,
      '--notification',
      JSON.stringify({
        NotificationType: notification.NotificationType,
        ComparisonOperator: notification.ComparisonOperator,
        Threshold: notification.Threshold,
        ThresholdType: notification.ThresholdType,
      }),
      '--region',
      'us-east-1',
    ]);
    if (!subscribersOutcome.ok) continue;
    const subscribers = ((subscribersOutcome.json as { Subscribers?: unknown[] }).Subscribers ?? []) as {
      SubscriptionType?: string;
      Address?: string;
    }[];
    for (const subscriber of subscribers) {
      if (!subscriber.Address) continue;
      if (subscriber.SubscriptionType === 'EMAIL') {
        addresses.add(subscriber.Address);
      } else if (subscriber.SubscriptionType === 'SNS') {
        for (const address of confirmedTopicAddresses(subscriber.Address)) addresses.add(address);
      }
    }
  }

  if (addresses.size === 0) {
    return fail(
      name,
      requirements,
      `budget "${budget.BudgetName}" reaches no confirmed contact address; an unconfirmed SNS email subscription delivers nothing`,
    );
  }

  const owner = ownerContactAddress();
  if (owner && !addresses.has(owner)) {
    return fail(
      name,
      requirements,
      `budget "${budget.BudgetName}" notifies ${[...addresses].join(', ')}, not the owner address ${owner} recorded in docs/hosting.md`,
    );
  }
  return pass(name, requirements, `budget "${budget.BudgetName}" notifies ${[...addresses].join(', ')}`);
}

// ---------------------------------------------------------------------------
// Check: TLS certificate (Requirement 13.4) and HTTPS delivery (12.7)
// ---------------------------------------------------------------------------

export function resolveTargetHost(
  argv: string[],
  env: Record<string, string | undefined>,
): string | undefined {
  const flag = argv.find((arg) => arg.startsWith('--url='))?.slice('--url='.length);
  const candidate =
    flag ??
    env.VERIFY_DEPLOYMENT_URL ??
    env.DEPLOYMENT_URL ??
    env.VERCEL_PROJECT_PRODUCTION_URL ??
    env.NEXT_PUBLIC_SITE_URL;
  if (!candidate || candidate.trim() === '') return undefined;
  const withScheme = /^https?:\/\//.test(candidate) ? candidate : `https://${candidate}`;
  try {
    return new URL(withScheme).hostname;
  } catch {
    return undefined;
  }
}

export interface CertificateFacts {
  issuer: string;
  validFrom: Date;
  validTo: Date;
}

/** A distinguished-name field is either a single value or, when repeated, a list. */
function issuerName(certificate: PeerCertificate): string {
  const field = certificate.issuer?.O ?? certificate.issuer?.CN;
  if (field === undefined) return 'unknown';
  return Array.isArray(field) ? field.join(', ') : field;
}

export function readCertificate(host: string, timeoutMs = 10_000): Promise<CertificateFacts> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port: 443, servername: host }, () => {
      const certificate = socket.getPeerCertificate() as PeerCertificate;
      socket.end();
      if (!certificate || !certificate.valid_to) {
        reject(new Error('the endpoint presented no certificate'));
        return;
      }
      resolve({
        issuer: issuerName(certificate),
        validFrom: new Date(certificate.valid_from),
        validTo: new Date(certificate.valid_to),
      });
    });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`no TLS handshake within ${timeoutMs} ms`));
    });
    socket.on('error', reject);
  });
}

export function evaluateCertificate(
  facts: CertificateFacts,
  now: Date = new Date(),
  marginDays: number = TLS_RENEWAL_MARGIN_DAYS,
): { problems: string[]; daysRemaining: number; lifetimeDays: number } {
  const dayMs = 86_400_000;
  const daysRemaining = (facts.validTo.getTime() - now.getTime()) / dayMs;
  const lifetimeDays = (facts.validTo.getTime() - facts.validFrom.getTime()) / dayMs;
  const problems: string[] = [];
  if (!(daysRemaining > marginDays)) {
    problems.push(
      `notAfter is ${daysRemaining.toFixed(1)} days out, inside the ${marginDays}-day renewal margin`,
    );
  }
  if (!PLATFORM_MANAGED_ISSUERS.some((issuer) => facts.issuer.includes(issuer))) {
    problems.push(
      `issuer "${facts.issuer}" is not a platform-managed CA, so nothing renews this certificate automatically`,
    );
  }
  return { problems, daysRemaining, lifetimeDays };
}

export async function checkTlsCertificate(host: string | undefined): Promise<CheckResult> {
  const name = 'TLS certificate is platform-managed and not near expiry';
  const requirements = '13.4';
  if (!host) {
    return skip(name, requirements, 'no target URL; pass --url=https://your-domain or set VERIFY_DEPLOYMENT_URL');
  }
  let facts: CertificateFacts;
  try {
    facts = await readCertificate(host);
  } catch (error: unknown) {
    return fail(name, requirements, `${host}: ${(error as Error).message}`);
  }
  const evaluation = evaluateCertificate(facts);
  if (evaluation.problems.length > 0) return fail(name, requirements, `${host}: ${evaluation.problems.join('; ')}`);
  return pass(
    name,
    requirements,
    `${host}: issued by ${facts.issuer}, ${evaluation.lifetimeDays.toFixed(0)}-day lifetime, ${evaluation.daysRemaining.toFixed(0)} days remaining`,
  );
}

export async function checkHttpsDelivery(host: string | undefined): Promise<CheckResult> {
  const name = 'Site is served over HTTPS with HSTS';
  const requirements = '12.7';
  if (!host) {
    return skip(name, requirements, 'no target URL; pass --url=https://your-domain or set VERIFY_DEPLOYMENT_URL');
  }
  let response: Response;
  try {
    response = await fetch(`https://${host}/`, {
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error: unknown) {
    return fail(name, requirements, `https://${host}/ was not reachable: ${(error as Error).message}`);
  }
  if (response.status >= 500) {
    return fail(name, requirements, `https://${host}/ responded ${response.status}`);
  }
  const hsts = response.headers.get('strict-transport-security');
  if (!hsts) {
    return fail(name, requirements, `https://${host}/ responded ${response.status} without a Strict-Transport-Security header`);
  }
  return pass(name, requirements, `https://${host}/ responded ${response.status} with Strict-Transport-Security: ${hsts}`);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const USAGE = `Usage: npm run verify:deployment -- [--url=https://your-domain]

Read-only deployment smoke checks. Checks needing live AWS state or a deployed
endpoint skip with a reason when credentials or a URL are absent.

  --url=<url>   the deployed site to check the TLS certificate of. Also read
                from VERIFY_DEPLOYMENT_URL, DEPLOYMENT_URL,
                VERCEL_PROJECT_PRODUCTION_URL, or NEXT_PUBLIC_SITE_URL.
  --help        print this message`;

const ICON: Record<CheckStatus, string> = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP' };

export function formatResult(result: CheckResult): string {
  return `${ICON[result.status]}  ${result.name} (Req ${result.requirements})\n      ${result.detail}`;
}

export async function runChecks(
  argv: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): Promise<CheckResult[]> {
  const committed = readCommittedTable();
  const host = resolveTargetHost(argv, env);

  return [
    checkCronFrequency(),
    checkIamPolicy(),
    compareRegions({
      mealPlanRegion: env.MEAL_PLAN_AWS_REGION,
      bedrockRegion: env.AWS_REGION,
      mealPlanTableName: env.MEAL_PLAN_TABLE_NAME,
      committed,
    }),
    checkClientBundle(CLIENT_BUNDLE_DIR, env),
    checkTableConfiguration(committed, env),
    checkSpendAlert(),
    await checkTlsCertificate(host),
    await checkHttpsDelivery(host),
  ];
}

export async function main(
  argv: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  process.stdout.write('Deployment smoke checks — read-only\n\n');
  const results = await runChecks(argv, env);
  for (const result of results) process.stdout.write(`${formatResult(result)}\n\n`);

  const counts = {
    pass: results.filter((result) => result.status === 'pass').length,
    fail: results.filter((result) => result.status === 'fail').length,
    skip: results.filter((result) => result.status === 'skip').length,
  };
  process.stdout.write(`${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped\n`);
  if (counts.fail > 0) {
    process.stdout.write('\nA failed check means a step in infra/README.md was missed or has drifted.\n');
    return 1;
  }
  if (counts.skip > 0) {
    process.stdout.write('\nSkipped checks need AWS credentials or --url to run; they were not verified.\n');
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`verify-deployment failed: ${(error as Error).message}\n`);
      process.exitCode = 1;
    });
}
