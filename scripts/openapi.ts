// Writes docs/openapi.json from the running Zod schemas.
import { writeFileSync } from "node:fs"

import { openApiDocument } from "../src/entrypoints/http/openapi"

writeFileSync("docs/openapi.json", JSON.stringify(openApiDocument(), null, 2) + "\n")
console.log("docs/openapi.json written")
