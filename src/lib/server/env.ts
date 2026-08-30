/**
 * Startup credential validation (Requirements 13.7, 13.11).
 *
 * Every server route calls `assertServerEnv` at module scope so a missing
 * credential fails evaluation at startup rather than mid-request. There is no
 * fallback value, no placeholder, and no default for any variable: a group with
 * at least one absent variable throws, and the error names every such group.
 */

export type CredentialGroup = 'AUTH_SERVICE' | 'AI_INFERENCE' | 'MEAL_PLAN_STORE';

/**
 * The variables each credential group requires. Exported so tests can reason
 * about the exact variable set without duplicating it.
 */
export const REQUIRED: Record<CredentialGroup, string[]> = {
  AUTH_SERVICE: [
    'COGNITO_AWS_REGION',
    'COGNITO_USER_POOL_ID',
    'COGNITO_CLIENT_ID',
    'COGNITO_DOMAIN',
    'AUTH_ALLOWED_ORIGINS',
  ],
  // Bedrock accepts either AWS_BEARER_TOKEN_BEDROCK or credentials supplied by
  // the hosting platform's execution role. No static secret is mandatory.
  AI_INFERENCE:    [],
  // The table identity is always required. Static credentials are optional
  // because AWS-hosted compute should use its execution role.
  MEAL_PLAN_STORE: ['MEAL_PLAN_TABLE_NAME', 'MEAL_PLAN_AWS_REGION'],
};

const MEAL_PLAN_ACCESS_KEY = 'MEAL_PLAN_AWS_ACCESS_KEY_ID';
const MEAL_PLAN_SECRET_KEY = 'MEAL_PLAN_AWS_SECRET_ACCESS_KEY';

/**
 * Keep these as direct property reads. The production Next.js server build
 * replaces them with server-only values because Amplify Hosting does not expose
 * app environment variables to the SSR process at request time.
 */
function serverEnvValue(name: string): string | undefined {
  switch (name) {
    case 'AUTH_ALLOWED_ORIGINS':
      return process.env.AUTH_ALLOWED_ORIGINS;
    case 'COGNITO_AWS_REGION':
      return process.env.COGNITO_AWS_REGION;
    case 'COGNITO_CLIENT_ID':
      return process.env.COGNITO_CLIENT_ID;
    case 'COGNITO_DOMAIN':
      return process.env.COGNITO_DOMAIN;
    case 'COGNITO_USER_POOL_ID':
      return process.env.COGNITO_USER_POOL_ID;
    case 'MEAL_PLAN_AWS_ACCESS_KEY_ID':
      return process.env.MEAL_PLAN_AWS_ACCESS_KEY_ID;
    case 'MEAL_PLAN_AWS_REGION':
      return process.env.MEAL_PLAN_AWS_REGION;
    case 'MEAL_PLAN_AWS_SECRET_ACCESS_KEY':
      return process.env.MEAL_PLAN_AWS_SECRET_ACCESS_KEY;
    case 'MEAL_PLAN_TABLE_NAME':
      return process.env.MEAL_PLAN_TABLE_NAME;
    default:
      return process.env[name];
  }
}

/**
 * A variable is absent when it is unset or holds the empty string. An
 * empty-string value is never treated as a supplied credential.
 */
function isAbsent(name: string): boolean {
  const value = serverEnvValue(name);
  return value === undefined || value === '';
}

/**
 * Returns the variables of `group` that are absent, in declaration order.
 */
export function missingVariables(group: CredentialGroup): string[] {
  const missing = REQUIRED[group].filter(isAbsent);

  if (group === 'MEAL_PLAN_STORE') {
    const accessKeyMissing = isAbsent(MEAL_PLAN_ACCESS_KEY);
    const secretKeyMissing = isAbsent(MEAL_PLAN_SECRET_KEY);

    // Explicit credentials are accepted only as a complete pair. When both are
    // absent the AWS SDK resolves the Amplify/Lambda execution role.
    if (accessKeyMissing !== secretKeyMissing) {
      missing.push(accessKeyMissing ? MEAL_PLAN_ACCESS_KEY : MEAL_PLAN_SECRET_KEY);
    }
  }

  return missing;
}

/**
 * Returns every requested group that has at least one absent variable, in the
 * order the groups were requested, without repeats.
 */
export function missingCredentialGroups(groups: CredentialGroup[]): CredentialGroup[] {
  const seen = new Set<CredentialGroup>();
  const missing: CredentialGroup[] = [];
  for (const group of groups) {
    if (seen.has(group)) continue;
    seen.add(group);
    if (missingVariables(group).length > 0) missing.push(group);
  }
  return missing;
}

/**
 * Throws if and only if at least one variable required by one of `groups` is
 * absent. The thrown error names every credential group with a missing
 * variable, along with the names of the absent variables. No value is
 * substituted for an absent variable.
 */
export function assertServerEnv(groups: CredentialGroup[]): void {
  const missing = missingCredentialGroups(groups);
  if (missing.length === 0) return;

  const detail = missing
    .map((group) => `${group} (missing: ${missingVariables(group).join(', ')})`)
    .join('; ');

  throw new Error(
    `Missing required environment configuration for credential group${missing.length > 1 ? 's' : ''}: ${detail}. ` +
      'Supply these values through the platform-managed environment configuration; no default or placeholder is substituted.',
  );
}
