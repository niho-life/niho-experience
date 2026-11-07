#!/usr/bin/env bash
# Owner-run only; review docs/host-calendar-staging.md「旅行者の予約（Stripe テストモード、#285）」first. Never run from CI.
# Traveler booking on staging (#285). Idempotently creates the one new empty Secret, resource-level Secret
# access for the runtime on exactly the NIHO app secrets it reuses (owner decision 2026-10-31), the jobs
# identity and a PAUSED Cloud Scheduler job. It never creates a secret version, prints a secret value or
# changes a NIHO app resource beyond adding the runtime's secretAccessor binding on the listed secrets.
# For an existing paused job, it only reconciles URI/audience when both use another published URL alias
# for this exact service and all other job settings match. It never resumes the job.
set -euo pipefail

[[ "${CONFIRM_HOST_STAGING_GUEST_BOOKING_SETUP:-}" == niho-app-stg ]] || {
  echo 'Set CONFIRM_HOST_STAGING_GUEST_BOOKING_SETUP=niho-app-stg after reviewing the setup.' >&2
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
JOBS="experience-jobs@${PROJECT}.iam.gserviceaccount.com"
# The signing secret of the Stripe TEST webhook endpoint for this service. Created without a version.
WEBHOOK_SECRET=experience-stg-stripe-webhook-secret
# NIHO app's existing staging secrets, reused as they are. Read access only; never created or changed here.
NIHO_SECRETS=(
  RECEIPT_DELIVERY_SMTP_HOST
  RECEIPT_DELIVERY_SMTP_PORT
  RECEIPT_DELIVERY_SMTP_USER
  RECEIPT_DELIVERY_SMTP_PASSWORD
  STRIPE_CONNECT_PLATFORM_SECRET_KEY
)
SCHEDULER_JOB=experience-jobs-drain-stg
DRAIN_URI="${SERVICE_URL}/internal/experience-jobs/v1/drain"
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
# Only the fixed trusted edge origin is allowed (not a candidate tag or arbitrary host):
# the job's audience is compared with EXPERIENCE_JOBS_AUDIENCE, which the deploy workflow sets to the same URL.
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
for secret in "${NIHO_SECRETS[@]}"; do
  gcloud secrets describe "$secret" --project "$PROJECT" --format='value(name)' >/dev/null || {
    echo "NIHO app secret ${secret} is missing; this script never creates it." >&2
    exit 1
  }
done

gcloud services enable --project "$PROJECT" cloudscheduler.googleapis.com
if ! gcloud secrets describe "$WEBHOOK_SECRET" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud secrets create "$WEBHOOK_SECRET" --project "$PROJECT" --replication-policy automatic \
    --labels app=niho-experience,env=host-staging
fi
# Resource-level only: no project-wide Secret Accessor.
for secret in "$WEBHOOK_SECRET" "${NIHO_SECRETS[@]}"; do
  retry_binding gcloud secrets add-iam-policy-binding "$secret" --project "$PROJECT" \
    --member "serviceAccount:$RUNTIME" --role roles/secretmanager.secretAccessor --condition=None --quiet
done

# Cloud Scheduler's OIDC identity for the drain route. No project roles; invoker on this service only.
if ! gcloud iam service-accounts describe "$JOBS" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${JOBS%%@*}" --project "$PROJECT" --display-name "${JOBS%%@*}" \
    --description 'Cloud Scheduler OIDC identity for the experience jobs drain (staging). No project roles.'
fi
retry_binding gcloud run services add-iam-policy-binding "$SERVICE" --project "$PROJECT" --region "$REGION" \
  --member "serviceAccount:$JOBS" --role roles/run.invoker --condition=None --quiet

if ! gcloud scheduler jobs describe "$SCHEDULER_JOB" --project "$PROJECT" --location "$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs create http "$SCHEDULER_JOB" --project "$PROJECT" --location "$REGION" \
    --schedule '* * * * *' --time-zone Etc/UTC --uri "$DRAIN_URI" --http-method post \
    --oidc-service-account-email "$JOBS" --oidc-token-audience "$SERVICE_URL" \
    --attempt-deadline 180s --max-retry-attempts 0 \
    --description 'Experience jobs drain (staging, #285). Resume only after deploying with STG_GUEST_BOOKING_ENABLED=true.' \
    --quiet
  # There is no create-paused flag: pause at once. Until the gate is on, the route answers 404 and changes nothing.
  gcloud scheduler jobs pause "$SCHEDULER_JOB" --project "$PROJECT" --location "$REGION" --quiet
  created=true
else
  created=false
fi
job="$(gcloud scheduler jobs describe "$SCHEDULER_JOB" --project "$PROJECT" --location "$REGION" --format=json)"
if [[ "$created" == false ]]; then
  current_uri="$(jq -r '.httpTarget.uri // empty' <<< "$job")"
  current_origin="${current_uri%/internal/experience-jobs/v1/drain}"
  current_audience="$(jq -r '.httpTarget.oidcToken.audience // empty' <<< "$job")"
  if [[ "$current_origin" != "$SERVICE_URL" || "$current_audience" != "$SERVICE_URL" ]]; then
    jq -e \
      --arg origin "$current_origin" \
      --arg suffix '/internal/experience-jobs/v1/drain' \
      --arg runtime "$JOBS" \
      --arg description 'Experience jobs drain (staging, #285). Resume only after deploying with STG_GUEST_BOOKING_ENABLED=true.' \
      --arg urls "$(jq -c '.metadata.annotations["run.googleapis.com/urls"] | fromjson' <<< "$state")" \
      '(.state == "PAUSED")
       and .schedule == "* * * * *"
       and .timeZone == "Etc/UTC"
       and .httpTarget.httpMethod == "POST"
       and .httpTarget.uri == ($origin + $suffix)
       and .httpTarget.oidcToken.audience == $origin
       and .httpTarget.oidcToken.serviceAccountEmail == $runtime
       and .attemptDeadline == "180s"
       and .description == $description
       and ((.retryConfig.retryCount // 0) == 0)
       and (($urls | fromjson | index($origin)) != null)' <<< "$job" >/dev/null || {
      echo "Existing Cloud Scheduler job ${SCHEDULER_JOB} is not a paused job using another published URL alias with otherwise expected settings; review it without changing it." >&2
      exit 1
    }
    gcloud scheduler jobs update http "$SCHEDULER_JOB" --project "$PROJECT" --location "$REGION" \
      --uri "$DRAIN_URI" --oidc-service-account-email "$JOBS" \
      --oidc-token-audience "$SERVICE_URL" --quiet
    job="$(gcloud scheduler jobs describe "$SCHEDULER_JOB" --project "$PROJECT" --location "$REGION" --format=json)"
  fi
fi
jq -e --arg uri "$DRAIN_URI" --arg sa "$JOBS" --arg audience "$SERVICE_URL" \
  '.state == "PAUSED" and .schedule == "* * * * *" and .timeZone == "Etc/UTC" and .httpTarget.uri == $uri and .httpTarget.httpMethod == "POST" and .httpTarget.oidcToken.serviceAccountEmail == $sa and .httpTarget.oidcToken.audience == $audience and .attemptDeadline == "180s" and ((.retryConfig.retryCount // 0) == 0)' <<< "$job" >/dev/null || {
  echo "Cloud Scheduler job ${SCHEDULER_JOB} does not match the paused staging configuration after setup." >&2
  exit 1
}
job_state="$(jq -r '.state' <<< "$job")"
if [[ "$created" == true && "$job_state" != PAUSED ]]; then
  echo "Cloud Scheduler job ${SCHEDULER_JOB} was created but is ${job_state}; pause it before continuing." >&2
  exit 1
fi
# Resource identifiers only. Secret values and versions are never read or printed.
cat <<EOF
Secret ${WEBHOOK_SECRET}: present (add the Stripe TEST webhook signing secret as a version from a safe terminal).
Runtime ${RUNTIME}: secretAccessor on ${WEBHOOK_SECRET} ${NIHO_SECRETS[*]}
Jobs identity: ${JOBS} (run.invoker on ${SERVICE} only)
Cloud Scheduler ${SCHEDULER_JOB} (${REGION}): ${job_state}. POST ${DRAIN_URI}
Set the STG_* Environment Variables in docs/host-calendar-staging.md, deploy, then resume this job.
EOF
