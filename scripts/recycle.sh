#!/usr/bin/env bash
# Makes functions read SSM again, with the code they already run. Configuration is read at cold start,
# and each function's `live` alias points at a published version, so changing $LATEST (a new
# description) recycles nothing that serves traffic. This publishes $LATEST as a new version and moves
# `live` to it; the old instances drain away.
# The description change matters too: publishing an unchanged $LATEST returns the existing version.
# Rollback: `aws lambda update-alias --function-name <fn> --name live --function-version <previous>`.
# Usage: scripts/recycle.sh <function>...   e.g. scripts/recycle.sh keepwell-prod-api keepwell-prod-notifications
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <function>..." >&2
  exit 64
fi

for fn in "$@"; do
  previous=$(aws lambda get-alias --function-name "$fn" --name live --query FunctionVersion --output text)
  code=$(aws lambda get-function-configuration --function-name "$fn" --qualifier "$previous" --query CodeSha256 --output text)
  latest=$(aws lambda get-function-configuration --function-name "$fn" --query CodeSha256 --output text)
  # $LATEST holds what the last deploy uploaded; if it differs, publishing it would ship other code.
  if [ "$code" != "$latest" ]; then
    echo "$fn: \$LATEST's code differs from live version $previous; not publishing it" >&2
    exit 1
  fi
  aws lambda update-function-configuration --function-name "$fn" --description "reload $(date +%s)" > /dev/null
  aws lambda wait function-updated-v2 --function-name "$fn"
  version=$(aws lambda publish-version --function-name "$fn" --description "reload of version $previous" --query Version --output text)
  aws lambda update-alias --function-name "$fn" --name live --function-version "$version" > /dev/null
  echo "$fn: live $previous → $version (rollback target: $previous)"
done
