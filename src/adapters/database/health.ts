import { sql } from "drizzle-orm"

import type { Database } from "./client"

/** `GET /health`'s database check: a round trip, nothing more. */
export async function pingDatabase(db: Database): Promise<void> {
  await db.execute(sql`select 1`)
}
