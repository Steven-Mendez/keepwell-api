#!/usr/bin/env bash
# Publishes the built zips as new Lambda versions and points each function's `live` alias at them.
# Runs after `terraform apply` and the migrations, so new code never meets an old schema.
# Rollback: `aws lambda update-alias --function-name <fn> --name live --function-version <previous>`
# (docs/runbooks/rollback.md); the previous version is printed here.
# Usage: scripts/deploy-code.sh <api-function> <jobs-function> <notifications-function>
set -euo pipefail

# Provisioned concurrency follows the alias to the new version; the instances warm up in the
# background. Waits until they are ready so the smoke test (and the first users) meet a warm one.
# A no-op when the alias has none. Slow or failed warm-up only warns: the alias already moved, and
# requests that find no warm instance just start one.
wait_provisioned() {
  local fn="$1" status allocated requested
  for _ in $(seq 1 60); do
    if ! status=$(aws lambda get-provisioned-concurrency-config --function-name "$fn" --qualifier live \
      --query '[Status,AllocatedProvisionedConcurrentExecutions,RequestedProvisionedConcurrentExecutions]' --output text 2>/dev/null); then
      return 0
    fi
    read -r status allocated requested <<< "$status"
    if [ "$status" = READY ] && [ "$allocated" = "$requested" ]; then
      echo "$fn: provisioned concurrency ready ($allocated)"
      return 0
    fi
    if [ "$status" = FAILED ]; then break; fi
    sleep 5
  done
  echo "::warning::$fn: provisioned concurrency not ready (status: $status); continuing without it"
}

publish() {
  local fn="$1" zip="$2" wait="${3:-}"
  local previous version
  previous=$(aws lambda get-alias --function-name "$fn" --name live --query FunctionVersion --output text)
  aws lambda update-function-code --function-name "$fn" --zip-file "fileb://$zip" > /dev/null
  aws lambda wait function-updated-v2 --function-name "$fn"
  version=$(aws lambda publish-version --function-name "$fn" --description "${GITHUB_SHA:-manual}" --query Version --output text)
  aws lambda update-alias --function-name "$fn" --name live --function-version "$version" > /dev/null
  echo "$fn: live $previous → $version (rollback target: $previous)"
  if [ -n "$wait" ]; then wait_provisioned "$fn"; fi
}

publish "$1" dist/lambda-api.zip wait
publish "$2" dist/lambda-jobs.zip
publish "$3" dist/lambda-notifications.zip
