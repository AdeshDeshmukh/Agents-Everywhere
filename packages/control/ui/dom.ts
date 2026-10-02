/**
 * Builds DOM nodes. Text always goes in as text, never as markup: transcripts
 * and approval details carry words an agent's model wrote on someone's machine.
 */
type Child = Node | string | number | null | undefined | false
type Attrs = Record<string, string | number | boolean | EventListener | null | undefined>

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue
    if (name.startsWith("on") && typeof value === "function") {
      el.addEventListener(name.slice(2).toLowerCase(), value)
    } else if (name === "class") {
      el.className = String(value)
    } else if (value === true) {
      el.setAttribute(name, "")
    } else {
      el.setAttribute(name, String(value))
    }
  }
  append(el, children)
  return el
}

export function append(parent: Node, children: Child[]) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    parent.appendChild(
      typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child,
    )
  }
}

export function replace(parent: Element, ...children: Child[]) {
  parent.replaceChildren()
  append(parent, children)
}

let toastTimer: ReturnType<typeof setTimeout> | undefined
/** A short confirmation, announced to screen readers. */
export function toast(message: string) {
  document.querySelector(".toast")?.remove()
  const el = h("div", { class: "toast", role: "status" }, message)
  document.body.appendChild(el)
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.remove(), 3000)
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })
export function ago(iso: string | null): string {
  if (!iso) return "never"
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000)
  const abs = Math.abs(seconds)
  if (abs < 60) return rtf.format(seconds, "second")
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute")
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), "hour")
  return rtf.format(Math.round(seconds / 86400), "day")
}

const renderedKeys = new WeakMap<Element, string>()

/**
 * Replaces a region's content only when `key` says the data behind it changed.
 * A refresh that rebuilds unchanged controls takes keyboard focus away from
 * whoever was about to press one.
 */
export function replaceIfChanged(parent: Element, key: string, render: () => Child[]): boolean {
  if (renderedKeys.get(parent) === key) return false
  renderedKeys.set(parent, key)
  replace(parent, ...render())
  return true
}

/** A relative time that refreshTimes keeps current without re-rendering around it. */
export function agoNode(iso: string | null, attrs: Record<string, string> = {}): HTMLElement {
  return h("span", { ...attrs, "data-ago": iso ?? "" }, ago(iso))
}

export function refreshTimes(root: Element) {
  root.querySelectorAll<HTMLElement>("[data-ago]").forEach((el) => {
    el.textContent = ago(el.dataset.ago || null)
  })
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })
}

export function money(value: number): string {
  return `$${value.toFixed(value > 0 && value < 0.01 ? 4 : 2)}`
}

export function field(labelText: string, control: HTMLElement, hint?: string): HTMLElement {
  const id = control.id || `f-${Math.random().toString(36).slice(2)}`
  control.id = id
  return h(
    "div",
    { class: "field" },
    h("label", { for: id }, labelText, hint ? h("span", { class: "hint" }, hint) : null),
    control,
  )
}
