import { describe, expect, test } from "bun:test"
import { Permission } from "../../src/permission"
import { ConfigPermissionV1 } from "@agents-everywhere/core/v1/config/permission"

/**
 * Conformance between the permission config the runner generates and the
 * pattern each tool actually asks with.
 *
 * The two have to agree exactly or a granted path silently matches nothing and
 * falls through to the config's wildcard deny. That is not hypothetical: the
 * harness used to emit `./logs/**` while tool/read.ts asks with
 * `path.relative(worktree, file)`, so `logs/app.log` matched no allow rule and
 * every "granted" read was refused. These cases pin the pattern spaces down:
 *
 *   read / edit / glob / grep / list  worktree-relative, no `./` prefix
 *   external_directory               absolute, `<dir>/*`
 *   bash                             the command's own source text
 *   webfetch                         the full request URL
 *
 * Keep in step with buildAgentConfig() in packages/harness/src/permissions.ts,
 * which has the mirror-image tests in packages/harness/test/permissions.test.ts.
 */

const CWD = "/home/ubuntu/app"

/** The shape buildAgentConfig() emits, for a read-only grant of ./logs. */
const harnessConfig = (overrides: Partial<ConfigPermissionV1.Info> = {}): ConfigPermissionV1.Info => ({
  read: { "*": "deny", logs: "allow", "logs/*": "allow" },
  edit: { "*": "deny" },
  glob: { "*": "deny", logs: "allow", "logs/*": "allow" },
  grep: { "*": "deny", logs: "allow", "logs/*": "allow" },
  list: { "*": "deny", logs: "allow", "logs/*": "allow" },
  external_directory: {
    "*": "deny",
    [`${CWD}/logs`]: "allow",
    [`${CWD}/logs/*`]: "allow",
  },
  webfetch: { "*": "deny" },
  bash: { "*": "deny" },
  task: "deny",
  skill: "deny",
  websearch: "deny",
  ...overrides,
})

const resolve = (config: ConfigPermissionV1.Info, permission: string, pattern: string, approved: any[] = []) =>
  Permission.evaluate(permission, pattern, Permission.fromConfig(config), approved).action

describe("harness config against the patterns tools ask with", () => {
  test("a granted read resolves to allow in the worktree-relative space", () => {
    const config = harnessConfig()
    expect(resolve(config, "read", "logs/app.log")).toBe("allow")
    expect(resolve(config, "read", "logs/2026/09/app.log")).toBe("allow")
    expect(resolve(config, "read", "logs")).toBe("allow")
  })

  test("the leading ./ form that used to be emitted would still match nothing", () => {
    // Kept as a case rather than a comment: it is the actual defect, and it
    // must stay failing so nobody reintroduces the old translation.
    const broken = harnessConfig({ read: { "*": "deny", "./logs/**": "allow" } })
    expect(resolve(broken, "read", "logs/app.log")).toBe("deny")
  })

  test("an ungranted path is denied", () => {
    const config = harnessConfig()
    expect(resolve(config, "read", "src/index.ts")).toBe("deny")
    expect(resolve(config, "read", "../../etc/passwd")).toBe("deny")
  })

  test("read access does not imply edit", () => {
    expect(resolve(harnessConfig(), "edit", "logs/app.log")).toBe("deny")
  })

  test("external_directory matches the absolute <dir>/* glob the tool computes", () => {
    const config = harnessConfig()
    expect(resolve(config, "external_directory", `${CWD}/logs/*`)).toBe("allow")
    expect(resolve(config, "external_directory", `${CWD}/logs/nginx/*`)).toBe("allow")
    expect(resolve(config, "external_directory", "/etc/*")).toBe("deny")
  })

  test("bash patterns match the command source text", () => {
    const config = harnessConfig({ bash: { "*": "deny", "git *": "allow" } })
    expect(resolve(config, "bash", "git status")).toBe("allow")
    expect(resolve(config, "bash", "git log --oneline -5")).toBe("allow")
    expect(resolve(config, "bash", "rm -rf /")).toBe("deny")
    expect(resolve(config, "bash", "gitlab-runner exec")).toBe("deny")
  })

  test("webfetch patterns match the full request URL", () => {
    const config = harnessConfig({ webfetch: { "*": "deny", "https://api.github.com/*": "allow" } })
    expect(resolve(config, "webfetch", "https://api.github.com/repos/o/r/pulls/1")).toBe("allow")
    expect(resolve(config, "webfetch", "https://evil.test/exfiltrate")).toBe("deny")
  })

  test("an unmentioned permission still asks rather than resolving either way", () => {
    expect(resolve({}, "read", "anything")).toBe("ask")
  })
})

describe("evaluate precedence", () => {
  test("the most specific rule wins over declaration order", () => {
    const denyFirst: ConfigPermissionV1.Info = { read: { "*": "deny", "src/*": "allow" } }
    const denyLast: ConfigPermissionV1.Info = { read: { "src/*": "allow", "*": "deny" } }
    // Both spellings say the same thing, so both must mean the same thing.
    expect(resolve(denyFirst, "read", "src/index.ts")).toBe("allow")
    expect(resolve(denyLast, "read", "src/index.ts")).toBe("allow")
    expect(resolve(denyFirst, "read", "infra/main.tf")).toBe("deny")
    expect(resolve(denyLast, "read", "infra/main.tf")).toBe("deny")
  })

  test("a more specific deny carves a hole in a broader allow", () => {
    const config: ConfigPermissionV1.Info = {
      edit: { "*": "allow", "src/secrets/*": "deny" },
    }
    expect(resolve(config, "edit", "src/index.ts")).toBe("allow")
    expect(resolve(config, "edit", "src/secrets/key.pem")).toBe("deny")
  })

  test("equal specificity is still decided by order, which is what layering needs", () => {
    // Two rules for the same pattern can only disagree when they come from
    // different layers, and there the later one has to win: it is how a config
    // overrides an engine default and how a session approval overrides a
    // config. So this one case stays order-dependent by design.
    const ruleset = [
      { permission: "edit", pattern: "src/*", action: "allow" as const },
      { permission: "edit", pattern: "src/*", action: "deny" as const },
    ]
    expect(Permission.evaluate("edit", "src/index.ts", ruleset).action).toBe("deny")
    expect(Permission.evaluate("edit", "src/index.ts", [...ruleset].reverse()).action).toBe("allow")
  })

  test("a config that contradicts itself at equal specificity cannot reach the engine", () => {
    // Because that case is order-dependent, it is resolved before the engine
    // sees it: the control plane collapses duplicate rules keeping the deny
    // (packages/control), and the runner refuses to downgrade a deny to an
    // allow (buildAgentConfig in packages/harness). A JSON
    // object cannot hold the same key twice either, so what arrives here is
    // always one rule per pattern.
    const config: ConfigPermissionV1.Info = { edit: { "src/*": "deny" } }
    expect(resolve(config, "edit", "src/index.ts")).toBe("deny")
  })

  test("a session approval beats a config wildcard deny of the same specificity", () => {
    // How "always allow" has to keep working: the approved layer is passed
    // last, so it outranks an equally vague config rule.
    const config: ConfigPermissionV1.Info = { read: { "*": "deny" } }
    const approved = [{ permission: "read", pattern: "*", action: "allow" as const }]
    expect(resolve(config, "read", "anything", approved)).toBe("allow")
  })

  test("a specific config deny still beats a vague session approval", () => {
    const config: ConfigPermissionV1.Info = { read: { "*": "allow", "secrets/*": "deny" } }
    const approved = [{ permission: "read", pattern: "*", action: "allow" as const }]
    expect(resolve(config, "read", "secrets/key.pem", approved)).toBe("deny")
  })

  test("a subagent deny injection holds against a permissive parent config", () => {
    // deriveSubagentSessionPermission appends these into the same layer.
    const ruleset = [
      ...Permission.fromConfig({ todowrite: "allow", task: "allow" }),
      { permission: "todowrite", pattern: "*", action: "deny" as const },
      { permission: "task", pattern: "*", action: "deny" as const },
    ]
    expect(Permission.evaluate("todowrite", "*", ruleset).action).toBe("deny")
    expect(Permission.evaluate("task", "*", ruleset).action).toBe("deny")
  })

  test("a permission wildcard is less specific than a named permission", () => {
    const ruleset = [
      { permission: "*", pattern: "*", action: "allow" as const },
      { permission: "edit", pattern: "*", action: "deny" as const },
    ]
    expect(Permission.evaluate("edit", "anything", ruleset).action).toBe("deny")
    expect(Permission.evaluate("read", "anything", ruleset).action).toBe("allow")
  })
})
