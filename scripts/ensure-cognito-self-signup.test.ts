import {
  CognitoIdentityProviderClient,
  DescribeUserPoolCommand,
  UpdateUserPoolCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildSelfSignupUpdateInput,
  ensureCognitoSelfSignup,
} from './ensure-cognito-self-signup.mjs';

const cognitoMock = mockClient(CognitoIdentityProviderClient);

const userPool = {
  Id: 'us-east-1_example',
  Name: 'crohns-buddy',
  Policies: {
    PasswordPolicy: {
      MinimumLength: 12,
      RequireLowercase: true,
      RequireNumbers: true,
      RequireSymbols: true,
      RequireUppercase: true,
    },
  },
  DeletionProtection: 'ACTIVE' as const,
  LambdaConfig: {},
  AutoVerifiedAttributes: ['email' as const],
  MfaConfiguration: 'OPTIONAL' as const,
  EmailConfiguration: {
    EmailSendingAccount: 'COGNITO_DEFAULT' as const,
  },
  UserPoolTags: {
    application: 'crohns-buddy',
    'aws:cloudformation:stack-name': 'crohns-buddy-prod',
  },
  AdminCreateUserConfig: {
    AllowAdminCreateUserOnly: true,
    UnusedAccountValidityDays: 7,
  },
};

describe('Cognito self-service signup deployment guard', () => {
  beforeEach(() => {
    cognitoMock.reset();
  });

  it('preserves mutable security settings without attempting to update system tags', () => {
    const input = buildSelfSignupUpdateInput(userPool);

    expect(input).toMatchObject({
      UserPoolId: 'us-east-1_example',
      PoolName: 'crohns-buddy',
      Policies: userPool.Policies,
      DeletionProtection: 'ACTIVE',
      LambdaConfig: {},
      AutoVerifiedAttributes: ['email'],
      MfaConfiguration: 'OPTIONAL',
      EmailConfiguration: userPool.EmailConfiguration,
      AdminCreateUserConfig: {
        AllowAdminCreateUserOnly: false,
        UnusedAccountValidityDays: 7,
      },
    });
    expect(input).not.toHaveProperty('UserPoolTags');
  });

  it('updates and verifies a pool when signup is blocked', async () => {
    cognitoMock
      .on(DescribeUserPoolCommand)
      .resolvesOnce({ UserPool: userPool })
      .resolvesOnce({
        UserPool: {
          ...userPool,
          AdminCreateUserConfig: {
            ...userPool.AdminCreateUserConfig,
            AllowAdminCreateUserOnly: false,
          },
        },
      });
    cognitoMock.on(UpdateUserPoolCommand).resolves({});

    await expect(
      ensureCognitoSelfSignup({
        userPoolId: userPool.Id,
        client: new CognitoIdentityProviderClient({}),
      }),
    ).resolves.toEqual({
      changed: true,
      userPoolId: userPool.Id,
    });

    expect(cognitoMock.commandCalls(UpdateUserPoolCommand)).toHaveLength(1);
  });

  it('only verifies a pool when signup is already enabled', async () => {
    const enabledPool = {
      ...userPool,
      AdminCreateUserConfig: {
        ...userPool.AdminCreateUserConfig,
        AllowAdminCreateUserOnly: false,
      },
    };
    cognitoMock.on(DescribeUserPoolCommand).resolves({ UserPool: enabledPool });

    await expect(
      ensureCognitoSelfSignup({
        userPoolId: userPool.Id,
        client: new CognitoIdentityProviderClient({}),
      }),
    ).resolves.toEqual({
      changed: false,
      userPoolId: userPool.Id,
    });

    expect(cognitoMock.commandCalls(UpdateUserPoolCommand)).toHaveLength(0);
  });
});
