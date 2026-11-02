#!/usr/bin/env bash
set -euo pipefail

case "${GITHUB_ACTOR_ID:-}" in
  252574334|345803507|119937906) ;;
  *) echo "Production deployment requires an owner account ID." >&2; exit 1 ;;
esac
case "${GITHUB_TRIGGERING_ACTOR:-}" in
  niho3|taku-niho|takuyatakahama3) ;;
  *) echo "Production deployment reruns require an owner account." >&2; exit 1 ;;
esac
