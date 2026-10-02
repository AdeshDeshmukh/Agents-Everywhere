import { run as runTui, type TuiInput } from "@agents-everywhere/tui"
import { Global } from "@agents-everywhere/core/global"
import { AppNodeBuilder } from "@agents-everywhere/core/effect/app-node-builder"
import { Effect } from "effect"

export function run(input: TuiInput) {
  return runTui(input).pipe(Effect.provide(AppNodeBuilder.build(Global.node)))
}
