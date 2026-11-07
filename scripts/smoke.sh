#!/usr/bin/env bash
# Unauthenticated checks against a deployed environment: the right version answers and its
# security headers are present. Usage: scripts/smoke.sh <base-url> <expected-sha>
set -euo pipefail
base="${1%/}"
sha="$2"

for attempt in 1 2 3 4 5; do
  if body=$(curl -fsS --max-time 10 -D /tmp/smoke-headers "$base/health"); then break; fi
  [ "$attempt" = 5 ] && { echo "health never answered"; exit 1; }
  sleep 3
done

echo "$body"
echo "$body" | jq -e --arg sha "$sha" '.ok == true and .version == $sha' > /dev/null || { echo "unexpected health body"; exit 1; }
for header in strict-transport-security x-content-type-options referrer-policy x-request-id; do
  grep -qi "^$header:" /tmp/smoke-headers || { echo "missing header $header"; exit 1; }
done
echo "smoke test passed"
