# AWS infrastructure

Crohn's Buddy is deployed to AWS account `853513360253` in `us-east-1`.

The deployment is defined by [`aws/template.yaml`](aws/template.yaml) and executed by
[`../scripts/deploy-aws.sh`](../scripts/deploy-aws.sh). The script refreshes the
`crohns-buddy-deploy` AWS CLI profile through ADA, verifies the target account, creates a
clean source snapshot, pushes it to a dedicated CodeCommit repository, provisions the
stack, and waits for the Amplify production build.

## Resources

The CloudFormation stack creates:

- an AWS CodeCommit deployment repository;
- an AWS Amplify Hosting `WEB_COMPUTE` app and production branch;
- an Amazon Cognito user pool and app client for native email accounts, plus an
  OAuth authorization-code flow with PKCE for optional social providers;
- a DynamoDB on-demand table with deletion protection;
- a least-privilege Amplify SSR compute role for DynamoDB item operations, Bedrock
  inference, and the Crohn's-only Bedrock guardrail;
- an EventBridge-triggered Lambda that calls the authenticated pending-deletion sweep once
  per day;
- a monthly AWS cost budget at $20.

The DynamoDB table has `DeletionPolicy: Retain`, `UpdateReplacePolicy: Retain`, and deletion
protection enabled because it stores patient-generated data.

## Deploy

```bash
AWS_PROFILE=crohns-buddy-deploy ./scripts/deploy-aws.sh
```

Self-registration is disabled. Accounts must be created by an administrator; signin,
password recovery, and session management are handled by Cognito behind the application's
branded account interface. Passwords are used only for the requested account operation and
are never persisted by the application. ID, access, and refresh tokens are stored in
Secure, HttpOnly cookies.

Google, Facebook, and Sign in with Apple are optional because each
provider requires its own application credentials. Configure this authorized redirect URI
in each provider:

```text
https://crohns-buddy-853513360253.auth.us-east-1.amazoncognito.com/oauth2/idpresponse
```

Then export the matching credential pair before deploying:

```text
GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET
FACEBOOK_APP_ID / FACEBOOK_APP_SECRET
APPLE_SERVICES_ID / APPLE_TEAM_ID / APPLE_KEY_ID / APPLE_PRIVATE_KEY
```

Social federation is also protected by the `EnableSocialIdentityProviders` security gate,
which defaults to `false`, because first-time federation can create a user profile. A
provider remains disabled unless the gate is explicitly enabled and all of its credentials
are supplied.

The deployment uses the Amplify SSR compute role through the AWS SDK default credential
provider. No long-lived AWS access key or Bedrock bearer token is stored in Amplify.
The Next.js build injects platform-managed values only into its server compilation. This
keeps SSR configuration available on Amplify without placing secrets in browser bundles or
public static assets.

The chat uses two independent scope controls: a strict system prompt that refuses
general-purpose requests and Bedrock guardrail `6vwvhqpr4sj7`, version `3`. The compute role
can apply only that account-local guardrail. Set `BEDROCK_GUARDRAIL_ID` and
`BEDROCK_GUARDRAIL_VERSION` together when overriding the defaults.

## Verify

```bash
npm test
npm run test:integration
npm run test:e2e
AWS_PROFILE=crohns-buddy-deploy \
AWS_REGION=us-east-1 \
MEAL_PLAN_TABLE_NAME=crohns-buddy-meal-plans \
MEAL_PLAN_AWS_REGION=us-east-1 \
npm run verify:deployment -- --url=https://main.YOUR_APP_ID.amplifyapp.com
```

`dynamodb-table.json` and `meal-plan-store-policy.json` remain reviewable reference artifacts.
The CloudFormation template is the applied source of truth.
