import { z } from "zod"

// Input pieces the read, write and manage tools share, so a decimal reads the same everywhere.

export const decimal = z.string().regex(/^[0-9]+(\.[0-9]+)?$/, "a positive exact decimal such as 12.50")
