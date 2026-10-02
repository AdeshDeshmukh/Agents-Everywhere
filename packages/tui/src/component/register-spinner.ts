import { getComponentCatalogue } from "@opentui/solid/components"
import { registerSpinner } from "opentui-spinner/solid"

export function registerAgentsEverywhereSpinner() {
  if (!getComponentCatalogue().spinner) registerSpinner()
}
