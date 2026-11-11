import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge"
import type { McpUiDisplayMode, McpUiHostContext } from "@modelcontextprotocol/ext-apps"

import { FIXTURES } from "./fixtures"

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const toolSelect = $<HTMLSelectElement>("tool")
for (const name of Object.keys(FIXTURES)) toolSelect.append(new Option(name, name))

// ?tool=…&lang=…&theme=…&width=… preselect the controls, for screenshots.
const params = new URLSearchParams(location.search)
for (const id of ["tool", "lang", "theme", "width"]) {
  const value = params.get(id)
  if (value) $<HTMLSelectElement>(id).value = value
}

let mode: McpUiDisplayMode = "inline"

async function mount() {
  const tool = toolSelect.value
  const fixture = FIXTURES[tool]!
  const theme = $<HTMLSelectElement>("theme").value as "light" | "dark"
  document.body.classList.toggle("dark", theme === "dark")
  const frame = $("frame")
  frame.style.maxWidth = mode === "fullscreen" ? "none" : `${$<HTMLSelectElement>("width").value}px`
  // Listen before the view loads: it says hello as soon as its script runs.
  const iframe = document.createElement("iframe")
  iframe.style.height = mode === "fullscreen" ? "80vh" : "520px"
  frame.replaceChildren(iframe)

  const context: McpUiHostContext = {
    theme,
    locale: $<HTMLSelectElement>("lang").value,
    displayMode: mode,
    availableDisplayModes: ["inline", "fullscreen"],
    platform: "web",
    toolInfo: { tool: { name: tool, inputSchema: { type: "object" } } },
  }
  const bridge = new AppBridge(null, { name: "dev-host", version: "1" }, { serverTools: {} }, { hostContext: context })
  bridge.oncalltool = async ({ name, arguments: args }) => {
    console.log("view called", name, args)
    return FIXTURES[name]?.result(args ?? {}) ?? { isError: true, content: [{ type: "text", text: "unknown tool" }] }
  }
  bridge.onrequestdisplaymode = async ({ mode: requested }) => {
    mode = requested
    $("mode").textContent = mode
    void mount()
    return { mode }
  }
  bridge.oninitialized = () => {
    if (fixture.input) void bridge.sendToolInput({ arguments: fixture.input })
    void bridge.sendToolResult(fixture.result(fixture.input ?? {}))
  }
  await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!))
  iframe.src = "/src/index.html"
}

for (const id of ["tool", "lang", "theme", "width"]) $(id).addEventListener("change", () => void mount())
void mount()
