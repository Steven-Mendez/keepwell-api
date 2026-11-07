#!/usr/bin/env bash
# Publishes the built zips as new Lambda versions and points each function's `live` alias at them.
# Runs after `terraform apply` and the migrations, so new code never meets an old schema.
# Rollback: `aws lambda update-alias --function-name <fn> --name live --function-version <previous>`
# (docs/runbooks/rollback.md); the previous version is printed here.
# Usage: scripts/deploy-code.sh <api-function> <jobs-function>
set -euo pipefail

publish() {
  local fn="$1" zip="$2"
  local previous version
  previous=$(aws lambda get-alias --function-name "$fn" --name live --query FunctionVersion --output text)
  aws lambda update-function-code --function-name "$fn" --zip-file "fileb://$zip" > /dev/null
  aws lambda wait function-updated-v2 --function-name "$fn"
  version=$(aws lambda publish-version --function-name "$fn" --description "${GITHUB_SHA:-manual}" --query Version --output text)
  aws lambda update-alias --function-name "$fn" --name live --function-version "$version" > /dev/null
  echo "$fn: live $previous → $version (rollback target: $previous)"
}

publish "$1" dist/lambda-api.zip
publish "$2" dist/lambda-jobs.zip
