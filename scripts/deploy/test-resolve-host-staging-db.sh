#!/usr/bin/env bash
set -euo pipefail
resolve="$(dirname "$0")/resolve-host-staging-db.sh"
export GITHUB_OUTPUT
GITHUB_OUTPUT="$(mktemp)"
trap 'rm -f "$GITHUB_OUTPUT"' EXIT
export CLOUDSQL=niho-app-stg:asia-northeast1:niho-app-db-stg
export DATABASE_REF=experience-stg-database-url:3

DB_PROVIDER='' bash "$resolve"
grep -Fx "cloudsql=$CLOUDSQL" "$GITHUB_OUTPUT"

: >"$GITHUB_OUTPUT"
DB_PROVIDER=neon DATABASE_REF=experience-stg-neon-database-url:1 bash "$resolve"
grep -Fx 'cloudsql=' "$GITHUB_OUTPUT"

reject() {
  : >"$GITHUB_OUTPUT"
  if bash "$resolve" 2>/dev/null; then
    echo 'Unexpected staging database settings were accepted.' >&2
    exit 1
  fi
  test ! -s "$GITHUB_OUTPUT"
}

DB_PROVIDER=neon reject
DB_PROVIDER=cloudsql DATABASE_REF=experience-stg-neon-database-url:1 reject
DB_PROVIDER=neon DATABASE_REF=experience-stg-neon-database-url:latest reject
CLOUDSQL=niho-app-prd:asia-northeast1:niho-app-db DB_PROVIDER=cloudsql reject
DB_PROVIDER=unknown reject
echo 'Host staging database contract self-test passed.'
