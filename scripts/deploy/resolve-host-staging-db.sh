#!/usr/bin/env bash
set -euo pipefail

cloudsql=
case "${DB_PROVIDER:-cloudsql}" in
  cloudsql)
    cloudsql=niho-app-stg:asia-northeast1:niho-app-db-stg
    if [[ "${CLOUDSQL:-}" != "$cloudsql" || ! "${DATABASE_REF:-}" =~ ^experience-stg-database-url:[1-9][0-9]*$ ]]; then
      echo "Cloud SQL staging requires its staging instance and a numbered Secret version." >&2
      exit 1
    fi
    ;;
  neon)
    if ! [[ "${DATABASE_REF:-}" =~ ^experience-stg-neon-database-url:[1-9][0-9]*$ ]]; then
      echo "Neon staging requires a numbered version of experience-stg-neon-database-url." >&2
      exit 1
    fi
    ;;
  *)
    echo "STG_HOST_DB_PROVIDER must be cloudsql or neon." >&2
    exit 1
    ;;
esac

printf 'cloudsql=%s\n' "$cloudsql" >>"${GITHUB_OUTPUT:?}"
