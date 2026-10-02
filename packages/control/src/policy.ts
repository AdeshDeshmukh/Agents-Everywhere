/**
 * What a permission set may contain, checked when it is written. A backstop
 * against a UI bug or a stolen session, not a substitute for the runner and
 * engine checks: this runs once per write, they run on every tool call.
 */
import type {
  PermissionAccess,
  PermissionEffect,
  PermissionKind,
  PermissionRule,
} from "@agents-everywhere/harness/protocol"

export class PolicyError extends Error {}

export const MAX_PERMISSION_ROWS = 400

// Directory rules that can never be granted for writing, whatever the caller sends.
const FORBIDDEN_WRITE_PATTERNS = new Set(["/", "/*", "*", "/**"])

// Commands that run other commands, or write wherever they are pointed, so that
// allowing them makes the path rules advisory. The engine checks each command
// it can see and cannot see inside a string an interpreter evaluates:
// `sh -c '...'`, `python -c '...'` and `eval` are one command as far as the
// scan is concerned, and whatever they run is not. Git counts when the rule
// leaves its first argument open ("git *", "git -..."), which is where
// `-c alias.x='!cmd'`, `-c core.pager=...` and `--exec-path` go; a rule that
// fixes the subcommand ("git status", "git diff *") cannot carry those. make and
// the package managers run scripts the agent may be able to edit; editors and
// pagers have shell escapes; tee and dd write anywhere.
export const BASH_GATEWAY_PATTERN =
  /^\s*(?:(?:sh|bash|zsh|dash|ksh|fish|eval|exec|env|xargs|nohup|setsid|sudo|doas|su|timeout|nice|watch|script|expect|python[\d.]*|perl|ruby|node|bun|bunx|deno|php|awk|lua|java|go|cargo|make|gmake|npm|npx|pnpm|yarn|pip[\d.]*|pipx|uv|gem|composer|docker|podman|kubectl|ssh|rsync|tar|sed|tee|dd|gdb|strace|ltrace|vim?|nvim|nano|emacs|less|more|man|find)\b|git\s+(?:\*|-))/i

/** Whether allowing this command pattern lets the agent run anything at all. */
export function isBashGateway(pattern: string): boolean {
  const trimmed = pattern.trim()
  return trimmed === "*" || trimmed === "" || BASH_GATEWAY_PATTERN.test(trimmed)
}

// Seeded onto every new agent as real, editable rows rather than hidden in the
// runner. Each is a command or path that either prints the environment the
// agent's own credentials live in, or writes somewhere that changes what the
// machine does next.
export const DEFAULT_DENY_RULES: ReadonlyArray<{ kind: PermissionKind; pattern: string }> = [
  { kind: "bash_command", pattern: "env *" },
  { kind: "bash_command", pattern: "printenv *" },
  { kind: "bash_command", pattern: "sudo *" },
  { kind: "bash_command", pattern: "rm -rf *" },
  { kind: "bash_command", pattern: "shutdown *" },
  { kind: "bash_command", pattern: "reboot *" },
  { kind: "filesystem", pattern: "~/.ssh" },
  { kind: "filesystem", pattern: "~/.aws" },
  { kind: "filesystem", pattern: "~/.config/gcloud" },
  { kind: "filesystem", pattern: "/etc" },
]

export interface Rule {
  path_pattern: string
  access: PermissionAccess
  kind: PermissionKind
  effect: PermissionEffect
}

export function defaultDenyRules(): Rule[] {
  // Denies are not access-scoped: a denied path is denied for reading as well
  // as writing, and read is the wider of the two here.
  return DEFAULT_DENY_RULES.map(({ kind, pattern }) => ({
    path_pattern: pattern,
    access: "read",
    kind,
    effect: "deny",
  }))
}

/** Rejects permission sets that cannot mean what they appear to mean. */
export function validatePermissions(rules: Rule[], acknowledgeBashGateways: boolean) {
  if (rules.length > MAX_PERMISSION_ROWS) {
    throw new PolicyError(`Too many permission rules (${rules.length} > ${MAX_PERMISSION_ROWS})`)
  }
  for (const rule of rules) {
    const pattern = rule.path_pattern.trim()
    const isAllow = rule.effect === "allow"

    if (isAllow && rule.kind === "filesystem" && rule.access === "write" && FORBIDDEN_WRITE_PATTERNS.has(pattern)) {
      throw new PolicyError(`Root-level write access (${JSON.stringify(rule.path_pattern)}) is never allowed`)
    }
    if (rule.kind !== "filesystem" && rule.access === "write") {
      throw new PolicyError(
        `Write access doesn't apply to a ${rule.kind} pattern (${JSON.stringify(rule.path_pattern)}), it only means something for a filesystem rule`,
      )
    }
    if (isAllow && rule.kind === "bash_command" && !acknowledgeBashGateways && isBashGateway(pattern)) {
      throw new PolicyError(
        `Allowing ${JSON.stringify(rule.path_pattern)} lets the agent run arbitrary commands, which makes the filesystem ` +
          "rules advisory: the engine checks each command it can see, and cannot see inside a string an interpreter " +
          "evaluates. Set acknowledge_bash_gateways to allow it anyway.",
      )
    }
  }
}

/**
 * Deduplicates on (kind, pattern, access), keeping deny over allow. Two rows
 * that disagree at identical specificity resolve to deny in the engine anyway,
 * so collapsing them makes the stored set say what will actually happen.
 */
export function dedupeRules(rules: Rule[]): Rule[] {
  const chosen = new Map<string, Rule>()
  for (const rule of rules) {
    const normalized = { ...rule, path_pattern: rule.path_pattern.trim() }
    const key = `${normalized.kind}\0${normalized.path_pattern}\0${normalized.access}`
    const existing = chosen.get(key)
    if (!existing || (existing.effect === "allow" && normalized.effect === "deny")) chosen.set(key, normalized)
  }
  return [...chosen.values()]
}

// Which stored rule kind can express a permanent approval of each engine
// permission. Scalar-only permissions (task, skill, websearch, todowrite) have
// no pattern to store, so they can be approved for a call or a run but not
// permanently.
const PERMISSION_TO_RULE: Record<string, { kind: PermissionKind; access: PermissionAccess }> = {
  read: { kind: "filesystem", access: "read" },
  list: { kind: "filesystem", access: "read" },
  glob: { kind: "filesystem", access: "read" },
  grep: { kind: "filesystem", access: "read" },
  external_directory: { kind: "filesystem", access: "read" },
  edit: { kind: "filesystem", access: "write" },
  bash: { kind: "bash_command", access: "read" },
  webfetch: { kind: "webfetch_host", access: "read" },
}

/**
 * The rules one permanent approval adds, held to the editor's checks: a command
 * that runs other commands cannot be added from an approval, and a rule the
 * agent already has is not added twice.
 */
export function permanentRulesFor(permission: string, patterns: string[], existing: Rule[]): Rule[] {
  const mapping = PERMISSION_TO_RULE[permission]
  if (!mapping) {
    throw new PolicyError(
      `${JSON.stringify(permission)} has no pattern to store, so it cannot be approved permanently. Approve it for this run instead.`,
    )
  }
  const wanted = patterns.filter((p) => typeof p === "string" && p.trim())
  if (wanted.length === 0) {
    throw new PolicyError("This request carries no pattern to store, so it cannot be approved permanently.")
  }
  const rules: Rule[] = wanted.map((p) => ({ path_pattern: p.trim(), ...mapping, effect: "allow" }))

  const gateway = rules.find((r) => r.kind === "bash_command" && isBashGateway(r.path_pattern))
  if (gateway) {
    throw new PolicyError(
      `${JSON.stringify(gateway.path_pattern)} runs other commands, so it can't be added to the rules from an approval. ` +
        "Allow it for this run, or add it in the agent's permissions, where you can confirm what it allows.",
    )
  }

  const have = new Set(existing.map((r) => `${r.kind}\0${r.path_pattern.trim()}\0${r.access}\0${r.effect}`))
  const fresh: Rule[] = []
  for (const rule of rules) {
    const key = `${rule.kind}\0${rule.path_pattern}\0${rule.access}\0${rule.effect}`
    if (have.has(key)) continue
    have.add(key)
    fresh.push(rule)
  }
  if (existing.length + fresh.length > MAX_PERMISSION_ROWS) {
    throw new PolicyError(
      `This agent already has ${existing.length} rules, the most it can hold is ${MAX_PERMISSION_ROWS}.`,
    )
  }
  validatePermissions(fresh, false)
  return fresh
}

/** Normalizes a rule from the wire, filling the default effect. */
export function toRule(input: PermissionRule): Rule {
  return {
    path_pattern: input.path_pattern,
    access: input.access,
    kind: input.kind,
    effect: input.effect ?? "allow",
  }
}
