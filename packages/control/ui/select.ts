/**
 * A dropdown drawn in the app's theme. A native <select> can only be styled
 * while closed; its open list is the operating system's, so it never matches.
 *
 * Follows the select-only combobox pattern: a button that owns a listbox,
 * arrow keys move through the options, Enter or Space picks, Escape closes,
 * typing jumps to a matching option. With `searchable`, typing filters
 * instead, from a box at the top of the open list.
 */
import { h, replace } from "./dom"
import { icon } from "./icons"

export interface SelectOption<T extends string = string> {
  value: T
  label: string
  /** Shown to the right of the label in the open list, e.g. a price. */
  detail?: string
}

export interface SelectProps<T extends string> {
  /** The accessible name; the control has no visible label of its own. */
  label: string
  value: T | ""
  options: SelectOption<T>[]
  onChange: (value: T) => void
  placeholder?: string
  searchable?: boolean
  searchPlaceholder?: string
  /** Sets the trigger in the mono face, for identifiers. */
  mono?: boolean
}

export interface Select<T extends string> {
  el: HTMLElement
  value(): T | ""
  setOptions(options: SelectOption<T>[], value?: T | ""): void
  setDisabled(disabled: boolean): void
  setPlaceholder(text: string): void
}

const POPUP_MAX_H = 288
const VIEWPORT_GUTTER = 16

let nextId = 0

export function select<T extends string>(props: SelectProps<T>): Select<T> {
  const id = `select-${++nextId}`
  let options = props.options
  let value: T | "" = props.value
  let placeholder = props.placeholder ?? "Choose one"
  let visible: SelectOption<T>[] = options
  let active = -1
  let isOpen = false

  const valueText = h("span", { class: "select-value" })
  const trigger = h(
    "button",
    {
      type: "button",
      class: `select-trigger${props.mono ? " input-mono" : ""}`,
      role: "combobox",
      "aria-haspopup": "listbox",
      "aria-expanded": "false",
      "aria-controls": `${id}-list`,
      "aria-label": props.label,
    },
    valueText,
    icon("chevron"),
  )
  const list = h("ul", { class: "select-list", role: "listbox", id: `${id}-list`, "aria-label": props.label })
  const search = props.searchable
    ? h("input", {
        type: "text",
        class: "select-search-input",
        role: "combobox",
        "aria-autocomplete": "list",
        "aria-expanded": "true",
        "aria-controls": `${id}-list`,
        "aria-label": props.searchPlaceholder ?? "Search",
        placeholder: props.searchPlaceholder ?? "Search",
        autocomplete: "off",
        spellcheck: "false",
      })
    : null
  const popup = h(
    "div",
    { class: "select-popup", hidden: true },
    search ? h("div", { class: "select-search" }, icon("search"), search) : null,
    list,
  )
  const root = h("div", { class: "select" }, trigger, popup)
  const focusOwner = () => search ?? trigger

  const drawValue = () => {
    const selected = options.find((o) => o.value === value)
    valueText.textContent = selected?.label ?? placeholder
    valueText.classList.toggle("is-placeholder", !selected)
  }

  const setActive = (index: number) => {
    active = index
    list.querySelectorAll<HTMLElement>("[role=option]").forEach((el, i) => el.classList.toggle("is-active", i === index))
    const el = index >= 0 ? list.querySelector<HTMLElement>(`#${id}-opt-${index}`) : null
    if (el) {
      focusOwner().setAttribute("aria-activedescendant", el.id)
      el.scrollIntoView({ block: "nearest" })
    } else focusOwner().removeAttribute("aria-activedescendant")
  }

  const drawList = () => {
    const query = search?.value.trim().toLowerCase() ?? ""
    visible = query
      ? options.filter((o) => o.label.toLowerCase().includes(query) || o.value.toLowerCase().includes(query))
      : options
    replace(
      list,
      ...(visible.length
        ? visible.map((o, i) => {
            const selected = o.value === value
            const item = h(
              "li",
              { id: `${id}-opt-${i}`, role: "option", class: "select-option", "aria-selected": selected ? "true" : "false" },
              h("span", { class: "select-option-label" }, o.label),
              o.detail ? h("span", { class: "select-option-detail" }, o.detail) : null,
              selected ? icon("check") : h("span", { class: "select-check-space" }),
            )
            // Picking with the pointer must not move focus out of the control first.
            item.addEventListener("mousedown", (e) => e.preventDefault())
            item.addEventListener("click", () => choose(o.value))
            item.addEventListener("mousemove", () => active !== i && setActive(i))
            return item
          })
        : [h("li", { class: "select-empty", role: "presentation" }, "Nothing matches")]),
    )
  }

  // Opens downward unless the page runs out below, and slides left as far as it must to stay on screen.
  const place = () => {
    popup.classList.remove("is-above")
    popup.style.left = ""
    const box = trigger.getBoundingClientRect()
    if (window.innerHeight - box.bottom < POPUP_MAX_H && box.top > window.innerHeight - box.bottom) popup.classList.add("is-above")
    const overflow = box.left + popup.offsetWidth - (window.innerWidth - VIEWPORT_GUTTER)
    if (overflow > 0) popup.style.left = `${-Math.min(overflow, Math.max(0, box.left - VIEWPORT_GUTTER))}px`
  }

  const onOutside = (e: PointerEvent) => {
    if (!root.contains(e.target as Node)) close(false)
  }

  const open = () => {
    if (isOpen || trigger.disabled) return
    isOpen = true
    if (search) search.value = ""
    drawList()
    popup.hidden = false
    root.classList.add("is-open")
    trigger.setAttribute("aria-expanded", "true")
    place()
    search?.focus()
    setActive(Math.max(0, visible.findIndex((o) => o.value === value)))
    document.addEventListener("pointerdown", onOutside, true)
  }

  const close = (refocus: boolean) => {
    if (!isOpen) return
    isOpen = false
    popup.hidden = true
    root.classList.remove("is-open")
    trigger.setAttribute("aria-expanded", "false")
    focusOwner().removeAttribute("aria-activedescendant")
    document.removeEventListener("pointerdown", onOutside, true)
    if (refocus) trigger.focus()
  }

  const choose = (next: T) => {
    const changed = next !== value
    value = next
    drawValue()
    close(true)
    if (changed) props.onChange(next)
  }

  // Jumps to the next option starting with the typed letter, wrapping around.
  const typeAhead = (char: string) => {
    const lower = char.toLowerCase()
    for (let step = 1; step <= visible.length; step++) {
      const i = (active + step) % visible.length
      if (visible[i].label.toLowerCase().startsWith(lower)) return setActive(i)
    }
  }

  const onKey = (e: KeyboardEvent) => {
    const fromSearch = e.currentTarget === search
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp": {
        e.preventDefault()
        if (!isOpen) return open()
        const step = e.key === "ArrowDown" ? 1 : -1
        return setActive(Math.min(visible.length - 1, Math.max(0, active + step)))
      }
      case "Home":
      case "End":
        if (!isOpen || fromSearch) return
        e.preventDefault()
        return setActive(e.key === "Home" ? 0 : visible.length - 1)
      case "Enter":
        // Never lets Enter fall through to submit the surrounding form.
        if (!isOpen) return
        e.preventDefault()
        if (visible[active]) choose(visible[active].value)
        return
      case " ":
        if (!isOpen || fromSearch) return
        e.preventDefault()
        if (visible[active]) choose(visible[active].value)
        return
      case "Escape":
        if (!isOpen) return
        e.preventDefault()
        e.stopPropagation()
        return close(true)
      case "Tab":
        return close(false)
    }
    if (fromSearch || e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return
    e.preventDefault()
    if (search) {
      open()
      search.value = e.key
      drawList()
      return setActive(visible.length ? 0 : -1)
    }
    if (!isOpen) open()
    typeAhead(e.key)
  }

  trigger.addEventListener("click", () => (isOpen ? close(true) : open()))
  trigger.addEventListener("keydown", onKey)
  search?.addEventListener("keydown", onKey)
  search?.addEventListener("input", () => {
    drawList()
    setActive(visible.length ? 0 : -1)
  })
  root.addEventListener("focusout", (e) => {
    if (!root.contains(e.relatedTarget as Node | null)) close(false)
  })

  drawValue()
  return {
    el: root,
    value: () => value,
    setOptions(next, nextValue) {
      options = next
      if (nextValue !== undefined) value = nextValue
      drawValue()
      if (isOpen) drawList()
    },
    setDisabled(disabled) {
      if (disabled) close(false)
      trigger.disabled = disabled
    },
    setPlaceholder(text) {
      placeholder = text
      drawValue()
    },
  }
}
