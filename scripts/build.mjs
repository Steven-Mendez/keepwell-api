// Bundles each Lambda entrypoint into one ESM file for Node 22 on arm64, then zips it. What isn't
// imported isn't deployed. The zip is what Terraform uploads.
import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { build } from "esbuild"

const entries = { api: "src/entrypoints/lambda.ts", jobs: "src/entrypoints/jobs.ts" }
const out = "dist"
rmSync(out, { recursive: true, force: true })

for (const [name, entry] of Object.entries(entries)) {
  const dir = join(out, name)
  mkdirSync(dir, { recursive: true })
  const result = await build({
    entryPoints: [entry],
    outfile: join(dir, "index.mjs"),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    minify: true,
    sourcemap: "linked",
    metafile: true,
    legalComments: "none",
    // Some CommonJS dependencies call require(); ESM output needs it defined.
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  })
  writeFileSync(join(dir, "meta.json"), JSON.stringify(result.metafile))
  execFileSync("zip", ["-q", "-j", join("..", `lambda-${name}.zip`), "index.mjs", "index.mjs.map"], { cwd: dir })
  const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0)
  console.log(`${name}: ${(bytes / 1024).toFixed(0)} KiB → dist/lambda-${name}.zip`)
}
