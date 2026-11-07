#!/usr/bin/env bash
# Owner-run only; review docs/host-pwa.md「ステージングで有効にする」first. Never run from CI.
# Host push on staging (#177 P2). Idempotently creates the one new empty Secret (the VAPID private key; no
# version is created here), resource-level Secret access for the runtime on exactly that Secret, the push
# job's identity and a PAUSED Cloud Scheduler job. It never creates a secret version, prints a secret value or
# changes another resource. A job that already exists is only checked, never changed. It never resumes the job.
set -euo pipefail

[[ "${CONFIRM_HOST_STAGING_PUSH_SETUP:-}" == niho-app-stg ]] || {
  echo 'Set CONFIRM_HOST_STAGING_PUSH_SETUP=niho-app-stg after reviewing the setup.' >&2
  exit 1
}
SERVICE_URL="${STG_HOST_SERVICE_URL:-}"
[[ "$SERVICE_URL" == https://experience-stg.niho.life ]] || {
  echo 'Set STG_HOST_SERVICE_URL to https://experience-stg.niho.life (the trusted edge origin).' >&2
  exit 1
}
PROJECT=niho-app-stg
REGION=asia-northeast1
SERVICE=niho-experience-host-stg
RUNTIME="experience-host-stg-runtime@${PROJECT}.iam.gserviceaccount.com"
PUSH="experience-host-push@${PROJECT}.iam.gserviceaccount.com"
# The VAPID private key. Created without a version; the version is added from a safe terminal (docs/host-pwa.md).
VAPID_SECRET=experience-stg-host-push-vapid-private-key
SCHEDULER_JOB=experience-host-push-drain-stg
DRAIN_URI="${SERVICE_URL}/internal/host-push/v1/drain"
DESCRIPTION='Host push drain (staging, #177). Resume only after deploying with STG_HOST_PUSH_ENABLED=true.'
for tool in gcloud jq; do command -v "$tool" >/dev/null; done
# Newly created service accounts can take time to become visible to other IAM APIs. Retry only
# idempotent bindings, then surface the final error.
retry_binding() {
  local attempt
  for attempt in {1..12}; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    if [[ "$attempt" -eq 12 ]]; then "$@" >/dev/null; return 1; fi
    sleep 10
  done
}
[[ "$(gcloud projects describe "$PROJECT" --format='value(projectId)')" == "$PROJECT" ]]
# Only the fixed trusted edge origin is allowed (not a candidate tag or arbitrary host): the job's
# audience is compared with HOST_PUSH_JOB_AUDIENCE, which the deploy workflow sets to the same URL.
state="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format=json)"
jq -e --arg url "$SERVICE_URL" --arg runtime "$RUNTIME" '
  . as $service
  | ($url == "https://experience-stg.niho.life")
    and $service.metadata.name == "niho-experience-host-stg"
    and $service.metadata.annotations["run.googleapis.com/ingress"] == "internal-and-cloud-load-balancing"
    and $service.spec.template.spec.serviceAccountName == $runtime
    and $service.metadata.labels.app == "niho-experience"
    and $service.metadata.labels.env == "host-staging"
' <<< "$state" >/dev/null || {
  echo "The trusted edge origin, ingress, or staging service identity does not match." >&2
  exit 1
}

gcloud services enable --project "$PROJECT" cloudscheduler.googleapis.com
if ! gcloud secrets describe "$VAPID_SECRET" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud secrets create "$VAPID_SECRET" --project "$PROJECT" --replication-policy automatic \
    --labels app=niho-experience,env=host-staging
fi
# Resource-level only: no project-wide Secret Accessor.
retry_binding gcloud secrets add-iam-policy-binding "$VAPID_SECRET" --project "$PROJECT" \
  --member "serviceAccount:$RUNTIME" --role roles/secretmanager.secretAccessor --condition=None --quiet

# Cloud Scheduler's OIDC identity for the push route. No project roles; invoker on this service only.
if ! gcloud iam service-accounts describe "$PUSH" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${PUSH%%@*}" --project "$PROJECT" --display-name "${PUSH%%@*}" \
    --description 'Cloud Scheduler OIDC identity for the host push drain (staging). No project roles.'
fi
retry_binding gcloud run services add-iam-policy-binding "$SERVICE" --project "$PROJECT" --region "$REGION" \
  --member "serviceAccount:$PUSH" --role roles/run.invoker --condition=None --quiet

if gcloud scheduler jobs describe "$SCHEDULER_JOB" --project "$PROJECT" --location "$REGION" >/dev/null 2>&1; then
  created=false
else
  gcloud scheduler jobs create http "$SCHEDULER_JOB" --project "$PROJECT" --location "$REGION" \
    --schedule '* * * * *' --time-zone Etc/UTC --uri "$DRAIN_URI" --http-method post \
    --oidc-service-account-email "$PUSH" --oidc-token-audience "$SERVICE_URL" \
    --attempt-deadline 180s --max-retry-attempts 0 --description "$DESCRIPTION" --quiet
  # There is no create-paused flag: pause at once. Until the gate is on, the route answers 404 and changes nothing.
  gcloud scheduler jobs pause "$SCHEDULER_JOB" --project "$PROJECT" --location "$REGION" --quiet
  created=true
fi
job="$(gcloud scheduler jobs describe "$SCHEDULER_JOB" --project "$PROJECT" --location "$REGION" --format=json)"
# Migrate only a paused job whose previous URI/audience are published aliases of this exact service.
current_uri="$(jq -r '.httpTarget.uri' <<< "$job")"
current_origin="${current_uri%/internal/host-push/v1/drain}"
if [[ "$current_uri" != "$DRAIN_URI" ]]; then
  jq -e --arg origin "$current_origin" --arg sa "$PUSH" --arg description "$DESCRIPTION" \
    --argjson urls "$(jq -c '.metadata.annotations["run.googleapis.com/urls"] | fromjson' <<< "$state")" \
    '.state == "PAUSED" and .schedule == "* * * * *" and .timeZone == "Etc/UTC"
     and .httpTarget.uri == ($origin + "/internal/host-push/v1/drain") and .httpTarget.httpMethod == "POST"
     and .httpTarget.oidcToken.serviceAccountEmail == $sa and .httpTarget.oidcToken.audience == $origin
     and .attemptDeadline == "180s" and ((.retryConfig.retryCount // 0) == 0) and .description == $description
     and ($urls | index($origin)) != null' <<< "$job" >/dev/null || {
    echo 'Existing push job is not a paused job using a published alias with expected settings.' >&2
    exit 1
  }
  gcloud scheduler jobs update http "$SCHEDULER_JOB" --project "$PROJECT" --location "$REGION" \
    --uri "$DRAIN_URI" --oidc-service-account-email "$PUSH" --oidc-token-audience "$SERVICE_URL" --quiet
  job="$(gcloud scheduler jobs describe "$SCHEDULER_JOB" --project "$PROJECT" --location "$REGION" --format=json)"
fi
jq -e --arg uri "$DRAIN_URI" --arg sa "$PUSH" --arg audience "$SERVICE_URL" \
  '.schedule == "* * * * *" and .timeZone == "Etc/UTC" and .httpTarget.uri == $uri and .httpTarget.httpMethod == "POST"
   and .httpTarget.oidcToken.serviceAccountEmail == $sa and .httpTarget.oidcToken.audience == $audience
   and .attemptDeadline == "180s" and ((.retryConfig.retryCount // 0) == 0)' <<< "$job" >/dev/null || {
  echo "Cloud Scheduler job ${SCHEDULER_JOB} does not match the staging push configuration; review it without changing it." >&2
  exit 1
}
job_state="$(jq -r '.state' <<< "$job")"
if [[ "$created" == true && "$job_state" != PAUSED ]]; then
  echo "Cloud Scheduler job ${SCHEDULER_JOB} was created but is ${job_state}; pause it before continuing." >&2
  exit 1
fi
# Resource identifiers only. Secret values and versions are never read or printed.
cat <<EOF
Secret ${VAPID_SECRET}: present (add the VAPID private key as a version from a safe terminal, docs/host-pwa.md).
Runtime ${RUNTIME}: secretAccessor on ${VAPID_SECRET}
Push identity: ${PUSH} (run.invoker on ${SERVICE} only)
Cloud Scheduler ${SCHEDULER_JOB} (${REGION}): ${job_state}. POST ${DRAIN_URI}
Set the STG_HOST_PUSH_* Environment Variables in docs/host-pwa.md, deploy, then resume this job.
EOF
