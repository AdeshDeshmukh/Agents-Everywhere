/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill"

import { define } from "./internal"
import { Effect } from "effect"
import { AbsolutePath } from "../schema"
import { SkillV2 } from "../skill"
import customizeAgentsEverywhereContent from "./skill/customize-agents-everywhere.md" with { type: "text" }

export const CustomizeAgentsEverywhereContent = customizeAgentsEverywhereContent

export const Plugin = define({
  id: "skill",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.skill.transform((draft) => {
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: "customize-agents-everywhere",
            description:
              "Use ONLY when the user is editing or creating agents-everywhere's own configuration: agents-everywhere.json, agents-everywhere.jsonc, files under .agents-everywhere/, or files under ~/.config/agents-everywhere/. Also use when creating or fixing agents-everywhere agents, subagents, commands, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring agents-everywhere itself.",
            location: AbsolutePath.make("/builtin/customize-agents-everywhere.md"),
            content: CustomizeAgentsEverywhereContent,
          }),
        }),
      )
    })
  }),
})
