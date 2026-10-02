import { expect, test } from "bun:test"
import assert from "node:assert"
import fs from "fs"
import os from "os"
import path from "path"
import {
  buildAgentConfig as buildConfig,
  detectWorktree,
  toConfigPatterns,
  toEnginePatterns,
  wildcardMatch,
} from "../src/permissions"
import type { PermissionRule } from "../src/protocol"

/**
 * The permission-translation tests are the important ones: they encode the
 * two pattern spaces the engine actually asks in, so a regression that makes a
 * granted path match nothing (the original defect: `./logs/**` against an
 * engine pattern of `logs/app.log`) fails here instead of on a real machine.
 *
 * Mirrored by packages/agents-everywhere/test/permission/conformance.test.ts,
 * which checks the same shapes against the engine's own evaluate().
 */

const buildAgentConfig = (...args: Parameters<typeof buildConfig>) =>
  buildConfig(...args) as unknown as { permission: Record<string, any> }

const CWD = "/home/ubuntu/app"
// Inside a repository the engine's project root is the repository, so the two
// coincide. The tests that care about the difference pass a worktree explicitly.
const WORKTREE = CWD

/** Resolves a category's rules the way the engine's evaluate() does: the most
 *  specific matching rule wins, and order decides only between equally specific
 *  rules, where later wins. Asserts end behaviour rather than the shape of the
 *  emitted object. Null when nothing matches. */
function resolve(rules: Record<string, string>, target: string): string | null {
  let best: string | null = null
  let bestScore = -1
  for (const [pattern, action] of Object.entries(rules)) {
    if (!wildcardMatch(target, pattern)) continue
    const score = pattern.replace(/[*?]/g, "").length
    if (score >= bestScore) {
      best = action
      bestScore = score
    }
  }
  return best
}

const fsRow = (
  pathPattern: string,
  access: "read" | "write" = "read",
  effect: "allow" | "deny" = "allow",
): PermissionRule => ({
  path_pattern: pathPattern,
  access,
  effect,
  kind: "filesystem",
})

test("wildcardMatch mirrors the engine's matcher", () => {
  assert.ok(wildcardMatch("logs/app.log", "logs/*"))
  // `*` crosses `/` in the engine, so one trailing glob covers any depth.
  assert.ok(wildcardMatch("logs/2026/09/app.log", "logs/*"))
  assert.ok(!wildcardMatch("logsx/app.log", "logs/*"))
  // A literal dot must not act as a regex wildcard.
  assert.ok(!wildcardMatch("logsXapp.log", "logs.app.log"))
  assert.ok(wildcardMatch("logs.app.log", "logs.app.log"))
  assert.ok(wildcardMatch("git status", "git *"))
  // The engine's trailing " .*" special case: `git *` also matches bare `git`.
  assert.ok(wildcardMatch("git", "git *"))
  assert.ok(!wildcardMatch("gitlab push", "git *"))
})

test("toEnginePatterns produces both the relative and absolute forms", () => {
  const { relative, absolute } = toEnginePatterns("./logs/**", CWD, WORKTREE)
  assert.deepStrictEqual(relative, ["logs", "logs/*"])
  assert.deepStrictEqual(absolute, ["/home/ubuntu/app/logs", "/home/ubuntu/app/logs/*"])
})

test("toEnginePatterns normalises the glob suffix variants to one base", () => {
  for (const input of ["./logs", "./logs/", "./logs/*", "./logs/**", "logs/**", "/home/ubuntu/app/logs/**"]) {
    assert.deepStrictEqual(toEnginePatterns(input, CWD, WORKTREE).relative, ["logs", "logs/*"], input)
  }
})

test("toEnginePatterns expresses an outside-the-worktree grant the way the tool asks for it", () => {
  const { relative, absolute } = toEnginePatterns("/var/log/app/**", CWD, WORKTREE)
  // tool/read.ts asks with path.relative(worktree, file), which really is
  // ../../-prefixed for a file outside the worktree.
  assert.deepStrictEqual(relative, ["../../../var/log/app", "../../../var/log/app/*"])
  assert.deepStrictEqual(absolute, ["/var/log/app", "/var/log/app/*"])
})

test("toEnginePatterns expands ~", () => {
  const { absolute } = toEnginePatterns("~/notes/**", CWD, WORKTREE)
  assert.deepStrictEqual(absolute, [
    path.posix.join(os.homedir().replaceAll("\\", "/"), "notes"),
    path.posix.join(os.homedir().replaceAll("\\", "/"), "notes") + "/*",
  ])
})

test("a granted read path actually resolves to allow", () => {
  const { permission } = buildAgentConfig([fsRow("./logs/**")], CWD, WORKTREE)
  // The regression this whole file exists for.
  assert.strictEqual(resolve(permission.read, "logs/app.log"), "allow")
  assert.strictEqual(resolve(permission.read, "logs/nested/deep/app.log"), "allow")
  assert.strictEqual(resolve(permission.read, "logs"), "allow")
})

test("an ungranted path is denied, and read access does not imply write", () => {
  const { permission } = buildAgentConfig([fsRow("./logs/**")], CWD, WORKTREE)
  assert.strictEqual(resolve(permission.read, "src/index.ts"), "deny")
  assert.strictEqual(resolve(permission.read, "../../etc/passwd"), "deny")
  assert.strictEqual(resolve(permission.edit, "logs/app.log"), "deny")
})

test("a write grant allows edit and read on the same path", () => {
  const { permission } = buildAgentConfig([fsRow("./src/**", "write")], CWD, WORKTREE)
  assert.strictEqual(resolve(permission.edit, "src/index.ts"), "allow")
  assert.strictEqual(resolve(permission.read, "src/index.ts"), "allow")
  assert.strictEqual(resolve(permission.edit, "infra/main.tf"), "deny")
})

test("enumeration tools follow the read grant instead of falling through to the engine default", () => {
  const { permission } = buildAgentConfig([fsRow("./logs/**")], CWD, WORKTREE)
  for (const category of ["glob", "grep", "list"]) {
    assert.strictEqual(resolve(permission[category], "logs/app.log"), "allow", category)
    assert.strictEqual(resolve(permission[category], "secrets/keys.pem"), "deny", category)
  }
})

test("external_directory is granted in the absolute space the tool asks in", () => {
  const { permission } = buildAgentConfig([fsRow("/var/log/app/**")], CWD, WORKTREE)
  assert.strictEqual(resolve(permission.external_directory, "/var/log/app/*"), "allow")
  assert.strictEqual(resolve(permission.external_directory, "/var/log/app/nginx/*"), "allow")
  assert.strictEqual(resolve(permission.external_directory, "/etc/*"), "deny")
})

test("two rows that contradict each other at the same specificity resolve to deny", () => {
  // The engine breaks an equal-specificity tie by order, which a caller cannot
  // be expected to reason about, so the contradiction is settled here: one rule
  // per pattern, and the deny is the one kept, whichever order the rows arrive
  // in.
  for (const rows of [
    [fsRow("./src/**", "write"), fsRow("./src/**", "write", "deny")],
    [fsRow("./src/**", "write", "deny"), fsRow("./src/**", "write")],
  ]) {
    const { permission } = buildAgentConfig(rows, CWD, WORKTREE)
    assert.strictEqual(permission.edit["src/*"], "deny")
    assert.strictEqual(resolve(permission.edit, "src/index.ts"), "deny")
  }
})

test("a more specific deny carves a hole in a broader allow", () => {
  const { permission } = buildAgentConfig(
    [fsRow("./**", "write"), fsRow("./src/secrets/**", "write", "deny")],
    CWD,
    WORKTREE,
  )
  assert.strictEqual(resolve(permission.edit, "src/index.ts"), "allow")
  assert.strictEqual(resolve(permission.edit, "src/secrets/key.pem"), "deny")
})

test("row order cannot change the outcome", () => {
  const rows = [fsRow("./**", "write"), fsRow("./src/secrets/**", "write", "deny")]
  const forward = buildAgentConfig(rows, CWD, WORKTREE).permission.edit
  const backward = buildAgentConfig([...rows].reverse(), CWD, WORKTREE).permission.edit
  assert.strictEqual(resolve(forward, "src/secrets/key.pem"), "deny")
  assert.strictEqual(resolve(backward, "src/secrets/key.pem"), "deny")
  assert.strictEqual(resolve(forward, "src/index.ts"), "allow")
  assert.strictEqual(resolve(backward, "src/index.ts"), "allow")
})

test("bash denies everything unless a command pattern is granted", () => {
  const bare = buildAgentConfig([fsRow("./logs/**")], CWD, WORKTREE).permission.bash
  assert.strictEqual(resolve(bare, "ls -la"), "deny")

  const granted = buildAgentConfig(
    [fsRow("./logs/**"), { path_pattern: "git *", kind: "bash_command", access: "read", effect: "allow" }],
    CWD,
  ).permission.bash
  assert.strictEqual(resolve(granted, "git status"), "allow")
  assert.strictEqual(resolve(granted, "rm -rf /"), "deny")
})

test("a bash deny row beats a broader bash allow row", () => {
  const { permission } = buildAgentConfig(
    [
      { path_pattern: "*", kind: "bash_command", access: "read", effect: "allow" },
      { path_pattern: "curl *", kind: "bash_command", access: "read", effect: "deny" },
    ],
    CWD,
    WORKTREE,
  )
  assert.strictEqual(resolve(permission.bash, "ls -la"), "allow")
  assert.strictEqual(resolve(permission.bash, "curl http://evil.test"), "deny")
})

test("webfetch hosts are allowlisted and everything else denied", () => {
  const { permission } = buildAgentConfig(
    [{ path_pattern: "https://api.github.com/*", kind: "webfetch_host", access: "read", effect: "allow" }],
    CWD,
    WORKTREE,
  )
  assert.strictEqual(resolve(permission.webfetch, "https://api.github.com/repos/x/y"), "allow")
  assert.strictEqual(resolve(permission.webfetch, "https://evil.test/steal"), "deny")
})

test("categories with no rows still deny, rather than inheriting the engine's permissive default", () => {
  const { permission } = buildAgentConfig([], CWD, WORKTREE)
  for (const category of ["read", "edit", "glob", "grep", "list", "external_directory", "webfetch", "bash"]) {
    assert.strictEqual(permission[category]["*"], "deny", category)
  }
  assert.strictEqual(permission.task, "deny")
  assert.strictEqual(permission.skill, "deny")
  assert.strictEqual(permission.websearch, "deny")
  // Bookkeeping prompts with no access to anything; denying them strands runs.
  assert.strictEqual(permission.todowrite, "allow")
  assert.strictEqual(permission.doom_loop, "allow")
})

test("an empty or whitespace pattern is ignored rather than becoming a wildcard grant", () => {
  const { permission } = buildAgentConfig([fsRow("   ")], CWD, WORKTREE)
  assert.strictEqual(resolve(permission.read, "anything"), "deny")
})

test("a bare wildcard grant is expressed as the engine's own wildcard", () => {
  for (const input of ["*", "./**", "./", "."]) {
    const { permission } = buildAgentConfig([fsRow(input)], CWD, WORKTREE)
    assert.strictEqual(resolve(permission.read, "src/index.ts"), "allow", input)
  }
})

test("patterns are relative to the engine's project root, not the working directory", () => {
  // The plain-directory case: with no repository above it, the engine's worktree
  // is "/" and it asks about the whole path minus the leading slash.
  const { relative, absolute } = toEnginePatterns("./logs/**", "/tmp/work", "/")
  assert.deepStrictEqual(relative, ["tmp/work/logs", "tmp/work/logs/*"])
  assert.deepStrictEqual(absolute, ["/tmp/work/logs", "/tmp/work/logs/*"])

  const { permission } = buildAgentConfig([fsRow("./logs/**")], "/tmp/work", "/")
  assert.strictEqual(resolve(permission.read, "tmp/work/logs/app.log"), "allow")
  // And the form that used to be emitted still matches nothing, which is the
  // defect this encodes.
  assert.strictEqual(resolve(permission.read, "logs/app.log"), "deny")
})

test("detectWorktree finds a repository above the working directory", () => {
  const repo = fs.mkdtempSync(os.tmpdir() + "/runner-wt-")
  const nested = `${repo}/a/b`
  fs.mkdirSync(nested, { recursive: true })
  try {
    // No repository anywhere: the engine treats the filesystem root as the
    // project, so this must agree with it.
    assert.strictEqual(detectWorktree(nested), "/")
    fs.mkdirSync(`${repo}/.git`)
    assert.strictEqual(detectWorktree(nested), fs.realpathSync(repo))
    assert.strictEqual(detectWorktree(repo), fs.realpathSync(repo))
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

// ── Permission mode ──────────────────────────────────────────────────────────

test("request mode escalates an unmentioned action instead of refusing it", () => {
  // "ask" is the only fallback the engine turns into a question. With "deny"
  // it refuses internally, nothing is raised, and request mode can never fire,
  // which is exactly how it shipped unable to work.
  const { permission } = buildAgentConfig([fsRow("./logs/**")], CWD, WORKTREE, "request")
  assert.strictEqual(permission.read["*"], "ask")
  assert.strictEqual(permission.bash["*"], "ask")
  assert.strictEqual(permission.task, "ask")
  // A grant is still a grant: it does not ask about what it was told to allow.
  assert.strictEqual(resolve(permission.read, "logs/app.log"), "allow")
})

test("strict mode refuses an unmentioned action outright", () => {
  const { permission } = buildAgentConfig([fsRow("./logs/**")], CWD, WORKTREE, "strict")
  assert.strictEqual(permission.read["*"], "deny")
  assert.strictEqual(resolve(permission.read, "secrets/key.pem"), "deny")
})

test("an explicit deny is never escalated, in either mode", () => {
  // A deny row is a decision someone already made; only silence is a question.
  for (const mode of ["strict", "request"] as const) {
    const { permission } = buildAgentConfig(
      [fsRow("./**", "write"), fsRow("./src/secrets/**", "write", "deny")],
      CWD,
      WORKTREE,
      mode,
    )
    assert.strictEqual(resolve(permission.edit, "src/secrets/key.pem"), "deny", mode)
    assert.strictEqual(resolve(permission.edit, "src/index.ts"), "allow", mode)
  }
})

test("a never-allowed path under a write grant cannot be written", () => {
  const cfg = buildAgentConfig(
    [
      { path_pattern: "./out/**", access: "write", kind: "filesystem", effect: "allow" },
      // Exactly as the control plane stores it.
      { path_pattern: "./out/secrets/**", access: "read", kind: "filesystem", effect: "deny" },
    ],
    "/tmp/agent-demo",
    "/",
    "request",
  )
  const edit = cfg.permission.edit
  assert.equal(resolve(edit, "tmp/agent-demo/out/secrets/summary.txt"), "deny")
  assert.equal(resolve(cfg.permission.read, "tmp/agent-demo/out/secrets/summary.txt"), "deny")
  // The grant around it still works.
  assert.equal(resolve(edit, "tmp/agent-demo/out/summary.txt"), "allow")
})

test("a read grant still does not allow writing", () => {
  const cfg = buildAgentConfig(
    [{ path_pattern: "./logs/**", access: "read", kind: "filesystem", effect: "allow" }],
    "/tmp/agent-demo",
    "/",
    "request",
  )
  assert.equal(resolve(cfg.permission.read, "tmp/agent-demo/logs/app.log"), "allow")
  // Falls through to the mode's fallback, never to an allow.
  assert.equal(resolve(cfg.permission.edit, "tmp/agent-demo/logs/app.log"), "ask")
})

// "Add to rules" stored the engine's own pattern, which is relative to the
// project root, and the next run read it as relative to where the agent
// starts, so the approved path was asked about again every run. The round
// trip has to land on the same request, outside a repository and inside one.
test("an approved path, stored as a rule, matches the same request next run", () => {
  const cases = [
    { cwd: "/tmp/agent-demo", worktree: "/", asked: "tmp/agent-demo/scratch/notes.md", stored: "./scratch/notes.md" },
    { cwd: "/repo/sub", worktree: "/repo", asked: "sub/scratch/notes.md", stored: "./scratch/notes.md" },
    { cwd: "/repo/sub", worktree: "/repo", asked: "docs/guide.md", stored: "/repo/docs/guide.md" },
    { cwd: "/repo", worktree: "/repo", asked: "src/*", stored: "./src/*" },
  ]
  for (const c of cases) {
    const [stored] = toConfigPatterns("read", [c.asked], c.cwd, c.worktree)
    assert.equal(stored, c.stored, JSON.stringify(c))
    const next = toEnginePatterns(stored, c.cwd, c.worktree).relative
    assert.ok(
      next.some((p) => wildcardMatch(c.asked, p)),
      `${stored} -> ${JSON.stringify(next)} misses ${c.asked}`,
    )
  }
})

test("only path permissions are rewritten", () => {
  assert.deepEqual(toConfigPatterns("bash", ["git status"], "/tmp/x", "/"), ["git status"])
  assert.deepEqual(toConfigPatterns("external_directory", ["/etc/*"], "/tmp/x", "/"), ["/etc/*"])
  assert.deepEqual(toConfigPatterns("webfetch", ["https://example.com/*"], "/tmp/x", "/"), ["https://example.com/*"])
})
