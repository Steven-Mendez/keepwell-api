#!/usr/bin/env bash
# drizzle-kit writes the migration; dsql-lint rewrites it for DSQL (CREATE INDEX ASYNC, no USING,
# one statement per breakpoint). Exit code 3 from the transform means "fixed with advisories".
# Usage: pnpm db:generate [--custom] --name=<what_it_does>
set -euo pipefail
if ! printf '%s\n' "$@" | grep -q -- '--name'; then
  echo "Name the migration after what it does: pnpm db:generate --name=add_sync_tables" >&2
  exit 2
fi
npx drizzle-kit generate "$@"
latest=$(ls -t drizzle/migrations/*.sql | head -1)
set +e
npx aurora-dsql-drizzle transform "$latest" -o "$latest.dsql"
code=$?
set -e
if [ "$code" != 0 ] && [ "$code" != 3 ]; then rm -f "$latest.dsql"; exit "$code"; fi
mv "$latest.dsql" "$latest"
echo "Review $latest before committing: look for DROP or unintended RENAME."
