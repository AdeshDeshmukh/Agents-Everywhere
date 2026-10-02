import fs from "fs"
import os from "os"
import path from "path"
import type { PermissionRule } from "./protocol"

export type Action = "allow" | "deny" | "ask"
export type PermissionMode = "strict" | "request"

/**
 * Faithful port of the engine's own matcher
 * (packages/core/src/util/wildcard.ts), so this file can check its own
 * translation against the semantics that will actually be applied. Keep the
 * two in step: `*` crosses `/` (there is no distinct `**`), `?` is a single
 * character, everything else is literal, and matching is case-insensitive only
 * on the platforms whose filesystems are.
 */
export function wildcardMatch(input: string, pattern: string): boolean {
  const normalized = String(input).replaceAll("\\", "/")
  let escaped = String(pattern)
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin"
  return new RegExp("^" + escaped + "$", caseInsensitive ? "si" : "s").test(normalized)
}

/**
 * Where the engine thinks the project starts, which is what every read and edit
 * pattern is relative to.
 *
 * Faithful to the engine's own rule (`Project.resolve` in
 * packages/core/src/project.ts): it discovers a git repository from the working
 * directory and uses that worktree; with no repository anywhere above, the
 * project is "global" and its worktree is the filesystem root.
 *
 * That second case is the one that matters. In a plain directory the worktree is
 * `/`, so the engine asks about `tmp/work/logs/app.log`, not `logs/app.log`, and
 * a config written relative to the working directory matches nothing.
 */
export function detectWorktree(cwd: string): string {
  let dir = path.resolve(cwd)
  for (;;) {
    // A file, not only a directory: a linked git worktree has `.git` as a file
    // pointing at the real store.
    if (fs.existsSync(path.join(dir, ".git"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return path.parse(dir).root
    dir = parent
  }
}

/**
 * The engine asks for permission in two different pattern spaces, and a
 * single stored path has to be translated into both or it silently matches
 * neither:
 *
 *   - `read`/`edit`/`glob`/`grep`/`list` ask with a *worktree-relative* path
 *     (`path.relative(instance.worktree, filepath)` in tool/read.ts,
 *     tool/write.ts and tool/edit.ts), so `logs/app.log` inside a repository and
 *     `tmp/work/logs/app.log` in a plain directory, where the worktree is `/`.
 *     There is no `./` prefix, which is why a stored `./logs/**` used to match
 *     nothing and every granted read fell through to the `"*": "deny"` seed.
 *   - `external_directory` asks with an *absolute* directory glob
 *     (`path.join(dir, "*")` in tool/external-directory.ts), so
 *     `/var/log/app/*`.
 *
 * Both forms are returned for every row. Emitting the relative form even for
 * an absolute grant is deliberate: `path.relative` is what the tool computes,
 * so a file outside the worktree really does arrive as `../../var/log/app/x`.
 */
export function toEnginePatterns(pathPattern: string, cwd: string, worktree = detectWorktree(cwd)) {
  const raw = String(pathPattern).trim().replaceAll("\\", "/")
  if (!raw) return { relative: [] as string[], absolute: [] as string[] }

  const expanded = raw.startsWith("~/") ? path.posix.join(os.homedir().replaceAll("\\", "/"), raw.slice(2)) : raw

  // Strip trailing glob segments so the base can be re-globbed consistently.
  // `*` already crosses `/` in the engine's matcher, so one trailing `/*`
  // covers arbitrary depth and `/**` adds nothing.
  const base = expanded.replace(/\/+$/, "").replace(/(\/\*+)+$/, "")
  const bareGlob = base === "" || base === "*"

  // A relative grant is relative to where the agent runs; the pattern it has to
  // match is relative to where the engine thinks the project starts. Those are
  // the same directory inside a repository and very different outside one.
  const absoluteBase = path.posix.isAbsolute(base)
    ? base
    : path.posix.join(cwd.replaceAll("\\", "/"), base === "." ? "" : base)
  const relativeBase = bareGlob ? "" : path.posix.relative(worktree.replaceAll("\\", "/"), absoluteBase)

  const relative = bareGlob || relativeBase === "" ? ["*"] : [relativeBase, `${relativeBase}/*`]
  const absolute = bareGlob ? ["*"] : [absoluteBase, `${absoluteBase}/*`]
  return { relative, absolute }
}

// Read-shaped categories all take worktree-relative patterns and should follow
// the same grant, so a config cannot grant a read and silently allow the
// directory to be enumerated by another tool instead.
const READ_CATEGORIES = ["read", "glob", "grep", "list"]

// The engine asks about files relative to its project root (the repository, or
// "/" outside one), while a config's rules are written the way a person writes
// them, relative to where the agent starts or absolute. An escalation carried
// the engine's form, so "add to rules" stored a rule that the next run
// translated a second time and that never matched again.
const WORKTREE_RELATIVE_PERMISSIONS = new Set(["read", "edit", "glob", "grep", "list"])

/** Engine patterns for one escalation, rewritten into the config's space. */
export function toConfigPatterns(permission: string, patterns: string[], cwd: string, worktree: string): string[] {
  if (!WORKTREE_RELATIVE_PERMISSIONS.has(permission)) return patterns
  return (patterns || []).map((pattern) => {
    const absolute = path.isAbsolute(pattern) ? pattern : path.join(worktree, pattern)
    const relative = path.relative(cwd, absolute)
    if (!relative) return "."
    if (relative.startsWith("..") || path.isAbsolute(relative)) return absolute
    return `./${relative}`
  })
}

// Categories the config gates with pattern rules. `webfetch` is here because
// the engine checks it with the full request URL as the pattern
// (tool/webfetch.ts), so host and path globs work like the filesystem ones.
// `bash` denies by default rather than "ask": every ask in strict mode is
// refused anyway, so "ask" would only ever mean "deny with extra steps".
const GATED = ["read", "edit", "glob", "grep", "list", "external_directory", "webfetch", "bash"]

export interface EngineConfig {
  permission: Record<string, Action | Record<string, Action>>
}

/**
 * Translates the control plane's permission rows into the engine's native
 * `permission` config.
 *
 * Every pattern-capable category starts from an explicit `"*"` seed, because
 * the engine's default "build" agent ships `"*": "allow"` and a category never
 * mentioned falls through to that, not to an implicit deny. Grants are then
 * layered on top. Precedence is resolved by rule specificity (`evaluate()` in
 * the engine's permission/index.ts), so a specific allow beats the wildcard
 * seed and an explicit deny of the same specificity wins over an allow; this
 * does not depend on JSON key insertion order.
 *
 * Also worth noting:
 *   - `external_directory` is a key inside `permission`, not a top-level config
 *     field, and its value is a pattern to action map.
 *   - `read` is independently gateable, so a read-only grant enforces something
 *     rather than being documentation.
 *   - `bash` patterns are matched against the source text of each command in
 *     the parsed command line (`scan.patterns` in tool/shell.ts), so they look
 *     like `git *`, not a path.
 *   - `websearch`, `todowrite`, `question` and `doom_loop` accept a scalar
 *     action only, never a pattern map.
 */
export function buildAgentConfig(
  permissions: PermissionRule[],
  cwd = process.cwd(),
  worktree = detectWorktree(cwd),
  permissionMode: PermissionMode = "strict",
): EngineConfig {
  // What an action nobody mentioned resolves to.
  //
  // In strict mode it is refused outright. In request mode it has to be "ask",
  // because that is the only action that makes the engine stop and raise a
  // `permission.asked` event: a "deny" is refused internally with nothing to
  // escalate. An explicit deny row stays a deny either way, since that is a
  // decision someone already made rather than an open question.
  const fallback: Action = permissionMode === "request" ? "ask" : "deny"

  // The rows are collected separately from the wildcard seed so that a
  // deliberate `*` grant can override the seed, while a deny among the rows
  // still beats an allow for the same pattern.
  const rules: Record<string, Record<string, Action>> = {}
  for (const category of GATED) rules[category] = {}

  const apply = (category: string, patterns: string[], action: Action) => {
    for (const pattern of patterns) {
      if (rules[category][pattern] === "deny") continue
      rules[category][pattern] = action
    }
  }

  for (const perm of permissions) {
    const action: Action = perm.effect === "deny" ? "deny" : "allow"

    if (perm.kind === "webfetch_host") {
      apply("webfetch", [perm.path_pattern], action)
      continue
    }

    if (perm.kind === "bash_command") {
      apply("bash", [perm.path_pattern], action)
      continue
    }

    const { relative, absolute } = toEnginePatterns(perm.path_pattern, cwd, worktree)
    for (const category of READ_CATEGORIES) apply(category, relative, action)
    apply("external_directory", absolute, action)
    // Access narrows a grant: a read grant must not let the agent write. It
    // does not narrow a deny. Deny rows are stored with read access, and
    // treating that like a read grant left writing open, so a path listed as
    // never allowed could be written by any write grant above it. A denied path
    // is denied to every tool.
    if (perm.access === "write" || perm.effect === "deny") apply("edit", relative, action)
  }

  const gated: Record<string, Record<string, Action>> = {}
  for (const category of GATED) {
    // Seed first, rows second: an explicit `"*"` row replaces the seed
    // outright, and every other row is resolved against it by specificity.
    gated[category] = { "*": fallback, ...rules[category] }
  }

  return {
    permission: {
      ...gated,
      // Scalar-only categories. `task` and `skill` follow the fallback because
      // a subagent is another permission surface and a skill can carry its own
      // instructions; `websearch` follows it because untrusted fetched text
      // steering the agent is the same class of problem as an ungated webfetch.
      // `todowrite`, `question` and `doom_loop` are the engine's own
      // bookkeeping prompts with no access to anything, and denying them
      // strands long runs, so they stay allowed.
      task: fallback,
      skill: fallback,
      websearch: fallback,
      lsp: "allow",
      todowrite: "allow",
      question: "allow",
      doom_loop: "allow",
    },
  }
}
