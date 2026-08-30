#!/usr/bin/env bash
set -euo pipefail

PROFILE="${AWS_PROFILE:-crohns-buddy-deploy}"
REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID="${AWS_ACCOUNT_ID:-853513360253}"
STACK_NAME="${STACK_NAME:-crohns-buddy-prod}"
REPOSITORY_NAME="${REPOSITORY_NAME:-crohns-buddy-deploy}"
ALERT_EMAIL="${ALERT_EMAIL:-sahana13suresh@gmail.com}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE_FILE="${REPO_ROOT}/infra/aws/template.yaml"
SNAPSHOT_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "${SNAPSHOT_DIR}"
}
trap cleanup EXIT

command -v ada >/dev/null
command -v aws >/dev/null
command -v git >/dev/null
command -v git-remote-codecommit >/dev/null
command -v rsync >/dev/null

echo "Refreshing ADA credentials for AWS account ${ACCOUNT_ID}..."
ada credentials update \
  --account "${ACCOUNT_ID}" \
  --role Admin \
  --profile "${PROFILE}" \
  --provider isengard \
  --partition aws \
  --once

ACTUAL_ACCOUNT="$(aws sts get-caller-identity --profile "${PROFILE}" --query Account --output text)"
if [[ "${ACTUAL_ACCOUNT}" != "${ACCOUNT_ID}" ]]; then
  echo "Refusing to deploy: profile ${PROFILE} resolved to account ${ACTUAL_ACCOUNT}, expected ${ACCOUNT_ID}." >&2
  exit 1
fi

STACK_EXISTS='false'
if aws cloudformation describe-stacks \
  --profile "${PROFILE}" \
  --region "${REGION}" \
  --stack-name "${STACK_NAME}" >/dev/null 2>&1; then
  STACK_EXISTS='true'
fi

PARAMETERS=(
  "DeployHosting=true"
  "RepositoryName=${REPOSITORY_NAME}"
  "AlertEmail=${ALERT_EMAIL}"
)

if [[ "${STACK_EXISTS}" == 'false' ]]; then
  CRON_SECRET="${CRON_SECRET:-$(openssl rand -hex 32)}"
  PARAMETERS[0]='DeployHosting=false'
  PARAMETERS+=("CronSecret=${CRON_SECRET}")
elif [[ -n "${CRON_SECRET:-}" ]]; then
  PARAMETERS+=("CronSecret=${CRON_SECRET}")
fi

append_parameter() {
  local parameter_name="$1"
  local environment_name="$2"
  local parameter_value="${!environment_name:-}"
  if [[ -n "${parameter_value}" ]]; then
    PARAMETERS+=("${parameter_name}=${parameter_value}")
  fi
}

append_parameter FirebaseApiKey NEXT_PUBLIC_FIREBASE_API_KEY
append_parameter FirebaseAuthDomain NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
append_parameter FirebaseProjectId NEXT_PUBLIC_FIREBASE_PROJECT_ID
append_parameter FirebaseStorageBucket NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
append_parameter FirebaseMessagingSenderId NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID
append_parameter FirebaseAppId NEXT_PUBLIC_FIREBASE_APP_ID
append_parameter AuthProviders NEXT_PUBLIC_AUTH_PROVIDERS
append_parameter PerspectiveApiKey PERSPECTIVE_API_KEY
append_parameter BedrockModelId BEDROCK_MODEL_ID

if [[ "${STACK_EXISTS}" == 'false' ]]; then
  echo "Creating the data store, IAM roles, budget, and deployment repository..."
  aws cloudformation deploy \
    --profile "${PROFILE}" \
    --region "${REGION}" \
    --stack-name "${STACK_NAME}" \
    --template-file "${TEMPLATE_FILE}" \
    --capabilities CAPABILITY_IAM \
    --no-fail-on-empty-changeset \
    --parameter-overrides "${PARAMETERS[@]}"
else
  echo "Existing stack found; preserving its hosting resources and secret parameters."
fi

echo "Creating a clean deployment snapshot..."
REPOSITORY_REMOTE="codecommit::${REGION}://${REPOSITORY_NAME}"
AWS_PROFILE="${PROFILE}" AWS_REGION="${REGION}" \
  git clone "${REPOSITORY_REMOTE}" "${SNAPSHOT_DIR}"

if ! git -C "${SNAPSHOT_DIR}" rev-parse --verify HEAD >/dev/null 2>&1; then
  git -C "${SNAPSHOT_DIR}" symbolic-ref HEAD refs/heads/main
fi

rsync -a --delete \
  --exclude='.git' \
  --exclude='.next' \
  --exclude='node_modules' \
  --exclude='coverage' \
  --exclude='test-results' \
  --exclude='playwright-report' \
  --exclude='.env*' \
  "${REPO_ROOT}/" "${SNAPSHOT_DIR}/"
cp "${REPO_ROOT}/.env.local.example" "${SNAPSHOT_DIR}/.env.local.example"

git -C "${SNAPSHOT_DIR}" add --all
if git -C "${SNAPSHOT_DIR}" diff --cached --quiet; then
  echo "Deployment source is already current."
else
  git -C "${SNAPSHOT_DIR}" \
    -c user.name='Crohns Buddy Deployment' \
    -c user.email='crohns-buddy-deploy@localhost' \
    commit --message='Deploy Crohns Buddy'

  echo "Pushing the deployment snapshot to CodeCommit..."
  AWS_PROFILE="${PROFILE}" AWS_REGION="${REGION}" \
    git -C "${SNAPSHOT_DIR}" push origin main
fi

PARAMETERS[0]='DeployHosting=true'
echo "Creating Amplify Hosting and the daily cleanup schedule..."
aws cloudformation deploy \
  --profile "${PROFILE}" \
  --region "${REGION}" \
  --stack-name "${STACK_NAME}" \
  --template-file "${TEMPLATE_FILE}" \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides "${PARAMETERS[@]}"

APP_ID="$(aws cloudformation describe-stacks \
  --profile "${PROFILE}" \
  --region "${REGION}" \
  --stack-name "${STACK_NAME}" \
  --query "Stacks[0].Outputs[?OutputKey=='AmplifyAppId'].OutputValue" \
  --output text)"
PRODUCTION_URL="$(aws cloudformation describe-stacks \
  --profile "${PROFILE}" \
  --region "${REGION}" \
  --stack-name "${STACK_NAME}" \
  --query "Stacks[0].Outputs[?OutputKey=='ProductionUrl'].OutputValue" \
  --output text)"

echo "Waiting for the Amplify production build..."
JOB_ID=''
if START_OUTPUT="$(aws amplify start-job \
  --profile "${PROFILE}" \
  --region "${REGION}" \
  --app-id "${APP_ID}" \
  --branch-name main \
  --job-type RELEASE \
  --output json 2>/dev/null)"; then
  JOB_ID="$(node -e 'const fs=require("fs"); const value=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(value.jobSummary.jobId)' <<<"${START_OUTPUT}")"
else
  JOB_ID="$(aws amplify list-jobs \
    --profile "${PROFILE}" \
    --region "${REGION}" \
    --app-id "${APP_ID}" \
    --branch-name main \
    --max-results 1 \
    --query 'jobSummaries[0].jobId' \
    --output text)"
fi

while true; do
  JOB_STATUS="$(aws amplify get-job \
    --profile "${PROFILE}" \
    --region "${REGION}" \
    --app-id "${APP_ID}" \
    --branch-name main \
    --job-id "${JOB_ID}" \
    --query 'job.summary.status' \
    --output text)"
  echo "Amplify job ${JOB_ID}: ${JOB_STATUS}"
  case "${JOB_STATUS}" in
    SUCCEED)
      break
      ;;
    FAILED|CANCELLED)
      echo "Amplify build ${JOB_ID} did not succeed." >&2
      exit 1
      ;;
  esac
  sleep 10
done

echo "Deployment complete: ${PRODUCTION_URL}"
