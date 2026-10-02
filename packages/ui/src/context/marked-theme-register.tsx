import { registerCustomTheme } from "@pierre/diffs"
import { AgentsEverywhereTheme } from "./marked-theme"

let registered = false

export function registerAgentsEverywhereTheme() {
  if (registered) return
  registered = true
  registerCustomTheme("AgentsEverywhere", () => Promise.resolve(AgentsEverywhereTheme))
}
