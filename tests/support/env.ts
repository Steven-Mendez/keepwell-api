export const TEST_DATABASE = "keepwell_test"

const base = process.env.TEST_POSTGRES_URL ?? "postgres://postgres:postgres@localhost:54329"

/** Superuser connection to `database`: migrations and test fixtures only. */
export function adminUrl(database: string): string {
  return `${base}/${database}`
}
