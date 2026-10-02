/**
 * The few icons the UI uses, as Lucide draws them (ISC license), built with
 * DOM calls rather than markup strings.
 */
type Shape = ["path", string] | ["circle", number, number, number] | ["rect", number, number, number, number, number]

const ICONS = {
  plus: [
    ["path", "M5 12h14"],
    ["path", "M12 5v14"],
  ],
  x: [
    ["path", "M18 6 6 18"],
    ["path", "m6 6 12 12"],
  ],
  copy: [
    ["rect", 8, 8, 14, 14, 2],
    ["path", "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"],
  ],
  check: [["path", "M20 6 9 17l-5-5"]],
  chevron: [["path", "m6 9 6 6 6-6"]],
  sun: [
    ["circle", 12, 12, 4],
    ["path", "M12 2v2M12 20v2m-7.07-17.07 1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"],
  ],
  moon: [["path", "M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"]],
  logout: [
    ["path", "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"],
    ["path", "m16 17 5-5-5-5"],
    ["path", "M21 12H9"],
  ],
  stop: [["rect", 5, 5, 14, 14, 2]],
  send: [
    ["path", "M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"],
    ["path", "m21.854 2.147-10.94 10.939"],
  ],
  pencil: [
    ["path", "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"],
    ["path", "m15 5 4 4"],
  ],
  ban: [
    ["circle", 12, 12, 10],
    ["path", "m4.9 4.9 14.2 14.2"],
  ],
  terminal: [
    ["path", "m4 17 6-6-6-6"],
    ["path", "M12 19h8"],
  ],
  back: [
    ["path", "m12 19-7-7 7-7"],
    ["path", "M19 12H5"],
  ],
  search: [
    ["circle", 11, 11, 8],
    ["path", "m21 21-4.3-4.3"],
  ],
  download: [
    ["path", "M12 15V3"],
    ["path", "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"],
    ["path", "m7 10 5 5 5-5"],
  ],
  shield: [
    [
      "path",
      "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
    ],
  ],
  hand: [
    ["path", "M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"],
    ["path", "M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"],
    ["path", "M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"],
    ["path", "M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"],
  ],
  monitor: [
    ["rect", 2, 3, 20, 14, 2],
    ["path", "M8 21h8M12 17v4"],
  ],
} satisfies Record<string, Shape[]>

export type IconName = keyof typeof ICONS

const SVG = "http://www.w3.org/2000/svg"

export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg")
  svg.setAttribute("viewBox", "0 0 24 24")
  svg.setAttribute("fill", "none")
  svg.setAttribute("stroke", "currentColor")
  svg.setAttribute("stroke-width", "2")
  svg.setAttribute("stroke-linecap", "round")
  svg.setAttribute("stroke-linejoin", "round")
  svg.setAttribute("aria-hidden", "true")
  for (const shape of ICONS[name] as Shape[]) {
    const el = document.createElementNS(SVG, shape[0])
    if (shape[0] === "path") el.setAttribute("d", shape[1])
    if (shape[0] === "circle") {
      el.setAttribute("cx", String(shape[1]))
      el.setAttribute("cy", String(shape[2]))
      el.setAttribute("r", String(shape[3]))
    }
    if (shape[0] === "rect") {
      el.setAttribute("x", String(shape[1]))
      el.setAttribute("y", String(shape[2]))
      el.setAttribute("width", String(shape[3]))
      el.setAttribute("height", String(shape[4]))
      el.setAttribute("rx", String(shape[5]))
    }
    svg.appendChild(el)
  }
  return svg
}
