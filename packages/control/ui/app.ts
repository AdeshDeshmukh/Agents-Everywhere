import { api, ApiError, setCsrfToken } from "./api"
import { field, h, replace } from "./dom"
import { icon } from "./icons"
import { button, iconButton } from "./shared"
import { renderDetail } from "./views/detail"
import { renderForm } from "./views/form"
import { renderList } from "./views/list"
import { renderRun } from "./views/run"
import { renderGlobalConfig } from "./views/config"

const root = document.getElementById("app")!
let cleanup: (() => void) | void = undefined

// ── Theme ─────────────────────────────────────────────────────────────────
// Follows the OS until chosen; the choice is a per-browser convenience, so a
// storage failure just means following the OS again.
const THEME_KEY = "ae-theme"

function storedTheme(): "light" | "dark" | null {
  try {
    const value = localStorage.getItem(THEME_KEY)
    return value === "light" || value === "dark" ? value : null
  } catch {
    return null
  }
}

function effectiveTheme(): "light" | "dark" {
  return storedTheme() ?? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
}

function applyTheme(theme: "light" | "dark" | null) {
  if (theme) document.documentElement.dataset.theme = theme
  else delete document.documentElement.dataset.theme
}

function toggleTheme(button: HTMLButtonElement) {
  const next = effectiveTheme() === "dark" ? "light" : "dark"
  try {
    localStorage.setItem(THEME_KEY, next)
  } catch {
    /* the toggle still works for this page */
  }
  applyTheme(next)
  labelThemeButton(button)
}

function labelThemeButton(button: HTMLButtonElement) {
  const light = effectiveTheme() === "light"
  const label = light ? "Switch to dark theme" : "Switch to light theme"
  button.setAttribute("aria-label", label)
  button.title = label
  button.replaceChildren(icon(light ? "moon" : "sun"))
}

applyTheme(storedTheme())

// ── Shell ─────────────────────────────────────────────────────────────────

function brand(): HTMLElement {
  return h(
    "a",
    { class: "brand", href: "#/" },
    h("img", { src: "/logo.svg", alt: "", width: 20, height: 24 }),
    h("span", { class: "brand-name" }, "Agents Everywhere"),
    h("span", { class: "tag" }, "by Codity"),
  )
}

function shell(signedIn: boolean): HTMLElement {
  const main = h("main", { id: "content", tabindex: -1 })
  const theme = iconButton("sun", "Switch theme", () => toggleTheme(theme), "ghost")
  labelThemeButton(theme)
  const signOut = signedIn
    ? iconButton(
        "logout",
        "Sign out",
        async () => {
          await api.delete("/api/session").catch(() => {})
          await start()
        },
        "ghost",
      )
    : null
  replace(root, h("header", { class: "topbar" }, brand(), h("div", { class: "topbar-actions" }, signedIn ? h("a", { class: "btn btn-ghost", href: "#/config" }, "Global config") : null, theme, signOut)), main)
  return main
}

function renderSignIn(main: HTMLElement) {
  const token = h("input", { type: "password", required: true, autocomplete: "current-password", class: "input input-mono" })
  const error = h("div", { class: "notice", "data-tone": "error", role: "alert", hidden: true })
  const submit = button("Sign in", { type: "submit", variant: "primary" })
  const form = h(
    "form",
    { class: "panel signin" },
    h(
      "div",
      { class: "panel-body stack" },
      h(
        "div",
        { class: "signin-head" },
        h("img", { src: "/logo.svg", alt: "Codity", width: 26, height: 31 }),
        h("div", {}, h("strong", {}, "Agents Everywhere"), h("span", { class: "hint" }, "Self-hosted control plane")),
      ),
      field("Admin token", token, "The token the control plane printed the first time it started."),
      error,
      submit,
    ),
  )
  form.addEventListener("submit", async (event) => {
    event.preventDefault()
    submit.disabled = true
    try {
      const session = await api.post<{ csrf_token: string }>("/api/session", { token: token.value })
      setCsrfToken(session.csrf_token)
      await start()
    } catch (err) {
      error.hidden = false
      replace(error, err instanceof ApiError ? err.message : String(err))
      submit.disabled = false
    }
  })
  replace(main, form)
  token.focus()
}

async function route(main: HTMLElement) {
  if (typeof cleanup === "function") cleanup()
  cleanup = undefined
  const parts = (location.hash || "#/").slice(1).split("/").filter(Boolean)
  try {
    if (parts.length === 0) cleanup = await renderList(main)
    else if (parts[0] === "new") await renderForm(main)
    else if (parts[0] === "config") await renderGlobalConfig(main)
    else if (parts[0] === "agents" && parts.length === 2) cleanup = await renderDetail(main, parts[1])
    else if (parts[0] === "agents" && parts[2] === "edit") await renderForm(main, parts[1])
    else if (parts[0] === "agents" && parts[2] === "runs" && parts[3]) cleanup = await renderRun(main, parts[1], parts[3])
    else throw new ApiError(404, "There is no page at this address.")
    document.title = `${main.querySelector("h1")?.textContent ?? "Agents"} - Agents Everywhere`
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return
    replace(
      main,
      h(
        "section",
        { class: "panel empty" },
        h("h2", {}, err instanceof ApiError && err.status === 404 ? "Not found" : "Something went wrong"),
        h("p", {}, err instanceof Error ? err.message : String(err)),
        h("a", { class: "btn", href: "#/" }, "Back to agents"),
      ),
    )
  }
}

let onHashChange: (() => void) | undefined

async function start() {
  const session = await api.get<{ signed_in: boolean; csrf_token?: string }>("/api/session")
  if (onHashChange) window.removeEventListener("hashchange", onHashChange)
  const main = shell(session.signed_in)
  if (!session.signed_in) {
    renderSignIn(main)
    return
  }
  setCsrfToken(session.csrf_token ?? "")
  onHashChange = () => {
    void route(main)
    main.focus({ preventScroll: true })
  }
  window.addEventListener("hashchange", onHashChange)
  await route(main)
}

window.addEventListener("signed-out", () => void start())
void start()
