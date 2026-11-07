#!/usr/bin/env bash
# drizzle-kit writes the migration; dsql-lint rewrites it for DSQL (CREATE INDEX ASYNC, no USING,
# one statement per breakpoint). Exit code 3 from the transform means "fixed with advisories".
# Usage: pnpm db:generate [--custom] --name=<what_it_does>
set -euo pipefail
npx drizzle-kit generate "$@"
latest=$(ls -t drizzle/*.sql | head -1)
set +e
npx aurora-dsql-drizzle transform "$latest" -o "$latest.dsql"
code=$?
set -e
if [ "$code" != 0 ] && [ "$code" != 3 ]; then rm -f "$latest.dsql"; exit "$code"; fi
mv "$latest.dsql" "$latest"
echo "Review $latest before committing."
