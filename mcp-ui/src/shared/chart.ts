import { el } from "./app"

const SVG = "http://www.w3.org/2000/svg"

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value))
  return node
}

/** A horizontal bar for a share of a whole, drawn with CSS so it follows the container's width. */
export function meter(ratio: number, tone: "accent" | "warning" | "danger" = "accent"): HTMLElement {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0))
  const bar = el("div", { class: "meter", "aria-hidden": "true" })
  bar.append(el("div", { class: `meter-fill ${tone}`, style: `width:${(clamped * 100).toFixed(1)}%` }))
  return bar
}

export interface Series {
  label: string
  values: number[]
  className: string
}

/**
 * Grouped columns, one group per month, scaled to the largest value. The numbers themselves are in
 * the table the caller puts next to it, so the chart is decorative for screen readers except for its
 * summary label.
 */
export function columns(labels: string[], series: Series[], summary: string): SVGSVGElement {
  const width = 600
  const height = 180
  const pad = 22
  const max = Math.max(1, ...series.flatMap((s) => s.values.map((v) => Math.abs(v))))
  const group = (width - 8) / Math.max(1, labels.length)
  const bar = Math.max(3, Math.min(18, (group - 10) / series.length))
  const chart = svg("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": summary, class: "chart", preserveAspectRatio: "none" })
  const baseline = height - pad
  chart.append(svg("line", { x1: 0, x2: width, y1: baseline, y2: baseline, class: "axis" }))
  labels.forEach((label, index) => {
    const left = 4 + index * group + (group - bar * series.length) / 2
    series.forEach((s, at) => {
      const value = Math.max(0, s.values[index] ?? 0)
      const h = (value / max) * (baseline - 6)
      chart.append(svg("rect", { x: left + at * bar, y: baseline - h, width: bar - 2, height: h, rx: 2, class: s.className }))
    })
    const text = svg("text", { x: 4 + index * group + group / 2, y: height - 6, "text-anchor": "middle", class: "tick" })
    text.textContent = label
    chart.append(text)
  })
  return chart
}
