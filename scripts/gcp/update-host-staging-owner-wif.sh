#!/usr/bin/env bash
# Owner-run once after the owner-only GitHub Environment and workflow are ready.
set -euo pipefail

[[ "${CONFIRM_HOST_STAGING_OWNER_WIF:-}" == niho-app-stg ]] || {
  echo 'Set CONFIRM_HOST_STAGING_OWNER_WIF=niho-app-stg after reviewing the WIF change.' >&2
  exit 1
}
for tool in gcloud jq; do command -v "$tool" >/dev/null; done

PROJECT=niho-app-stg
POOL=experience-host-staging
PROVIDER=github
GITHUB_REPO_ID=1425500695
OLD_CONDITION="assertion.repository_id == '${GITHUB_REPO_ID}' && assertion.repository == 'niho-life/niho-experience' && assertion.ref == 'refs/heads/main' && assertion.environment == 'host-staging' && assertion.event_name == 'workflow_dispatch' && assertion.workflow_ref == 'niho-life/niho-experience/.github/workflows/deploy-host-staging.yml@refs/heads/main'"
NEW_CONDITION="assertion.repository_id == '${GITHUB_REPO_ID}' && assertion.repository == 'niho-life/niho-experience' && assertion.ref == 'refs/heads/main' && (assertion.environment == 'host-staging' || (assertion.environment == 'host-staging-owner' && assertion.actor_id in ['252574334', '119937906', '345803507'])) && assertion.event_name == 'workflow_dispatch' && assertion.workflow_ref == 'niho-life/niho-experience/.github/workflows/deploy-host-staging.yml@refs/heads/main'"

provider_state() {
  gcloud iam workload-identity-pools providers describe "$PROVIDER" \
    --project "$PROJECT" --location global --workload-identity-pool "$POOL" --format=json
}
verify_state() {
  local expected_condition="$1" state="$2"
  jq -e --arg condition "$expected_condition" '
    .attributeCondition == $condition
    and .oidc.issuerUri == "https://token.actions.githubusercontent.com"
    and .attributeMapping == {
      "google.subject": "assertion.sub",
      "attribute.repository_id": "assertion.repository_id",
      "attribute.ref": "assertion.ref",
      "attribute.environment": "assertion.environment"
    }
    and .disabled != true
  ' <<< "$state" >/dev/null
}

state="$(provider_state)"
if jq -e --arg condition "$NEW_CONDITION" '.attributeCondition == $condition' <<< "$state" >/dev/null; then
  verify_state "$NEW_CONDITION" "$state"
  echo 'Host staging owner WIF condition is already configured and verified.'
  exit 0
fi
verify_state "$OLD_CONDITION" "$state" || {
  echo 'WIF provider differs from the reviewed current policy; no change made.' >&2
  exit 1
}

gcloud iam workload-identity-pools providers update-oidc "$PROVIDER" \
  --project "$PROJECT" --location global --workload-identity-pool "$POOL" \
  --attribute-condition "$NEW_CONDITION"
state="$(provider_state)"
verify_state "$NEW_CONDITION" "$state"
echo 'Host staging owner WIF condition updated and verified.'
