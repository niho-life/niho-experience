#!/usr/bin/env bash
set -euo pipefail

old=https://experience.niho.life
new=https://travel.niho.life

check() {
  local method="$1" path="$2" headers status location
  headers="$(curl --silent --show-error --max-time 15 --path-as-is --globoff \
    --request "$method" --output /dev/null --dump-header - "${old}${path}" | tr -d '\r')"
  status="$(awk '/^HTTP\// { status=$2 } END { print status }' <<< "$headers")"
  location="$(awk 'tolower($0) ~ /^location: / { sub(/^[^:]+: /, ""); print }' <<< "$headers")"
  if [[ "$status" != 301 || "$location" != "${new}${path}" ]]; then
    printf 'Redirect mismatch for %s %s (status %s)\n' "$method" "$path" "$status" >&2
    return 1
  fi
}

for path in / /experiences /experiences/community-dinner-with-locals /guides/example /ja/experiences \
  '/experiences/community-dinner-with-locals?utm_source=qr&utm_medium=print&checkout=cancelled' \
  '/ja/guides/%E9%8E%8C%E5%80%89/?tag=a&tag=b&q=%2F%3F%2B' /host /admin /bookings /robots.txt /sitemap.xml; do
  check GET "$path"
done
# Do not follow the 301. The POST probe uses a read-only path with no body or credentials.
check POST '/robots.txt?check=domain'
printf 'Verified 301 and exact Location for the legacy host.\n'
