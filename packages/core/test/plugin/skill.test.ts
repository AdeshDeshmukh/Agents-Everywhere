import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@agents-everywhere/core/effect/app-node-builder"
import { SkillPlugin } from "@agents-everywhere/core/plugin/skill"
import { SkillV2 } from "@agents-everywhere/core/skill"
import { testEffect } from "../lib/effect"
import { host } from "./host"

const it = testEffect(AppNodeBuilder.build(SkillV2.node))

describe("SkillPlugin.Plugin", () => {
  it.effect("registers the built-in customize-agents-everywhere skill", () =>
    Effect.gen(function* () {
      const skill = yield* SkillV2.Service
      yield* SkillPlugin.Plugin.effect(host({ skill: { ...skill, reload: skill.reload } }))

      expect(yield* skill.list()).toContainEqual(
        expect.objectContaining({
          name: "customize-agents-everywhere",
          description: expect.stringContaining("agents-everywhere's own configuration"),
        }),
      )
    }),
  )
})
