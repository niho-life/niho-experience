#!/usr/bin/env bash
# One-time, owner-run setup for NIHO Experience production.
# The initial pilot may share niho-app-prd, but Cloud Run and deploy IAM stay
# service-scoped. Review docs/production-deploy.md before running this script.
# It never changes the shared project's billing account or existing load balancer.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-niho-app-prd}"
REGION="${REGION:-asia-northeast1}"
REPOSITORY="${REPOSITORY:-experience-prod}"
SERVICE="${SERVICE:-niho-experience}"
ORG_ID="${ORG_ID:?Set the approved NIHO organization ID}"
BILLING_ACCOUNT="${BILLING_ACCOUNT:-}"
ALLOW_SHARED_NIHO_APP_PROJECT="${ALLOW_SHARED_NIHO_APP_PROJECT:-false}"
SHARED_PROJECT_ID=niho-app-prd
GITHUB_REPO_ID=1425500695
POOL=experience-production
PROVIDER=github
RUNTIME_SA="experience-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
DEPLOY_SA="experience-deployer@${PROJECT_ID}.iam.gserviceaccount.com"

project_org_id() {
  local parent_type parent_id folder_parent
  parent_type="$(gcloud projects describe "$PROJECT_ID" --format='value(parent.type)')"
  parent_id="$(gcloud projects describe "$PROJECT_ID" --format='value(parent.id)')"
  case "$parent_type" in
    organization) printf '%s\n' "$parent_id" ;;
    folder)
      folder_parent="$(gcloud resource-manager folders describe "$parent_id" --format='value(parent)')"
      [[ "$folder_parent" == organizations/* ]] || return 1
      printf '%s\n' "${folder_parent#organizations/}"
      ;;
    *) return 1 ;;
  esac
}

if [[ "$PROJECT_ID" == "$SHARED_PROJECT_ID" ]]; then
  if [[ "$ALLOW_SHARED_NIHO_APP_PROJECT" != true ]]; then
    echo "Set ALLOW_SHARED_NIHO_APP_PROJECT=true to opt into the reviewed shared-project setup" >&2
    exit 1
  fi
  gcloud projects describe "$PROJECT_ID" >/dev/null
  if [[ "$(project_org_id)" != "$ORG_ID" ]]; then
    echo "Shared project ${PROJECT_ID} is not in the approved organization" >&2
    exit 1
  fi
  if [[ "$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)')" != True ]]; then
    echo "Shared project ${PROJECT_ID} must already have billing enabled; this script will not link a billing account" >&2
    exit 1
  fi
elif [[ "$PROJECT_ID" != niho-experience-prod ]]; then
  echo "Use niho-app-prd only with ALLOW_SHARED_NIHO_APP_PROJECT=true, or PROJECT_ID=niho-experience-prod" >&2
  exit 1
else
  if [[ -z "$BILLING_ACCOUNT" ]]; then
    echo "Set BILLING_ACCOUNT for the dedicated production project" >&2
    exit 1
  fi
  if ! gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1; then
    gcloud projects create "$PROJECT_ID" --organization="$ORG_ID" --name="NIHO Experience production"
  fi
  if [[ "$(project_org_id)" != "$ORG_ID" ]]; then
    echo "Project ${PROJECT_ID} is not in the approved organization" >&2
    exit 1
  fi
  if [[ "$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)')" != True ]]; then
    gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT"
  fi
  if [[ "$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingAccountName)')" != "billingAccounts/${BILLING_ACCOUNT}" ]]; then
    echo "Project ${PROJECT_ID} is linked to a different billing account" >&2
    exit 1
  fi
fi
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"

gcloud services enable --project "$PROJECT_ID" \
  run.googleapis.com artifactregistry.googleapis.com iam.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com cloudresourcemanager.googleapis.com

if ! gcloud artifacts repositories describe "$REPOSITORY" --project "$PROJECT_ID" --location "$REGION" >/dev/null 2>&1; then
  gcloud artifacts repositories create "$REPOSITORY" --project "$PROJECT_ID" --location "$REGION" \
    --repository-format=docker --description="NIHO Experience production images"
fi
policy="$(mktemp)"
trap 'rm -f "$policy"' EXIT
cat > "$policy" <<'JSON'
[
  {"name": "keep-newest-10", "action": {"type": "Keep"}, "mostRecentVersions": {"keepCount": 10}},
  {"name": "delete-older-than-30-days", "action": {"type": "Delete"}, "condition": {"tagState": "any", "olderThan": "30d"}}
]
JSON
gcloud artifacts repositories set-cleanup-policies "$REPOSITORY" --project "$PROJECT_ID" --location "$REGION" \
  --policy="$policy" --no-dry-run --quiet >/dev/null

ensure_sa() {
  local email="$1" display_name="$2"
  if ! gcloud iam service-accounts describe "$email" --project "$PROJECT_ID" >/dev/null 2>&1; then
    gcloud iam service-accounts create "${email%%@*}" --project "$PROJECT_ID" --display-name="$display_name"
  fi
}
ensure_sa "$RUNTIME_SA" "NIHO Experience production runtime"
ensure_sa "$DEPLOY_SA" "NIHO Experience production deployer"

gcloud artifacts repositories add-iam-policy-binding "$REPOSITORY" --project "$PROJECT_ID" --location "$REGION" \
  --member="serviceAccount:${DEPLOY_SA}" --role=roles/artifactregistry.writer --quiet >/dev/null
RUN_SERVICE_AGENT="service-${PROJECT_NUMBER}@serverless-robot-prod.iam.gserviceaccount.com"
gcloud artifacts repositories add-iam-policy-binding "$REPOSITORY" --project "$PROJECT_ID" --location "$REGION" \
  --member="serviceAccount:${RUN_SERVICE_AGENT}" --role=roles/artifactregistry.reader --quiet >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${DEPLOY_SA}" \
  --role=roles/serviceusage.serviceUsageConsumer --condition=None --quiet >/dev/null
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" --project "$PROJECT_ID" \
  --member="serviceAccount:${DEPLOY_SA}" --role=roles/iam.serviceAccountUser --quiet >/dev/null

# Bootstrap a private service so the GitHub deployer can receive Cloud Run Admin
# on this service resource, rather than on the whole production project.
if ! gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" >/dev/null 2>&1; then
  gcloud run deploy "$SERVICE" --project "$PROJECT_ID" --region "$REGION" \
    --image=us-docker.pkg.dev/cloudrun/container/hello \
    --service-account="$RUNTIME_SA" --no-allow-unauthenticated \
    --port=8080 --cpu=1 --memory=512Mi --min-instances=0 --max-instances=2 \
    --labels=app=niho-experience,env=production --quiet
fi
service_state="$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format=json)"
if [[ "$(jq -r '.spec.template.spec.serviceAccountName // empty' <<< "$service_state")" != "$RUNTIME_SA" ]]; then
  echo "Cloud Run service ${SERVICE} is not using the dedicated Experience runtime service account" >&2
  exit 1
fi
gcloud run services add-iam-policy-binding "$SERVICE" --project "$PROJECT_ID" --region "$REGION" \
  --member="serviceAccount:${DEPLOY_SA}" --role=roles/run.admin --condition=None --quiet >/dev/null

# Isolated pool: a preview OIDC token cannot impersonate the production SA.
if ! gcloud iam workload-identity-pools describe "$POOL" --project "$PROJECT_ID" --location=global >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "$POOL" --project "$PROJECT_ID" --location=global \
    --display-name="Production GitHub Actions"
fi
condition="assertion.repository_id == '${GITHUB_REPO_ID}' && assertion.ref == 'refs/heads/main' && assertion.environment == 'production' && assertion.event_name == 'workflow_dispatch' && assertion.workflow_ref == 'niho-life/niho-experience/.github/workflows/deploy-production.yml@refs/heads/main' && 'actor_id' in assertion && assertion.actor_id in ['252574334', '345803507', '119937906']"
mapping="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.ref=assertion.ref,attribute.environment=assertion.environment"
if ! gcloud iam workload-identity-pools providers describe "$PROVIDER" --project "$PROJECT_ID" --location=global \
  --workload-identity-pool="$POOL" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" --project "$PROJECT_ID" --location=global \
    --workload-identity-pool="$POOL" --display-name="Experience production" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="$mapping" --attribute-condition="$condition"
fi
current_condition="$(gcloud iam workload-identity-pools providers describe "$PROVIDER" --project "$PROJECT_ID" --location=global \
  --workload-identity-pool="$POOL" --format='value(attributeCondition)')"
if [[ "$current_condition" != "$condition" ]]; then
  echo "Production OIDC provider condition differs from the reviewed configuration" >&2
  exit 1
fi
gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" --project "$PROJECT_ID" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository_id/${GITHUB_REPO_ID}" \
  --quiet >/dev/null

cat <<EOF
PROD_GCP_PROJECT_ID=${PROJECT_ID}
PROD_GCP_REGION=${REGION}
PROD_GCP_ARTIFACT_REPOSITORY=${REPOSITORY}
PROD_GCP_WIF_PROVIDER=projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}
PROD_GCP_DEPLOY_SERVICE_ACCOUNT=${DEPLOY_SA}
PROD_GCP_RUNTIME_SERVICE_ACCOUNT=${RUNTIME_SA}
PRODUCTION_DEPLOY_ENABLED=true
EOF
