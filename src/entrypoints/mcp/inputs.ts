import { z } from "zod"

// Input pieces the read, write and manage tools share, so a decimal reads the same everywhere.

export const decimal = z.string().regex(/^[0-9]+(\.[0-9]+)?$/, "a positive exact decimal such as 12.50")

/** What the bank charged in the principal currency for a movement in the other one. */
export const actualDebited = decimal.describe(
  "Only for a movement not in the principal currency (get_financial_context): what the bank actually charged in the principal currency, when it used its own rate (a USD purchase charged as 3690.00 on a NIO card); balances use it instead of converting"
)
