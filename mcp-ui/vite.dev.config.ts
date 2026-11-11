import { defineConfig } from "vite"

// `pnpm --filter @keepwell/mcp-ui dev`: dev/host.html plays Claude's part (an AppBridge with sample
// tool results) around the views in src/, so they can be checked in both themes, both modes and at
// phone width without a tunnel.
export default defineConfig({ root: ".", server: { open: "/dev/host.html" } })
