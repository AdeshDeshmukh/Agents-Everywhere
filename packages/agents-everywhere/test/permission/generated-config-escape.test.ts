import { PermissionV1 } from "@agents-everywhere/core/v1/permission"
import { LayerNode } from "@agents-everywhere/core/effect/layer-node"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { CrossSpawnSpawner } from "@agents-everywhere/core/cross-spawn-spawner"
import type { Tool } from "@/tool/tool"
import { assertExternalDirectoryEffect } from "../../src/tool/external-directory"
import { Permission } from "../../src/permission"
import { ConfigPermissionV1 } from "@agents-everywhere/core/v1/config/permission"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

/**
 * Escape attempts against a runner-generated permission config, enforced by the
 * engine rather than reasoned about.
 *
 * Each case is a way out of a granted directory that has actually been tried:
 * absolute paths, `..` traversal, a symlink pointing outside, and a path that
 * only the resolved form reveals. The config here is the shape
 * buildAgentConfig() emits (deny seed plus explicit grants), so a change to
 * either side that reopens one of these fails here.
 *
 * Deliberately not driven by a model: the point is that the boundary holds
 * whatever the agent asks for, and a test that needs an LLM to decide what to
 * try cannot state that.
 */

const it = testEffect(LayerNode.compile(CrossSpawnSpawner.node))

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_escape"),
  messageID: MessageID.make("msg_escape"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

/** A ctx whose `ask` enforces the config the way a real session does: every
 *  pattern must resolve to allow, or the call is refused. */
function enforcing(config: ConfigPermissionV1.Info) {
  const ruleset = Permission.fromConfig(config)
  const refused: Array<{ permission: string; patterns: readonly string[] }> = []
  const ctx: Tool.Context = {
    ...baseCtx,
    ask: (req) =>
      Effect.gen(function* () {
        const ok = req.patterns.every(
          (pattern) => Permission.evaluate(req.permission, pattern, ruleset).action === "allow",
        )
        if (!ok) {
          refused.push({ permission: req.permission, patterns: req.patterns })
          // The session refuses the same way: a denial is a defect (Effect.orDie in session/tools.ts).
          return yield* Effect.die(new PermissionV1.DeniedError({ ruleset }))
        }
      }),
  }
  return { ctx, refused }
}

/** What the harness emits for a read-only grant of one directory inside the
 *  worktree, in both pattern spaces. */
const configFor = (worktree: string, granted: string): ConfigPermissionV1.Info => ({
  read: { "*": "deny", [granted]: "allow", [`${granted}/*`]: "allow" },
  edit: { "*": "deny" },
  external_directory: {
    "*": "deny",
    [path.join(worktree, granted)]: "allow",
    [path.join(worktree, granted, "*")]: "allow",
  },
  bash: { "*": "deny" },
})

describe("escape attempts against a generated permission config", () => {
  it.instance("an absolute path outside the worktree is refused", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx, refused } = enforcing(configFor(test.directory, "logs"))

      const result = yield* Effect.exit(assertExternalDirectoryEffect(ctx, "/etc/passwd"))

      expect(result._tag).toBe("Failure")
      expect(refused.length).toBe(1)
      expect(refused[0]!.patterns).toContain("/etc/*")
    }),
  )

  it.instance("traversal out of a granted directory is refused", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx, refused } = enforcing(configFor(test.directory, "logs"))

      // The resolved destination is what is checked, so `..` cannot walk out
      // behind a granted prefix.
      const target = path.join(test.directory, "logs", "..", "..", "etc", "shadow")
      const result = yield* Effect.exit(assertExternalDirectoryEffect(ctx, target))

      expect(result._tag).toBe("Failure")
      expect(refused.length).toBe(1)
    }),
  )

  it.instance("a symlink out of the worktree is refused", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return

      const test = yield* TestInstance
      const outside = yield* tmpdirScoped()
      const link = path.join(test.directory, "logs-link")
      yield* Effect.promise(() => fs.mkdir(path.join(test.directory, "logs"), { recursive: true }))
      yield* Effect.promise(() => fs.symlink(outside, link, "dir"))

      const { ctx, refused } = enforcing(configFor(test.directory, "logs"))
      const result = yield* Effect.exit(
        assertExternalDirectoryEffect(ctx, path.join(link, "stolen.txt")),
      )

      expect(result._tag).toBe("Failure")
      expect(refused[0]!.patterns).toContain(path.join(outside, "*").replaceAll("\\", "/"))
    }),
  )

  it.instance("a symlink inside the granted directory still cannot reach outside", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return

      const test = yield* TestInstance
      const granted = path.join(test.directory, "logs")
      const outside = yield* tmpdirScoped()
      yield* Effect.promise(() => fs.mkdir(granted, { recursive: true }))
      yield* Effect.promise(() => fs.symlink(outside, path.join(granted, "out"), "dir"))

      const { ctx, refused } = enforcing(configFor(test.directory, "logs"))
      // Looks like it is under the granted path, and the grant would match it,
      // but the real destination is not granted.
      const result = yield* Effect.exit(
        assertExternalDirectoryEffect(ctx, path.join(granted, "out", "stolen.txt")),
      )

      expect(result._tag).toBe("Failure")
      expect(refused.length).toBe(1)
    }),
  )

  it.instance("a path genuinely inside the granted directory is allowed", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const granted = path.join(test.directory, "logs")
      yield* Effect.promise(() => fs.mkdir(granted, { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(path.join(granted, "app.log"), "ok"))

      const { ctx, refused } = enforcing(configFor(test.directory, "logs"))
      // Inside the worktree by both readings, so no external_directory question
      // arises at all and nothing is refused.
      const asked = yield* assertExternalDirectoryEffect(ctx, path.join(granted, "app.log"))

      expect(asked).toBe(false)
      expect(refused.length).toBe(0)
    }),
  )
})
