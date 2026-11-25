#!/bin/sh
# Starts the image twice with different settings and checks that pages render
# and that settings apply at run time (one image, many environments).
# Usage: scripts/container-smoke.sh <image> [approved CSP API origin]
set -eu
image="$1"
expected_api_origin="${2:-https://niho.life}"
port=18080
name="niho-experience-smoke"

cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

start() {
  cleanup
  docker run -d --name "$name" -p "$port:8080" "$@" "$image" >/dev/null
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$port/robots.txt" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  docker logs "$name" >&2
  echo "container did not start" >&2
  exit 1
}

check() {
  path="$1"; expected="$2"
  body=$(curl -fsS "http://127.0.0.1:$port$path")
  if ! printf '%s' "$body" | grep -F -- "$expected" >/dev/null; then
    echo "FAIL $path: expected \"$expected\"" >&2
    exit 1
  fi
  echo "ok   $path contains \"$expected\""
}

start -e SITE_INDEXING=block -e NIHO_HOST_START_URL=https://niho.life/experiences/provider
check / "Meet the people who make Kamakura"
# Runtime API settings cannot repair CSP compiled into the image.
csp="$(curl -fsS -D - -o /dev/null "http://127.0.0.1:$port/" | tr -d '\r' | awk 'tolower($0) ~ /^content-security-policy:/ {sub(/^[^:]*: */, ""); print}')"
connect_sources="$(printf '%s\n' "$csp" | tr ';' '\n' | awk '{$1=$1}; $1 == "connect-src" {for (i=2; i<=NF; i++) print $i; exit}')"
printf '%s\n' "$connect_sources" | grep -Fx -- "$expected_api_origin" >/dev/null
echo "ok   CSP permits the approved API origin"
check /experiences/home-cooked-dinner-with-locals "Home-cooked dinner with locals in a shared living room"
check /robots.txt "Disallow: /"
check /host "Share what you love about Kamakura"
check /host 'href="https://niho.life/experiences/provider"'
test "$(docker exec "$name" id -u)" != "0" && echo "ok   runs as a non-root user"

# Settings switch at run time. Indexing stays blocked because this image serves sample data.
start -e SITE_INDEXING=allow -e HOST_SIGNUP_MODE=open \
  -e NEXT_PUBLIC_NIHO_WEB_ORIGIN=https://niho.example.com \
  -e NIHO_HOST_START_URL=https://niho.example.com/experiences/provider \
  -e BOOKINGS_ENABLED=false
check /host "Start with your NIHO account"
check /robots.txt "Disallow: /"
check /experiences/home-cooked-dinner-with-locals/book "Online booking is paused for now"
echo "container smoke test passed"
