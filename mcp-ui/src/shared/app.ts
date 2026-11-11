import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

import "./base.css"

export type Lang = "en" | "es"

export interface View<Data> {
  name: string
  /** Draws the tool's structured result. Called again whenever the view asks for new data. */
  render(data: Data, ctx: ViewContext): void
  /** The tool input, before the result arrives (the pending view shows what Claude is about to record). */
  input?(args: Record<string, unknown>, ctx: ViewContext): void
}

/** A view whatever its data; each one narrows the tool result it is given. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyView = View<any>

export interface ViewContext {
  app: App
  lang: Lang
  root: HTMLElement
  /** Calls one of Keepwell's tools from the view and renders its result in place. */
  reload(tool: string, args: Record<string, unknown>): Promise<void>
  canFullscreen: boolean
  isFullscreen: boolean
  toggleFullscreen(): Promise<void>
}

function languageOf(ctx: McpUiHostContext | undefined): Lang {
  const locale = ctx?.locale ?? navigator.language
  return locale.toLowerCase().startsWith("es") ? "es" : "en"
}

/**
 * Starts the views: handlers first, then connect at once (Claude waits at most 15 seconds for it), then
 * the host's theme, fonts and safe-area insets. Data arrives only through tool results and is
 * always rendered as text (never innerHTML), so a description can't become markup.
 */
export function startViews(pick: (tool: string | undefined) => AnyView): void {
  const root = document.getElementById("root")
  if (!root) throw new Error("#root is missing")
  const app = new App({ name: "Keepwell", version: "1.0.0" }, { availableDisplayModes: ["inline", "fullscreen"] })
  type Data = unknown
  let last: Data | undefined
  // Which tool this view was opened for: Claude sends it in the host context (toolInfo).
  const view = () => pick(app.getHostContext()?.toolInfo?.tool.name)

  const ctx: ViewContext = {
    app,
    lang: "en",
    root,
    canFullscreen: false,
    isFullscreen: false,
    async reload(tool, args) {
      root.setAttribute("aria-busy", "true")
      try {
        const result = await app.callServerTool({ name: tool, arguments: args })
        const data = dataOf<Data>(result)
        if (data) {
          last = data
          view().render(data, ctx)
        } else {
          showError(root, ctx.lang)
        }
      } catch {
        showError(root, ctx.lang)
      } finally {
        root.removeAttribute("aria-busy")
      }
    },
    async toggleFullscreen() {
      const { mode } = await app.requestDisplayMode({ mode: ctx.isFullscreen ? "inline" : "fullscreen" })
      applyContext({ displayMode: mode })
    },
  }

  const applyContext = (changed: Partial<McpUiHostContext>) => {
    if (changed.theme) applyDocumentTheme(changed.theme)
    if (changed.styles?.variables) applyHostStyleVariables(changed.styles.variables)
    if (changed.styles?.css?.fonts) applyHostFonts(changed.styles.css.fonts)
    if (changed.safeAreaInsets) {
      const { top, right, bottom, left } = changed.safeAreaInsets
      document.body.style.padding = `${top}px ${right}px ${bottom}px ${left}px`
    }
    const full = app.getHostContext()
    ctx.lang = languageOf(full)
    ctx.canFullscreen = (full?.availableDisplayModes ?? []).includes("fullscreen")
    ctx.isFullscreen = (changed.displayMode ?? full?.displayMode) === "fullscreen"
    document.documentElement.lang = ctx.lang
    document.documentElement.dataset.mode = ctx.isFullscreen ? "fullscreen" : "inline"
    if (last !== undefined) view().render(last, ctx)
  }

  app.ontoolinput = ({ arguments: args }) => view().input?.(args ?? {}, ctx)
  app.ontoolresult = (result) => {
    const data = dataOf<Data>(result)
    if (data) {
      last = data
      view().render(data, ctx)
    } else {
      showError(root, ctx.lang)
    }
  }
  app.onhostcontextchanged = applyContext

  void app.connect().then(() => applyContext(app.getHostContext() ?? {}))
}

function dataOf<Data>(result: CallToolResult): Data | undefined {
  if (result.isError) return undefined
  return result.structuredContent as Data | undefined
}

function showError(root: HTMLElement, lang: Lang) {
  root.replaceChildren(el("p", { class: "muted" }, lang === "es" ? "Keepwell no pudo responder. Intenta de nuevo." : "Keepwell couldn't answer. Try again."))
}

type Child = Node | string | null | undefined | false

/** A tiny element builder: attributes as strings, children as nodes or text. Text is always a text node. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
  for (const child of children) if (child) node.append(child)
  return node
}

/** A row of choices that stays visible (no menus): the selected one is marked for assistive tech too. */
export function segmented<T extends string | number>(label: string, options: { value: T; label: string }[], selected: T, onPick: (value: T) => void): HTMLElement {
  const group = el("div", { class: "segmented", role: "group", "aria-label": label })
  for (const option of options) {
    const button = el("button", { type: "button", "aria-pressed": String(option.value === selected) }, option.label)
    button.addEventListener("click", () => option.value !== selected && onPick(option.value))
    group.append(button)
  }
  return group
}

/** The expand / collapse button, only where the host offers fullscreen. */
export function fullscreenButton(ctx: ViewContext): HTMLElement | null {
  if (!ctx.canFullscreen) return null
  const label = ctx.isFullscreen ? (ctx.lang === "es" ? "Contraer" : "Collapse") : ctx.lang === "es" ? "Ver todo" : "See all"
  const button = el("button", { type: "button", class: "ghost" }, label)
  button.addEventListener("click", () => void ctx.toggleFullscreen())
  return button
}
