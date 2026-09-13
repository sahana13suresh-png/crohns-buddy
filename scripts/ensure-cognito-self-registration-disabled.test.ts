import {
  CognitoIdentityProviderClient,
  DescribeUserPoolCommand,
  UpdateUserPoolCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildDisableSelfRegistrationInput,
  ensureCognitoSelfRegistrationDisabled,
} from './ensure-cognito-self-registration-disabled.mjs';

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

describe('Cognito self-registration deployment guard', () => {
  beforeEach(() => {
    cognitoMock.reset();
  });

  it('preserves mutable security settings without attempting to update system tags', () => {
    const input = buildDisableSelfRegistrationInput(userPool);

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
        AllowAdminCreateUserOnly: true,
        UnusedAccountValidityDays: 7,
      },
    });
    expect(input).not.toHaveProperty('UserPoolTags');
  });

  it('updates and verifies a pool when self-registration is enabled', async () => {
    const selfRegistrationEnabledPool = {
      ...userPool,
      AdminCreateUserConfig: {
        ...userPool.AdminCreateUserConfig,
        AllowAdminCreateUserOnly: false,
      },
    };
    cognitoMock
      .on(DescribeUserPoolCommand)
      .resolvesOnce({ UserPool: selfRegistrationEnabledPool })
      .resolvesOnce({
        UserPool: {
          ...userPool,
          AdminCreateUserConfig: {
            ...userPool.AdminCreateUserConfig,
            AllowAdminCreateUserOnly: true,
          },
        },
      });
    cognitoMock.on(UpdateUserPoolCommand).resolves({});

    await expect(
      ensureCognitoSelfRegistrationDisabled({
        userPoolId: userPool.Id,
        client: new CognitoIdentityProviderClient({}),
      }),
    ).resolves.toEqual({
      changed: true,
      userPoolId: userPool.Id,
    });

    expect(cognitoMock.commandCalls(UpdateUserPoolCommand)).toHaveLength(1);
  });

  it('only verifies a pool when self-registration is already disabled', async () => {
    cognitoMock.on(DescribeUserPoolCommand).resolves({ UserPool: userPool });

    await expect(
      ensureCognitoSelfRegistrationDisabled({
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
