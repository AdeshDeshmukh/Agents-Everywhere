import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@agents-everywhere/core/fs-util"
import { Ripgrep } from "@agents-everywhere/core/ripgrep"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./glob.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "The glob pattern to match files against" }),
  path: Schema.optional(Schema.String).annotate({
    description: `The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.`,
  }),
})

/**
 * The directories a pattern names outright before its first wildcard, e.g. `out` in
 * `out/**\/*.txt`. Every match lies under them, so they are where the search looks.
 * The last segment is a file name or a wildcard, so it is never part of it.
 */
function fixedDirectory(pattern: string): string {
  const fixed: string[] = []
  for (const part of pattern.split("/").slice(0, -1)) {
    if (/[*?[\]{}!]/.test(part)) break
    fixed.push(part)
  }
  return fixed.join("/")
}

export const GlobTool = Tool.define(
  "glob",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { pattern: string; path?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          let search = params.path ?? ins.directory
          search = path.isAbsolute(search) ? search : path.resolve(ins.directory, search)
          const info = yield* fs.stat(search).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (info?.type === "File") {
            throw new Error(`glob path must be a directory: ${search}`)
          }
          // Permission is about where the search looks, so path rules apply to it; the
          // rest of the glob is only what to look for there.
          const root = path.resolve(search, fixedDirectory(params.pattern))
          yield* assertExternalDirectoryEffect(ctx, root, {
            bypass: false,
            kind: "directory",
          })
          const target = path.relative(ins.worktree, root)
          yield* ctx.ask({
            permission: "glob",
            patterns: [target],
            always: [target],
            metadata: {
              pattern: params.pattern,
              path: params.path,
            },
          })

          const limit = 100
          const files = yield* ripgrep.glob({ cwd: search, pattern: params.pattern, limit })
          const truncated = files.length === limit

          const output = []
          if (files.length === 0) output.push("No files found")
          if (files.length > 0) {
            output.push(...files.map((file) => path.resolve(search, file.path)))
            if (truncated) {
              output.push("")
              output.push(
                `(Results are truncated: showing first ${limit} results. Consider using a more specific path or pattern.)`,
              )
            }
          }

          return {
            title: path.relative(ins.worktree, search),
            metadata: {
              count: files.length,
              truncated,
            },
            output: output.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
