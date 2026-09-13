import {
  CognitoIdentityProviderClient,
  DescribeUserPoolCommand,
  UpdateUserPoolCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const UPDATABLE_PROPERTIES = [
  'Policies',
  'DeletionProtection',
  'LambdaConfig',
  'AutoVerifiedAttributes',
  'SmsVerificationMessage',
  'EmailVerificationMessage',
  'EmailVerificationSubject',
  'VerificationMessageTemplate',
  'SmsAuthenticationMessage',
  'UserAttributeUpdateSettings',
  'MfaConfiguration',
  'DeviceConfiguration',
  'EmailConfiguration',
  'SmsConfiguration',
  'UserPoolAddOns',
  'AccountRecoverySetting',
  'UserPoolTier',
];

export function buildDisableSelfRegistrationInput(userPool) {
  if (!userPool?.Id || !userPool.Name) {
    throw new Error('Cognito returned an incomplete user-pool description.');
  }

  const input = {
    UserPoolId: userPool.Id,
    PoolName: userPool.Name,
    AdminCreateUserConfig: {
      ...userPool.AdminCreateUserConfig,
      AllowAdminCreateUserOnly: true,
    },
  };

  for (const property of UPDATABLE_PROPERTIES) {
    if (userPool[property] !== undefined) {
      input[property] = userPool[property];
    }
  }

  // DescribeUserPool includes CloudFormation-owned aws:* tags. Passing those
  // back to UpdateUserPool fails because system tags are immutable, so tags
  // intentionally remain untouched by this preservation update.
  return input;
}

export async function ensureCognitoSelfRegistrationDisabled({
  userPoolId,
  region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
  client = new CognitoIdentityProviderClient({ region }),
}) {
  if (!userPoolId) {
    throw new Error('A Cognito user pool ID is required.');
  }

  const current = await client.send(
    new DescribeUserPoolCommand({ UserPoolId: userPoolId }),
  );

  if (!current.UserPool) {
    throw new Error(`Cognito user pool ${userPoolId} was not found.`);
  }

  if (
    current.UserPool.AdminCreateUserConfig?.AllowAdminCreateUserOnly !== true
  ) {
    await client.send(
      new UpdateUserPoolCommand(
        buildDisableSelfRegistrationInput(current.UserPool),
      ),
    );
  }

  const verified = await client.send(
    new DescribeUserPoolCommand({ UserPoolId: userPoolId }),
  );

  if (
    !verified.UserPool ||
    verified.UserPool.AdminCreateUserConfig?.AllowAdminCreateUserOnly !== true
  ) {
    throw new Error(
      `Cognito self-registration is not disabled for ${userPoolId}.`,
    );
  }

  return {
    changed:
      current.UserPool.AdminCreateUserConfig?.AllowAdminCreateUserOnly !== true,
    userPoolId,
  };
}

async function main() {
  const [userPoolId] = process.argv.slice(2);
  const result = await ensureCognitoSelfRegistrationDisabled({ userPoolId });
  console.log(
    result.changed
      ? `Disabled Cognito self-registration for ${result.userPoolId}.`
      : `Verified Cognito self-registration is disabled for ${result.userPoolId}.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
