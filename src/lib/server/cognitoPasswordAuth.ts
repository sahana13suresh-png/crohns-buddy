import {
  ConfirmForgotPasswordCommand,
  ConfirmSignUpCommand,
  ForgotPasswordCommand,
  InitiateAuthCommand,
  ResendConfirmationCodeCommand,
  RespondToAuthChallengeCommand,
  SignUpCommand,
  type AuthenticationResultType,
  type ChallengeNameType,
} from '@aws-sdk/client-cognito-identity-provider';

import {
  cognitoClientForRegion,
  readCognitoConfig,
  type CognitoTokenSet,
} from './cognitoAuth';

export const EMAIL_MAX_LENGTH = 254;
export const DISPLAY_NAME_MAX_LENGTH = 50;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;
export const CONFIRMATION_CODE_LENGTH = 6;

export type PasswordAuthErrorCode =
  | 'invalid-input'
  | 'email-in-use'
  | 'weak-password'
  | 'invalid-credentials'
  | 'too-many-requests'
  | 'invalid-code'
  | 'expired-code'
  | 'unverified-email'
  | 'password-reset-required'
  | 'unavailable';

export class PasswordAuthError extends Error {
  constructor(
    readonly code: PasswordAuthErrorCode,
    readonly status: number,
  ) {
    super(code);
    this.name = 'PasswordAuthError';
  }
}

export interface AuthChallenge {
  challengeName: 'SOFTWARE_TOKEN_MFA' | 'SMS_MFA';
  session: string;
  username: string;
}

export type PasswordSignInResult =
  | { step: 'done'; tokens: CognitoTokenSet }
  | { step: 'mfa'; challenge: AuthChallenge };

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function requireEmail(value: unknown): string {
  if (typeof value !== 'string') throw new PasswordAuthError('invalid-input', 400);
  const email = normalizeEmail(value);
  if (
    email.length === 0 ||
    email.length > EMAIL_MAX_LENGTH ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new PasswordAuthError('invalid-input', 400);
  }
  return email;
}

function requireDisplayName(value: unknown): string {
  if (typeof value !== 'string') throw new PasswordAuthError('invalid-input', 400);
  const displayName = Array.from(value.trim())
    .slice(0, DISPLAY_NAME_MAX_LENGTH + 1)
    .join('');
  if (displayName.length === 0 || Array.from(displayName).length > DISPLAY_NAME_MAX_LENGTH) {
    throw new PasswordAuthError('invalid-input', 400);
  }
  return displayName;
}

function requirePassword(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < PASSWORD_MIN_LENGTH ||
    value.length > PASSWORD_MAX_LENGTH ||
    !/[a-z]/.test(value) ||
    !/[A-Z]/.test(value) ||
    !/\d/.test(value) ||
    !/[^A-Za-z0-9]/.test(value)
  ) {
    throw new PasswordAuthError('weak-password', 400);
  }
  return value;
}

function requireCode(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !new RegExp(`^\\d{${CONFIRMATION_CODE_LENGTH}}$`).test(value.trim())
  ) {
    throw new PasswordAuthError('invalid-code', 400);
  }
  return value.trim();
}

function tokensFromAuthenticationResult(
  result: AuthenticationResultType | undefined,
): CognitoTokenSet | null {
  if (!result?.IdToken || !result.AccessToken || typeof result.ExpiresIn !== 'number') {
    return null;
  }
  return {
    idToken: result.IdToken,
    accessToken: result.AccessToken,
    refreshToken: result.RefreshToken,
    expiresIn: result.ExpiresIn,
  };
}

function toPasswordAuthError(error: unknown): PasswordAuthError {
  if (error instanceof PasswordAuthError) return error;
  const name = error instanceof Error ? error.name : '';
  switch (name) {
    case 'UsernameExistsException':
    case 'AliasExistsException':
      return new PasswordAuthError('email-in-use', 409);
    case 'InvalidPasswordException':
    case 'PasswordHistoryPolicyViolationException':
      return new PasswordAuthError('weak-password', 400);
    case 'NotAuthorizedException':
    case 'UserNotFoundException':
      return new PasswordAuthError('invalid-credentials', 401);
    case 'UserNotConfirmedException':
      return new PasswordAuthError('unverified-email', 403);
    case 'PasswordResetRequiredException':
      return new PasswordAuthError('password-reset-required', 403);
    case 'CodeMismatchException':
      return new PasswordAuthError('invalid-code', 400);
    case 'ExpiredCodeException':
      return new PasswordAuthError('expired-code', 400);
    case 'TooManyRequestsException':
    case 'LimitExceededException':
    case 'ForbiddenException':
      return new PasswordAuthError('too-many-requests', 429);
    case 'InvalidParameterException':
    case 'UserLambdaValidationException':
      return new PasswordAuthError('invalid-input', 400);
    default:
      return new PasswordAuthError('unavailable', 503);
  }
}

function supportedMfaChallenge(
  challengeName: ChallengeNameType | undefined,
): challengeName is AuthChallenge['challengeName'] {
  return challengeName === 'SOFTWARE_TOKEN_MFA' || challengeName === 'SMS_MFA';
}

export async function signUpWithPassword(input: {
  email: unknown;
  password: unknown;
  displayName: unknown;
}): Promise<{ step: 'confirm-signup' | 'sign-in' }> {
  const email = requireEmail(input.email);
  const password = requirePassword(input.password);
  const displayName = requireDisplayName(input.displayName);
  const config = readCognitoConfig();

  try {
    const result = await cognitoClientForRegion(config.region).send(
      new SignUpCommand({
        ClientId: config.clientId,
        Username: email,
        Password: password,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'name', Value: displayName },
        ],
      }),
    );
    return { step: result.UserConfirmed ? 'sign-in' : 'confirm-signup' };
  } catch (error: unknown) {
    throw toPasswordAuthError(error);
  }
}

export async function confirmPasswordSignUp(input: {
  email: unknown;
  code: unknown;
}): Promise<void> {
  const email = requireEmail(input.email);
  const code = requireCode(input.code);
  const config = readCognitoConfig();
  try {
    await cognitoClientForRegion(config.region).send(
      new ConfirmSignUpCommand({
        ClientId: config.clientId,
        Username: email,
        ConfirmationCode: code,
      }),
    );
  } catch (error: unknown) {
    throw toPasswordAuthError(error);
  }
}

export async function resendPasswordSignUpCode(emailValue: unknown): Promise<void> {
  const email = requireEmail(emailValue);
  const config = readCognitoConfig();
  try {
    await cognitoClientForRegion(config.region).send(
      new ResendConfirmationCodeCommand({
        ClientId: config.clientId,
        Username: email,
      }),
    );
  } catch (error: unknown) {
    throw toPasswordAuthError(error);
  }
}

export async function signInWithPassword(input: {
  email: unknown;
  password: unknown;
}): Promise<PasswordSignInResult> {
  const email = requireEmail(input.email);
  const password = requirePassword(input.password);
  const config = readCognitoConfig();
  try {
    const result = await cognitoClientForRegion(config.region).send(
      new InitiateAuthCommand({
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: config.clientId,
        AuthParameters: {
          USERNAME: email,
          PASSWORD: password,
        },
      }),
    );
    const tokens = tokensFromAuthenticationResult(result.AuthenticationResult);
    if (tokens) return { step: 'done', tokens };
    if (supportedMfaChallenge(result.ChallengeName) && result.Session) {
      return {
        step: 'mfa',
        challenge: {
          challengeName: result.ChallengeName,
          session: result.Session,
          username: email,
        },
      };
    }
    throw new PasswordAuthError('unavailable', 503);
  } catch (error: unknown) {
    throw toPasswordAuthError(error);
  }
}

export async function completePasswordMfa(
  challenge: AuthChallenge,
  codeValue: unknown,
): Promise<CognitoTokenSet> {
  const code = requireCode(codeValue);
  const config = readCognitoConfig();
  const responseKey =
    challenge.challengeName === 'SOFTWARE_TOKEN_MFA'
      ? 'SOFTWARE_TOKEN_MFA_CODE'
      : 'SMS_MFA_CODE';
  try {
    const result = await cognitoClientForRegion(config.region).send(
      new RespondToAuthChallengeCommand({
        ChallengeName: challenge.challengeName,
        ClientId: config.clientId,
        Session: challenge.session,
        ChallengeResponses: {
          USERNAME: challenge.username,
          [responseKey]: code,
        },
      }),
    );
    const tokens = tokensFromAuthenticationResult(result.AuthenticationResult);
    if (!tokens) throw new PasswordAuthError('invalid-code', 400);
    return tokens;
  } catch (error: unknown) {
    throw toPasswordAuthError(error);
  }
}

export async function beginPasswordReset(emailValue: unknown): Promise<void> {
  const email = requireEmail(emailValue);
  const config = readCognitoConfig();
  try {
    await cognitoClientForRegion(config.region).send(
      new ForgotPasswordCommand({
        ClientId: config.clientId,
        Username: email,
      }),
    );
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'UserNotFoundException') return;
    throw toPasswordAuthError(error);
  }
}

export async function completePasswordReset(input: {
  email: unknown;
  code: unknown;
  password: unknown;
}): Promise<void> {
  const email = requireEmail(input.email);
  const code = requireCode(input.code);
  const password = requirePassword(input.password);
  const config = readCognitoConfig();
  try {
    await cognitoClientForRegion(config.region).send(
      new ConfirmForgotPasswordCommand({
        ClientId: config.clientId,
        Username: email,
        ConfirmationCode: code,
        Password: password,
      }),
    );
  } catch (error: unknown) {
    throw toPasswordAuthError(error);
  }
}
