# Logto on Amazon EKS

The Crohn's Buddy identity service runs Logto OSS `1.43.0` on an EKS Auto Mode
cluster in `us-east-1`. The frontend remains on Amplify Hosting.

The deployment uses:

- a three-AZ EKS control plane with Auto Mode compute and load balancing;
- two Logto replicas spread across availability zones;
- a private, encrypted, Multi-AZ RDS PostgreSQL instance;
- an internet-facing HTTPS Application Load Balancer for
  `auth.crohns-buddy.com`;
- an admin endpoint available only through an authenticated Kubernetes
  port-forward, never through the public ingress;
- a separate database migration Job;
- a pinned Logto image digest.

Apply the deployment through `scripts/deploy-logto-eks.sh`. The script refreshes
the existing `crohns-buddy-deploy` ADA profile, verifies AWS account
`853513360253`, creates the cluster and database when absent, and deploys the
database migration before starting the application. It deploys the public
ingress after the ACM certificate is issued. PostgreSQL connections require TLS
because the RDS instance rejects unencrypted traffic. The deployment mounts the
AWS regional RDS trust bundle so certificate verification remains enabled.

OAuth connector credentials are intentionally not committed. Google, Facebook,
Amazon, and Apple connectors must be configured in Logto after their respective
developer-console credentials are available.
