#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
mkdir -p "$TMP_DIR/bin"

cat > "$TMP_DIR/bin/gcloud" <<'MOCK_GCLOUD'
#!/usr/bin/env bash
set -euo pipefail

case "$*" in
  *"run services describe niho-experience"*)
    printf '%s\n' 'experience-runtime@niho-app-prd.iam.gserviceaccount.com'
    ;;
  *"secrets describe GMAIL_APP_PASSWORD"*)
    ;;
  *"secrets versions list GMAIL_APP_PASSWORD"*)
    printf '%s\n' 'projects/niho-app-prd/secrets/GMAIL_APP_PASSWORD/versions/7'
    ;;
  *"secrets describe experience-prd-smtp-user"*)
    exit 1
    ;;
  *"secrets create experience-prd-smtp-user"*)
    ;;
  *"secrets versions add experience-prd-smtp-user"*)
    cat >/dev/null
    ;;
  *"secrets versions list experience-prd-smtp-user"*)
    printf '%s\n' 'projects/niho-app-prd/secrets/experience-prd-smtp-user/versions/11'
    ;;
  *"secrets add-iam-policy-binding"*)
    ;;
  *"secrets get-iam-policy"*)
    printf '%s\n' '{"bindings":[{"role":"roles/secretmanager.secretAccessor","members":["serviceAccount:experience-runtime@niho-app-prd.iam.gserviceaccount.com"]}]}'
    ;;
  *)
    printf 'unexpected gcloud command: %s\n' "$*" >&2
    exit 1
    ;;
esac
MOCK_GCLOUD
chmod +x "$TMP_DIR/bin/gcloud"

output="$(PATH="$TMP_DIR/bin:$PATH" WORKSPACE_SMTP_USER_EMAIL=workspace-sender@niho.life \
  bash "$SCRIPT_DIR/setup-production-mail.sh")"
grep -Fx 'PROD_SMTP_USER_REF=experience-prd-smtp-user:11' <<<"$output" >/dev/null
grep -Fx 'PROD_SMTP_PASSWORD_REF=GMAIL_APP_PASSWORD:7' <<<"$output" >/dev/null
printf '%s\n' 'PASS: fully qualified Secret Manager version names resolve to numeric refs'
