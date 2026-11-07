#!/usr/bin/env bash
# The TypeScript schema and the committed migrations must describe the same database: if
# drizzle-kit would generate a new migration from the current schema, someone changed schema.ts
# without generating one. Also runs drizzle-kit check (snapshot consistency).
set -euo pipefail
npx drizzle-kit check
before=$(ls drizzle/migrations/*.sql | wc -l)
npx drizzle-kit generate --name=drift_check > /dev/null
after=$(ls drizzle/migrations/*.sql | wc -l)
if [ "$after" != "$before" ]; then
  git checkout -- drizzle/migrations/meta
  git clean -fq drizzle/migrations
  echo "schema.ts has changes with no migration: run pnpm db:generate --name=<what_changed>" >&2
  exit 1
fi
echo "Schema and migrations agree"
