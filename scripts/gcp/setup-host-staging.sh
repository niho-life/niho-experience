#!/usr/bin/env bash
# Owner-run only; review docs/host-calendar-staging.md first. Never run from CI.
# Creates dedicated staging identities/resources, but no DB, user, secret or data.
set -euo pipefail

[[ "${CONFIRM_HOST_STAGING_SETUP:-}" == niho-app-stg ]] || {
  echo 'Set CONFIRM_HOST_STAGING_SETUP=niho-app-stg after reviewing the setup.' >&2
  exit 1
}
PROJECT=niho-app-stg
REGION=asia-northeast1
SERVICE=niho-experience-host-stg
REPOSITORY=experience-host-stg
POOL=experience-host-staging
PROVIDER=github
RUNTIME="experience-host-stg-runtime@${PROJECT}.iam.gserviceaccount.com"
DEPLOYER="experience-host-stg-deployer@${PROJECT}.iam.gserviceaccount.com"
# Public immutable GitHub repository identity; never a NIHO user/provider ID.
GITHUB_REPO_ID=1425500695
for tool in gcloud jq; do command -v "$tool" >/dev/null; done
# Newly created service accounts and pools can take time to become visible to
# other IAM APIs. Retry only idempotent bindings, then surface the final error.
retry_binding() {
  local attempt
  for attempt in {1..12}; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    if [[ "$attempt" -eq 12 ]]; then "$@" >/dev/null; return 1; fi
    sleep 10
  done
}
[[ "$(gcloud projects describe "$PROJECT" --format='value(projectId)')" == "$PROJECT" ]]
[[ "$(gcloud billing projects describe "$PROJECT" --format='value(billingEnabled)')" == True ]]
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
[[ "$PROJECT_NUMBER" =~ ^[0-9]+$ ]]
# Existing instance only. This script never changes its settings or database.
[[ "$(gcloud sql instances describe niho-app-db-stg --project "$PROJECT" --format='value(region)')" == "$REGION" ]]
[[ "$(gcloud compute networks describe default --project "$PROJECT" --format='value(name)')" == default ]]
[[ "$(gcloud compute networks subnets describe default --project "$PROJECT" --region "$REGION" --format='value(name)')" == default ]]

gcloud services enable --project "$PROJECT" run.googleapis.com artifactregistry.googleapis.com \
  iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com \
  secretmanager.googleapis.com sqladmin.googleapis.com
if ! gcloud artifacts repositories describe "$REPOSITORY" --project "$PROJECT" --location "$REGION" >/dev/null 2>&1; then
  gcloud artifacts repositories create "$REPOSITORY" --project "$PROJECT" --location "$REGION" \
    --repository-format docker --description 'Experience host staging images only'
fi
for email in "$RUNTIME" "$DEPLOYER"; do
  if ! gcloud iam service-accounts describe "$email" --project "$PROJECT" >/dev/null 2>&1; then
    gcloud iam service-accounts create "${email%%@*}" --project "$PROJECT" --display-name "${email%%@*}"
  fi
done
retry_binding gcloud artifacts repositories add-iam-policy-binding "$REPOSITORY" --project "$PROJECT" --location "$REGION" \
  --member "serviceAccount:$DEPLOYER" --role roles/artifactregistry.writer --quiet
retry_binding gcloud artifacts repositories add-iam-policy-binding "$REPOSITORY" --project "$PROJECT" --location "$REGION" \
  --member "serviceAccount:service-${PROJECT_NUMBER}@serverless-robot-prod.iam.gserviceaccount.com" \
  --role roles/artifactregistry.reader --quiet
retry_binding gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$DEPLOYER" \
  --role roles/serviceusage.serviceUsageConsumer --condition=None --quiet
retry_binding gcloud iam service-accounts add-iam-policy-binding "$RUNTIME" --project "$PROJECT" \
  --member "serviceAccount:$DEPLOYER" --role roles/iam.serviceAccountUser --quiet
# Cloud SQL supports instance conditions on project role bindings. SQL grants
# remain separate and must restrict the DB principal to the Experience DB.
retry_binding gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$RUNTIME" \
  --role roles/cloudsql.client \
  --condition "expression=resource.name == 'projects/${PROJECT}/instances/niho-app-db-stg' && resource.service == 'sqladmin.googleapis.com',title=experience-host-stg-instance" \
  --quiet

if ! gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" >/dev/null 2>&1; then
  # The placeholder has no secrets or DB, stays private, and is never promoted.
  gcloud run deploy "$SERVICE" --project "$PROJECT" --region "$REGION" \
    --image us-docker.pkg.dev/cloudrun/container/hello --service-account "$RUNTIME" \
    --no-allow-unauthenticated --invoker-iam-check --ingress all \
    --port 8080 --cpu 1 --memory 512Mi --min-instances 0 --max-instances 2 \
    --labels app=niho-experience,env=host-staging --quiet
fi
state="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format=json)"
jq -e --arg runtime "$RUNTIME" '.spec.template.spec.serviceAccountName == $runtime and .metadata.labels.app == "niho-experience" and .metadata.labels.env == "host-staging"' <<< "$state" >/dev/null
for role in roles/run.admin roles/run.invoker; do
  retry_binding gcloud run services add-iam-policy-binding "$SERVICE" --project "$PROJECT" --region "$REGION" \
    --member "serviceAccount:$DEPLOYER" --role "$role" --condition=None --quiet
done

if ! gcloud iam workload-identity-pools describe "$POOL" --project "$PROJECT" --location global >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "$POOL" --project "$PROJECT" --location global \
    --display-name 'Experience host staging only'
fi
condition="assertion.repository_id == '${GITHUB_REPO_ID}' && assertion.repository == 'niho-life/niho-experience' && assertion.ref == 'refs/heads/main' && assertion.environment == 'host-staging' && assertion.event_name == 'workflow_dispatch' && assertion.workflow_ref == 'niho-life/niho-experience/.github/workflows/deploy-host-staging.yml@refs/heads/main'"
mapping='google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.ref=assertion.ref,attribute.environment=assertion.environment'
if ! gcloud iam workload-identity-pools providers describe "$PROVIDER" --project "$PROJECT" --location global --workload-identity-pool "$POOL" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" --project "$PROJECT" --location global \
    --workload-identity-pool "$POOL" --issuer-uri https://token.actions.githubusercontent.com \
    --attribute-mapping "$mapping" --attribute-condition "$condition"
fi
provider="$(gcloud iam workload-identity-pools providers describe "$PROVIDER" --project "$PROJECT" --location global --workload-identity-pool "$POOL" --format=json)"
jq -e --arg condition "$condition" '.attributeCondition == $condition and .oidc.issuerUri == "https://token.actions.githubusercontent.com" and .attributeMapping["google.subject"] == "assertion.sub" and .attributeMapping["attribute.repository_id"] == "assertion.repository_id" and .disabled != true' <<< "$provider" >/dev/null
retry_binding gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER" --project "$PROJECT" \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository_id/${GITHUB_REPO_ID}" \
  --quiet
# Resource identifiers only. Secret values, DB URLs and real host IDs never print.
cat <<EOF
STG_HOST_WIF_PROVIDER=projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}
STG_HOST_DEPLOY_SERVICE_ACCOUNT=${DEPLOYER}
STG_HOST_SERVICE_URL=$(jq -r '.status.url' <<< "$state")
STG_HOST_CLOUDSQL_INSTANCE=${PROJECT}:${REGION}:niho-app-db-stg
Read docs/host-calendar-staging.md and complete manual readiness before enabling deployment.
EOF
