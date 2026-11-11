import { defineConfig } from "vite"
import { viteSingleFile } from "vite-plugin-singlefile"

// The views' one document, with its script and styles inlined: a ui:// resource is a single HTML
// file with nothing else to fetch.
export default defineConfig({
  root: "src",
  plugins: [viteSingleFile()],
  build: { outDir: "../dist", emptyOutDir: true },
})
