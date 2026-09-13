import {
  CognitoIdentityProviderClient,
  ConfirmForgotPasswordCommand,
  ConfirmSignUpCommand,
  ForgotPasswordCommand,
  InitiateAuthCommand,
  ResendConfirmationCodeCommand,
  RespondToAuthChallengeCommand,
  SignUpCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetCognitoAuthCaches } from './cognitoAuth';
import {
  beginPasswordReset,
  completePasswordMfa,
  completePasswordReset,
  confirmPasswordSignUp,
  PasswordAuthError,
  resendPasswordSignUpCode,
  signInWithPassword,
  signUpWithPassword,
} from './cognitoPasswordAuth';

const cognitoMock = mockClient(CognitoIdentityProviderClient);
const strongPassword = 'Strong!Password1';

describe('native account operations', () => {
  beforeEach(() => {
    resetCognitoAuthCaches();
    cognitoMock.reset();
  });

  it('creates an account with normalized email and display-name attributes', async () => {
    cognitoMock.on(SignUpCommand).resolves({ UserConfirmed: false });

    await expect(
      signUpWithPassword({
        email: ' Patient@Example.COM ',
        password: strongPassword,
        displayName: ' Avery ',
      }),
    ).resolves.toEqual({ step: 'confirm-signup' });

    expect(cognitoMock.commandCalls(SignUpCommand)[0]?.args[0].input).toEqual({
      ClientId: 'test-client',
      Username: 'patient@example.com',
      Password: strongPassword,
      UserAttributes: [
        { Name: 'email', Value: 'patient@example.com' },
        { Name: 'name', Value: 'Avery' },
      ],
    });
  });

  it('rejects a weak password before making a remote request', async () => {
    await expect(
      signUpWithPassword({
        email: 'patient@example.com',
        password: 'too-short',
        displayName: 'Avery',
      }),
    ).rejects.toMatchObject({
      code: 'weak-password',
      status: 400,
    });

    expect(cognitoMock.commandCalls(SignUpCommand)).toHaveLength(0);
  });

  it('returns tokens after successful password authentication', async () => {
    cognitoMock.on(InitiateAuthCommand).resolves({
      AuthenticationResult: {
        IdToken: 'id-token',
        AccessToken: 'access-token',
        RefreshToken: 'refresh-token',
        ExpiresIn: 3600,
      },
    });

    await expect(
      signInWithPassword({
        email: 'patient@example.com',
        password: strongPassword,
      }),
    ).resolves.toEqual({
      step: 'done',
      tokens: {
        idToken: 'id-token',
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresIn: 3600,
      },
    });
  });

  it('keeps an MFA challenge server-side until the verification code arrives', async () => {
    cognitoMock.on(InitiateAuthCommand).resolves({
      ChallengeName: 'SOFTWARE_TOKEN_MFA',
      Session: 'opaque-session',
    });
    cognitoMock.on(RespondToAuthChallengeCommand).resolves({
      AuthenticationResult: {
        IdToken: 'id-token',
        AccessToken: 'access-token',
        RefreshToken: 'refresh-token',
        ExpiresIn: 3600,
      },
    });

    const result = await signInWithPassword({
      email: 'patient@example.com',
      password: strongPassword,
    });
    expect(result).toEqual({
      step: 'mfa',
      challenge: {
        challengeName: 'SOFTWARE_TOKEN_MFA',
        session: 'opaque-session',
        username: 'patient@example.com',
      },
    });
    if (result.step !== 'mfa') throw new Error('Expected an MFA challenge.');

    await expect(
      completePasswordMfa(result.challenge, '123456'),
    ).resolves.toMatchObject({
      idToken: 'id-token',
      accessToken: 'access-token',
    });
  });

  it('maps credential rejection to one generic error', async () => {
    cognitoMock.on(InitiateAuthCommand).rejects(
      Object.assign(new Error('Incorrect username or password.'), {
        name: 'NotAuthorizedException',
      }),
    );

    await expect(
      signInWithPassword({
        email: 'patient@example.com',
        password: strongPassword,
      }),
    ).rejects.toMatchObject({
      code: 'invalid-credentials',
      status: 401,
    });
  });

  it('supports confirmation, resend, and password recovery commands', async () => {
    cognitoMock.on(ConfirmSignUpCommand).resolves({});
    cognitoMock.on(ResendConfirmationCodeCommand).resolves({});
    cognitoMock.on(ForgotPasswordCommand).resolves({});
    cognitoMock.on(ConfirmForgotPasswordCommand).resolves({});

    await expect(
      confirmPasswordSignUp({
        email: 'patient@example.com',
        code: '123456',
      }),
    ).resolves.toBeUndefined();
    await expect(
      resendPasswordSignUpCode('patient@example.com'),
    ).resolves.toBeUndefined();
    await expect(
      beginPasswordReset('patient@example.com'),
    ).resolves.toBeUndefined();
    await expect(
      completePasswordReset({
        email: 'patient@example.com',
        code: '123456',
        password: strongPassword,
      }),
    ).resolves.toBeUndefined();
  });
});
