import { createDatabase, APP_ROLE } from "../../src/adapters/db/client"
import { adminUrl, TEST_DATABASE } from "./env"

/** The database as the API sees it: connected as `keepwell_app`, with that role's privileges. */
export function appDatabase() {
  return createDatabase({ kind: "postgres", url: adminUrl(TEST_DATABASE), role: APP_ROLE })
}

/** Superuser access for arranging fixtures and inspecting state behind the API's back. */
export function adminDatabase() {
  return createDatabase({ kind: "postgres", url: adminUrl(TEST_DATABASE) })
}
