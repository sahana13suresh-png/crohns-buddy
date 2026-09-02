#!/usr/bin/env bash
set -euo pipefail

PROFILE="${AWS_PROFILE:-crohns-buddy-deploy}"
REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID="853513360253"
CLUSTER_NAME="crohns-buddy-auth"
NETWORK_STACK="crohns-buddy-logto-network"
DATABASE_STACK="crohns-buddy-logto-database"
CERTIFICATE_DOMAIN="auth.crohns-buddy.com"
LOGTO_ENDPOINT="https://${CERTIFICATE_DOMAIN}"

for command_name in aws curl eksctl kubectl node; do
  command -v "${command_name}" >/dev/null 2>&1 || {
    echo "Required command is missing: ${command_name}" >&2
    exit 1
  }
done

actual_account="$(
  aws sts get-caller-identity \
    --profile "${PROFILE}" \
    --query Account \
    --output text
)"
if [[ "${actual_account}" != "${ACCOUNT_ID}" ]]; then
  echo "Refusing to deploy to AWS account ${actual_account}; expected ${ACCOUNT_ID}." >&2
  exit 1
fi

if ! aws eks describe-cluster \
  --profile "${PROFILE}" \
  --region "${REGION}" \
  --name "${CLUSTER_NAME}" >/dev/null 2>&1; then
  AWS_PROFILE="${PROFILE}" eksctl create cluster -f infra/eks/cluster.yaml
fi

aws eks update-kubeconfig \
  --profile "${PROFILE}" \
  --region "${REGION}" \
  --name "${CLUSTER_NAME}" >/dev/null

vpc_id="$(
  aws eks describe-cluster \
    --profile "${PROFILE}" \
    --region "${REGION}" \
    --name "${CLUSTER_NAME}" \
    --query 'cluster.resourcesVpcConfig.vpcId' \
    --output text
)"
cluster_security_group_id="$(
  aws eks describe-cluster \
    --profile "${PROFILE}" \
    --region "${REGION}" \
    --name "${CLUSTER_NAME}" \
    --query 'cluster.resourcesVpcConfig.clusterSecurityGroupId' \
    --output text
)"
private_subnets="$(
  aws cloudformation describe-stacks \
    --profile "${PROFILE}" \
    --region "${REGION}" \
    --stack-name "${NETWORK_STACK}" \
    --query 'Stacks[0].Outputs[?starts_with(OutputKey, `PrivateSubnet`)].OutputValue' \
    --output text |
    tr '\t' ','
)"

aws cloudformation deploy \
  --profile "${PROFILE}" \
  --region "${REGION}" \
  --stack-name "${DATABASE_STACK}" \
  --template-file infra/eks/rds.yaml \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    "VpcId=${vpc_id}" \
    "PrivateSubnetIds=${private_subnets}" \
    "EksClusterSecurityGroupId=${cluster_security_group_id}"

database_endpoint="$(
  aws cloudformation describe-stacks \
    --profile "${PROFILE}" \
    --region "${REGION}" \
    --stack-name "${DATABASE_STACK}" \
    --query 'Stacks[0].Outputs[?OutputKey==`DatabaseEndpoint`].OutputValue | [0]' \
    --output text
)"
database_port="$(
  aws cloudformation describe-stacks \
    --profile "${PROFILE}" \
    --region "${REGION}" \
    --stack-name "${DATABASE_STACK}" \
    --query 'Stacks[0].Outputs[?OutputKey==`DatabasePort`].OutputValue | [0]' \
    --output text
)"
database_secret_arn="$(
  aws cloudformation describe-stacks \
    --profile "${PROFILE}" \
    --region "${REGION}" \
    --stack-name "${DATABASE_STACK}" \
    --query 'Stacks[0].Outputs[?OutputKey==`DatabaseSecretArn`].OutputValue | [0]' \
    --output text
)"
database_secret="$(
  aws secretsmanager get-secret-value \
    --profile "${PROFILE}" \
    --region "${REGION}" \
    --secret-id "${database_secret_arn}" \
    --query SecretString \
    --output text
)"
database_url="$(
  DATABASE_SECRET="${database_secret}" \
  DATABASE_ENDPOINT="${database_endpoint}" \
  DATABASE_PORT="${database_port}" \
  node -e '
    const value = JSON.parse(process.env.DATABASE_SECRET);
    const user = encodeURIComponent(value.username);
    const password = encodeURIComponent(value.password);
    const host = process.env.DATABASE_ENDPOINT;
    const port = process.env.DATABASE_PORT;
    process.stdout.write(`postgresql://${user}:${password}@${host}:${port}/logto?sslmode=require`);
  '
)"
unset database_secret

certificate_arn="$(
  aws acm list-certificates \
    --profile "${PROFILE}" \
    --region "${REGION}" \
    --certificate-statuses ISSUED \
    --query "CertificateSummaryList[?DomainName=='${CERTIFICATE_DOMAIN}'].CertificateArn | [0]" \
    --output text
)"

kubectl apply -f <(
  kubectl create namespace logto \
    --dry-run=client \
    -o yaml
)
rds_ca_file="$(mktemp)"
trap 'rm -f "${rds_ca_file}"' EXIT
curl \
  --fail \
  --silent \
  --show-error \
  --proto '=https' \
  --tlsv1.2 \
  "https://truststore.pki.rds.amazonaws.com/${REGION}/${REGION}-bundle.pem" \
  --output "${rds_ca_file}"
grep -q -- "-----BEGIN CERTIFICATE-----" "${rds_ca_file}" || {
  echo "The downloaded RDS trust bundle is invalid." >&2
  exit 1
}
kubectl create configmap rds-ca-bundle \
  --namespace logto \
  --from-file="${REGION}-bundle.pem=${rds_ca_file}" \
  --dry-run=client \
  -o yaml |
  kubectl apply -f -
kubectl create secret generic logto-runtime \
  --namespace logto \
  --from-literal="DB_URL=${database_url}" \
  --from-literal="ENDPOINT=${LOGTO_ENDPOINT}" \
  --dry-run=client \
  -o yaml |
  kubectl apply -f -
unset database_url

kubectl delete job logto-database-migrate \
  --namespace logto \
  --ignore-not-found \
  --wait=true
kubectl apply -f infra/eks/logto-migrate.yaml
kubectl wait \
  --namespace logto \
  --for=condition=complete \
  job/logto-database-migrate \
  --timeout=15m
kubectl apply -f infra/eks/logto.yaml
kubectl rollout status \
  --namespace logto \
  deployment/logto \
  --timeout=15m

load_balancer=""
if [[ -n "${certificate_arn}" && "${certificate_arn}" != "None" ]]; then
  sed "s|LOGTO_CERTIFICATE_ARN|${certificate_arn}|g" infra/eks/ingress.yaml |
    kubectl apply -f -
  load_balancer="$(
    kubectl get ingress logto \
      --namespace logto \
      --output jsonpath='{.status.loadBalancer.ingress[0].hostname}'
  )"
else
  echo "The ACM certificate for ${CERTIFICATE_DOMAIN} is awaiting DNS validation; ingress was not changed."
fi

echo "Logto deployment is ready."
echo "Load balancer: ${load_balancer:-pending}"
echo "Public endpoint: ${LOGTO_ENDPOINT}"
