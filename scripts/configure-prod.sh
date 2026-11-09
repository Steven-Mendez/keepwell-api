#!/usr/bin/env bash
# Puts production's secrets in SSM, reloads the API so it reads them, and waits for /health.
# Run it yourself (it asks for Apple's values; nothing is echoed or stored outside SSM):
#   scripts/configure-prod.sh
# Re-running it is safe: auth_secret is only generated when still the placeholder.
set -euo pipefail

prefix=/keepwell/prod
region=${AWS_REGION:-us-east-1}
api=https://a7j02lvk04.execute-api.us-east-1.amazonaws.com
put() { aws ssm put-parameter --region "$region" --overwrite --name "$prefix/$1" --type "$2" --value "$3" > /dev/null; echo "✔ $1"; }

aws sts get-caller-identity > /dev/null || { echo "AWS session expired: run 'aws login' first." >&2; exit 1; }

current=$(aws ssm get-parameter --region "$region" --with-decryption --name "$prefix/auth_secret" --query Parameter.Value --output text)
if [ "${#current}" -lt 32 ]; then put auth_secret SecureString "$(openssl rand -base64 48)"; else echo "· auth_secret already set"; fi

read -r -p "Apple Team ID (10 characters, Membership details): " team
read -r -p "Sign in with Apple key ID (10 characters): " key_id
read -r -p "Path to AuthKey_${key_id}.p8: " p8
read -r -p "Services ID (web, e.g. com.stevenmendez.keepwell.web): " services
read -r -p "iOS bundle ID [com.stevenmendez.keepwell]: " bundle
bundle=${bundle:-com.stevenmendez.keepwell}
[ -f "$p8" ] || { echo "No file at $p8" >&2; exit 1; }

put apple_team_id String "$team"
put apple_key_id String "$key_id"
put apple_private_key SecureString "$(cat "$p8")"
put apple_services_id String "$services"
put apple_bundle_id String "$bundle"

# Configuration is read at cold start; a description change recycles every instance.
aws lambda update-function-configuration --region "$region" --function-name keepwell-prod-api \
  --description "config reload $(date +%s)" > /dev/null
aws lambda wait function-updated --region "$region" --function-name keepwell-prod-api
echo "✔ API reloaded"

for attempt in 1 2 3 4 5 6; do
  body=$(curl -s "$api/health")
  echo "$body" | grep -q '"ok":true' && { echo "✔ /health: $body"; exit 0; }
  sleep 5
done
echo "✘ /health still says: $body" >&2
echo "  Logs: aws logs tail /aws/lambda/keepwell-prod-api --since 5m" >&2
exit 1
