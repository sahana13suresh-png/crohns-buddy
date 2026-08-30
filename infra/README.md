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
- a DynamoDB on-demand table with deletion protection;
- a least-privilege Amplify SSR compute role for DynamoDB item operations and Bedrock
  inference;
- an EventBridge-triggered Lambda that calls the authenticated pending-deletion sweep once
  per day;
- a monthly AWS cost budget at $20.

The DynamoDB table has `DeletionPolicy: Retain`, `UpdateReplacePolicy: Retain`, and deletion
protection enabled because it stores patient-generated data.

## Deploy

```bash
AWS_PROFILE=crohns-buddy-deploy ./scripts/deploy-aws.sh
```

Firebase configuration is optional. Without it, account, saved-plan, and community features
show an explicit configuration message; the public tracker, resources, and AI planner remain
available. To enable Firebase during deployment, export the `NEXT_PUBLIC_FIREBASE_*`
variables and optionally `NEXT_PUBLIC_AUTH_PROVIDERS=google` before running the script.

The deployment uses the Amplify SSR compute role through the AWS SDK default credential
provider. No long-lived AWS access key or Bedrock bearer token is stored in Amplify.

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
