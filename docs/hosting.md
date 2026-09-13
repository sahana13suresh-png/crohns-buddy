# Hosting and operating cost

Owner contact address: sahana13suresh@gmail.com

## Hosting platform

**Hosting platform: AWS Amplify Hosting with managed Next.js SSR in `us-east-1`.**

Amplify connects to a dedicated CodeCommit repository and deploys the `main` branch as a
`WEB_COMPUTE` application. Dynamic API routes run with an Amplify SSR compute role; static
pages and assets are delivered through Amplify's managed CDN and TLS certificate.

The application is pinned to Next.js 15 because that major version is within Amplify's
documented managed Next.js support range. The build writes only allow-listed application
variables to `.env.production`, making them available to Next.js SSR without copying AWS
credentials into the deployment.

## AWS architecture

| Concern | AWS resource |
| --- | --- |
| Source and push-to-deploy | CodeCommit and Amplify Hosting |
| Dynamic application routes | Amplify managed SSR compute |
| Saved meal plans | DynamoDB on-demand table |
| AI inference | Amazon Bedrock through the SSR compute role |
| Pending account-deletion retries | Daily EventBridge rule and small Lambda invoker |
| Cost control | AWS Budget at $20/month |
| TLS | Amplify-managed certificate |

The SSR compute role grants exactly the seven DynamoDB item operations used by the
repository and Bedrock model invocation. It does not grant `dynamodb:Scan`, table-management
permissions, or access to unrelated AWS services.

## Configuration

Firebase public configuration is optional. When it is absent, account, cloud-save, and
community features are visibly disabled instead of failing at page or route startup. The
tracker, educational content, and AI meal planner remain usable.

AWS access keys are not application configuration. DynamoDB and Bedrock use the Amplify SSR
compute role through the AWS SDK default credential chain.

## Cost estimate at Monthly_Reference_Load

Monthly_Reference_Load is 1,000 monthly active patients, 30,000 page requests, 1,000 saved
record writes, and 20,000 saved record reads.

| Line item | Projected usage | Published monthly allowance or pricing basis | Estimated charge |
| --- | --- | --- | --- |
| Amplify build minutes | A few production builds | 1,000 standard build minutes | $0.00 |
| Amplify CDN storage | Under 1 GB | 5 GB | $0.00 |
| Amplify data transfer | About 9 GB | 15 GB | $0.00 |
| Amplify SSR requests | Under 100,000 | 500,000 requests | $0.00 |
| Amplify SSR duration | Far below 100 GB-hours | 100 GB-hours | $0.00 |
| DynamoDB writes | About 200,000 transactional WRUs | On-demand request pricing | About $0.25 |
| DynamoDB reads | About 22,000 RRUs | On-demand request pricing | About $0.01 |
| EventBridge and Lambda sweep | One short invocation per day | Low-volume serverless usage | About $0.00 |
| **Total excluding Bedrock and domain registration** | | | **About $0.26/month** |

The allowances and rates can change; the applied $20 monthly budget is the operational
guardrail. Bedrock inference is intentionally excluded because it varies directly with model
and prompt usage.

## Commercial use

AWS Amplify is a metered AWS service. Use remains subject to the AWS Customer
Agreement and the terms for each configured service.

## Operations

The deployment and verification commands are documented in `infra/README.md`.
`scripts/verify-deployment.ts` checks the committed schedule and IAM scope, DynamoDB billing
and encryption, bundle secret leakage, region agreement, the $20 budget, and live TLS.
