import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { InstanceState } from "@/effect/instance-state"
import type * as Tool from "./tool"
import { containsPath } from "../project/instance-context"
import { FSUtil } from "@agents-everywhere/core/fs-util"

type Kind = "file" | "directory"

type Options = {
  bypass?: boolean
  kind?: Kind
}

/**
 * The path a filesystem operation will really land on, with symlinks resolved.
 *
 * `containsPath` is a string comparison, so a symlink inside the worktree that
 * points outside it reads as inside and skips the permission check entirely:
 * writing `<worktree>/link/passwd` where `link -> /etc` escapes without ever
 * asking. Resolving the deepest ancestor that exists and re-appending the rest
 * handles the write case too, where the leaf does not exist yet.
 *
 * A path that cannot be resolved at all is returned unchanged, which leaves
 * the caller's check no weaker than before.
 */
const resolveSymlinks = (target: string) =>
  Effect.promise(async () => {
    let head = target
    const tail: string[] = []
    for (;;) {
      try {
        const real = await fs.realpath(head)
        return tail.length ? path.join(real, ...tail.reverse()) : real
      } catch {
        const parent = path.dirname(head)
        if (parent === head) return target
        tail.push(path.basename(head))
        head = parent
      }
    }
  })

const globFor = (target: string, kind: Kind) => {
  const dir = kind === "directory" ? target : path.dirname(target)
  return process.platform === "win32"
    ? FSUtil.normalizePathPattern(path.join(dir, "*"))
    : path.join(dir, "*").replaceAll("\\", "/")
}

export const assertExternalDirectoryEffect = Effect.fn("Tool.assertExternalDirectory")(function* (
  ctx: Tool.Context,
  target?: string,
  options?: Options,
) {
  if (!target) return false

  if (options?.bypass) return false

  const ins = yield* InstanceState.context
  const normalized = process.platform === "win32" ? FSUtil.normalizePath(target) : target
  const resolved = yield* resolveSymlinks(normalized)

  const insideAsGiven = containsPath(normalized, ins)
  const insideResolved = containsPath(resolved, ins)

  // Only a path that is inside the worktree by both readings is inside it.
  if (insideAsGiven && insideResolved) return false

  const kind = options?.kind ?? "file"
  // The path as written is what the permission is asked about, so a rule
  // deliberately granted against a symlink ("allow <dir>/alias/*") still
  // matches. What the symlink cannot do is carry an operation out of the
  // worktree unnoticed: when the written path looks internal but resolves
  // outside, the real destination is asked about as well, and `ask` requires
  // every pattern to be allowed.
  const patterns = [globFor(normalized, kind)]
  if (insideAsGiven && !insideResolved) patterns.push(globFor(resolved, kind))

  yield* ctx.ask({
    permission: "external_directory",
    patterns,
    always: patterns,
    metadata: {
      filepath: normalized,
      // Only present when it differs, so a reader's attention is drawn to it
      // exactly when a symlink is involved.
      ...(resolved === normalized ? {} : { resolvedPath: resolved }),
      parentDir: kind === "directory" ? normalized : path.dirname(normalized),
    },
  })
  return true
})

export async function assertExternalDirectory(ctx: Tool.Context, target?: string, options?: Options) {
  return Effect.runPromise(assertExternalDirectoryEffect(ctx, target, options))
}
