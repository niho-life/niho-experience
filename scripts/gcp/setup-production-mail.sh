#!/usr/bin/env bash
# Prepare only the Experience production SMTP identity references and exact
# Secret Manager access. This does not read the Workspace app-password value.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-niho-app-prd}"
REGION="${REGION:-asia-northeast1}"
SERVICE="${SERVICE:-niho-experience}"
RUNTIME_SA="experience-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
USER_SECRET="experience-prd-smtp-user"
PASSWORD_SECRET="GMAIL_APP_PASSWORD"
SMTP_USER_EMAIL="${WORKSPACE_SMTP_USER_EMAIL:-}"

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

[[ "$PROJECT_ID" == niho-app-prd ]] || fail "This setup is restricted to project niho-app-prd"
[[ "$REGION" == asia-northeast1 && "$SERVICE" == niho-experience ]] || fail "Unexpected production service target"
[[ "$SMTP_USER_EMAIL" =~ ^[A-Za-z0-9._%+-]+@niho\.life$ ]] || fail "Set WORKSPACE_SMTP_USER_EMAIL to the approved NIHO Workspace sender"

actual_runtime_sa="$(gcloud run services describe "$SERVICE" \
  --project "$PROJECT_ID" --region "$REGION" \
  --format='value(spec.template.spec.serviceAccountName)')"
[[ "$actual_runtime_sa" == "$RUNTIME_SA" ]] || fail "Cloud Run runtime service account does not match the reviewed Experience identity"

gcloud secrets describe "$PASSWORD_SECRET" --project "$PROJECT_ID" >/dev/null \
  || fail "Expected existing Workspace app-password Secret was not found"

password_version_resource="$(gcloud secrets versions list "$PASSWORD_SECRET" --project "$PROJECT_ID" \
  --filter='state=ENABLED' --sort-by='~createTime' --limit=1 --format='value(name)')"
password_version="${password_version_resource##*/}"
[[ "$password_version" =~ ^[1-9][0-9]*$ ]] || fail "No enabled numeric version exists for the Workspace app-password Secret"

if ! gcloud secrets describe "$USER_SECRET" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud secrets create "$USER_SECRET" --project "$PROJECT_ID" \
    --replication-policy=automatic --quiet >/dev/null
fi

# Keep a fixed, numeric version so candidate and promotion use the same value.
printf '%s' "$SMTP_USER_EMAIL" | gcloud secrets versions add "$USER_SECRET" \
  --project "$PROJECT_ID" --data-file=- --quiet >/dev/null
user_version_resource="$(gcloud secrets versions list "$USER_SECRET" --project "$PROJECT_ID" \
  --filter='state=ENABLED' --sort-by='~createTime' --limit=1 --format='value(name)')"
user_version="${user_version_resource##*/}"
[[ "$user_version" =~ ^[1-9][0-9]*$ ]] || fail "Could not resolve a numeric SMTP user Secret version"

member="serviceAccount:${RUNTIME_SA}"
for secret_name in "$USER_SECRET" "$PASSWORD_SECRET"; do
  gcloud secrets add-iam-policy-binding "$secret_name" --project "$PROJECT_ID" \
    --member="$member" --role=roles/secretmanager.secretAccessor --condition=None --quiet >/dev/null
  gcloud secrets get-iam-policy "$secret_name" --project "$PROJECT_ID" --format=json \
    | jq -e --arg member "$member" '
        any(.bindings[]?; .role == "roles/secretmanager.secretAccessor" and any(.members[]?; . == $member))
      ' >/dev/null \
    || fail "Runtime Secret access read-back failed for ${secret_name}"
done

printf 'PROD_SMTP_USER_REF=%s:%s\n' "$USER_SECRET" "$user_version"
printf 'PROD_SMTP_PASSWORD_REF=%s:%s\n' "$PASSWORD_SECRET" "$password_version"
