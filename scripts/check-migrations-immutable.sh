#!/usr/bin/env bash
# A migration that reached main may already be applied somewhere: it is never edited, renamed or
# deleted. Fix forward with a new migration. Usage: scripts/check-migrations-immutable.sh <base-ref>
set -euo pipefail
base="${1:-origin/main}"
changed=$(git diff --name-status "$base"...HEAD -- drizzle/migrations ':!drizzle/migrations/meta' | grep -v '^A' || true)
if [ -n "$changed" ]; then
  echo "These migrations already exist on $base and must not change:" >&2
  echo "$changed" >&2
  exit 1
fi
echo "Migrations: only additions"
