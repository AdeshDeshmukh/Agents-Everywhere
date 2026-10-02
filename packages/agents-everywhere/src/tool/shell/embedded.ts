/**
 * Commands that one command is told to run, found in its arguments.
 *
 * The shell tool asks for a command by its own text, so an allowed `git *`
 * also allowed `git -c alias.x='!cat ~/.ssh/id_rsa' x`: the rule matched the
 * git command, and nothing looked at what git had been told to run. Every
 * command returned here is asked for as a bash pattern of its own, so it has
 * to be allowed by the rules on its own merits, whatever launched it.
 *
 * Interpreters (`python -c`, `node -e`) are deliberately absent: their
 * argument is a program, not a command, and allowing the interpreter is
 * already the decision to let it run arbitrary code.
 */

const MAX_DEPTH = 3

// git config keys whose value git executes, matched on the key's last
// segment so per-driver and per-remote forms (diff.<driver>.textconv,
// remote.<name>.uploadpack) are covered too.
const GIT_EXEC_KEY_SUFFIXES = new Set([
  "askpass",
  "clean",
  "cmd",
  "command",
  "driver",
  "editor",
  "external",
  "fsmonitor",
  "gitproxy",
  "helper",
  "hookspath",
  "packobjectshook",
  "pager",
  "process",
  "program",
  "proxycommand",
  "receivepack",
  "smudge",
  "sshcommand",
  "textconv",
  "uploadpack",
])

// git subcommand options whose value is a command.
const GIT_EXEC_OPTIONS: Record<string, string[]> = {
  archive: ["--exec"],
  clone: ["--upload-pack", "-u"],
  difftool: ["--extcmd", "-x"],
  fetch: ["--upload-pack"],
  "ls-remote": ["--upload-pack"],
  pull: ["--upload-pack"],
  push: ["--receive-pack", "--exec"],
  rebase: ["--exec", "-x"],
}

// git subcommands whose remaining arguments, after a keyword, are a command.
const GIT_RUNS_REST: Record<string, string> = {
  bisect: "run",
  submodule: "foreach",
}

// git global options that take the next token as their value.
const GIT_GLOBAL_WITH_VALUE = new Set(["-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix"])

// Commands that run the rest of their arguments, and the options of each that
// consume a value (so the value is not mistaken for the command).
const WRAPPERS: Record<string, Set<string>> = {
  doas: new Set(["-u", "-C"]),
  env: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
  nice: new Set(["-n", "--adjustment"]),
  nohup: new Set(),
  setsid: new Set(),
  stdbuf: new Set(["-i", "-o", "-e"]),
  sudo: new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U"]),
  timeout: new Set(["-k", "--kill-after", "-s", "--signal"]),
  xargs: new Set(["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s", "--arg-file", "--delimiter", "--max-args", "--max-procs"]),
}

// Wrappers whose first positional argument is a value, not the command.
const WRAPPER_LEADING_VALUE = new Set(["timeout"])

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"])

// Other commands with an option whose value is a command.
const COMMAND_OPTIONS: Record<string, string[]> = {
  rsync: ["-e", "--rsh"],
  tar: ["--to-command", "--use-compress-program", "-I", "--info-script", "-F", "--new-volume-script"],
}

const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"])

/** Removes shell quoting from one word, so `a='!b c'` reads as `a=!b c`. */
export function dequote(word: string): string {
  let out = ""
  let quote: string | null = null
  for (let i = 0; i < word.length; i++) {
    const ch = word[i]
    if (quote) {
      if (ch === quote) quote = null
      else if (ch === "\\" && quote === '"' && i + 1 < word.length) out += word[++i]
      else out += ch
    } else if (ch === "'" || ch === '"') quote = ch
    else if (ch === "\\" && i + 1 < word.length) out += word[++i]
    else out += ch
  }
  return out
}

/** Splits command text into words, respecting quotes. Good enough to find a
 * nested launcher; the real parse of the outer command is tree-sitter's. */
export function splitWords(text: string): string[] {
  const words: string[] = []
  let current = ""
  let quote: string | null = null
  let started = false
  for (const ch of text) {
    if (quote) {
      current += ch
      if (ch === quote) quote = null
    } else if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      started = true
    } else if (/\s/.test(ch)) {
      if (started) words.push(current)
      current = ""
      started = false
    } else {
      current += ch
      started = true
    }
  }
  if (started) words.push(current)
  return words
}

function optionValue(words: string[], i: number, option: string): string | undefined {
  const word = words[i]
  if (word === option) return words[i + 1]
  if (option.startsWith("--") && word.startsWith(option + "=")) return word.slice(option.length + 1)
  return undefined
}

function gitConfigCommand(key: string, value: string): string | undefined {
  const lower = key.toLowerCase()
  if (lower.startsWith("alias.")) return value.startsWith("!") ? value.slice(1) : undefined
  if (lower.startsWith("pager.")) return value
  const suffix = lower.slice(lower.lastIndexOf(".") + 1)
  if (!GIT_EXEC_KEY_SUFFIXES.has(suffix)) return undefined
  return value.startsWith("!") ? value.slice(1) : value
}

function fromGitAssignment(assignment: string): string | undefined {
  const eq = assignment.indexOf("=")
  if (eq <= 0) return undefined
  return gitConfigCommand(assignment.slice(0, eq), assignment.slice(eq + 1))
}

// `--config-env=key=VAR` takes the value from a variable nobody can see here,
// so an alias set that way is assumed to be a command, and the variable
// reference is what has to be allowed.
function fromGitConfigEnv(assignment: string): string | undefined {
  const eq = assignment.indexOf("=")
  if (eq <= 0) return undefined
  const reference = "$" + assignment.slice(eq + 1)
  return gitConfigCommand(assignment.slice(0, eq), reference) ?? (assignment.toLowerCase().startsWith("alias.") ? reference : undefined)
}

function fromGit(words: string[], raw: string[]): string[] {
  const found: string[] = []
  let i = 1
  for (; i < words.length; i++) {
    const word = words[i]
    if (word === "-c" || word === "--config-env") {
      const value = words[++i]
      if (value === undefined) break
      const inner = word === "-c" ? fromGitAssignment(value) : fromGitConfigEnv(value)
      if (inner) found.push(inner)
      continue
    }
    if (word.startsWith("-c") && word.length > 2 && !word.startsWith("--")) {
      const inner = fromGitAssignment(word.slice(2))
      if (inner) found.push(inner)
      continue
    }
    if (word.startsWith("--config-env=")) {
      const inner = fromGitConfigEnv(word.slice("--config-env=".length))
      if (inner) found.push(inner)
      continue
    }
    if (word.startsWith("--exec-path=")) {
      found.push(word.slice("--exec-path=".length))
      continue
    }
    if (GIT_GLOBAL_WITH_VALUE.has(word)) {
      i++
      continue
    }
    if (word.startsWith("-")) continue
    break
  }

  const sub = words[i]
  if (!sub) return found
  const rest = words.slice(i + 1)
  const rawRest = raw.slice(i + 1)

  if (sub === "config") {
    // `git config [--add|--global|set ...] key value` persists what `-c`
    // passes once: an alias written now runs on the next `git <alias>`.
    const positional = rest.filter((word) => !word.startsWith("-"))
    const args = positional[0] === "set" ? positional.slice(1) : positional
    if (args.length >= 2) {
      const inner = gitConfigCommand(args[0], args[1])
      if (inner) found.push(inner)
    }
    return found
  }

  const keyword = GIT_RUNS_REST[sub]
  if (keyword) {
    const at = rest.indexOf(keyword)
    if (at < 0) return found
    const tail = rawRest.slice(at + 1).filter((_, j) => !(keyword === "foreach" && rest[at + 1 + j].startsWith("-")))
    // `foreach 'cmd'` passes the command as one quoted word; a single word is
    // the command itself, several are the command's own words.
    if (tail.length === 1) found.push(dequote(tail[0]))
    else if (tail.length) found.push(tail.join(" "))
    return found
  }

  if (sub === "filter-branch") {
    for (let j = 0; j < rest.length; j++) {
      if (rest[j].startsWith("--") && rest[j].endsWith("-filter") && rest[j + 1] !== undefined) found.push(rest[++j])
    }
    return found
  }

  for (const option of GIT_EXEC_OPTIONS[sub] ?? []) {
    for (let j = 0; j < rest.length; j++) {
      const value = optionValue(rest, j, option)
      if (value !== undefined) found.push(value)
    }
  }
  return found
}

function fromWrapper(cmd: string, words: string[], raw: string[]): string[] {
  const withValue = WRAPPERS[cmd]
  let i = 1
  let leadingValueSkipped = !WRAPPER_LEADING_VALUE.has(cmd)
  for (; i < words.length; i++) {
    const word = words[i]
    if (withValue.has(word)) {
      i++
      continue
    }
    if (word.startsWith("-")) continue
    if (cmd === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue
    if (!leadingValueSkipped) {
      leadingValueSkipped = true
      continue
    }
    break
  }
  const inner = raw.slice(i)
  return inner.length ? [inner.join(" ")] : []
}

function fromFind(words: string[], raw: string[]): string[] {
  const found: string[] = []
  for (let i = 1; i < words.length; i++) {
    if (!FIND_EXEC.has(words[i])) continue
    const inner: string[] = []
    for (i++; i < words.length && words[i] !== ";" && words[i] !== "+"; i++) inner.push(raw[i])
    if (inner.length) found.push(inner.join(" "))
  }
  return found
}

function fromOptions(words: string[], options: string[]): string[] {
  const found: string[] = []
  for (let i = 1; i < words.length; i++) {
    for (const option of options) {
      const value = optionValue(words, i, option)
      if (value !== undefined) found.push(value)
    }
  }
  return found
}

function direct(rawWords: string[]): string[] {
  const words = rawWords.map(dequote)
  const cmd = words[0]?.split("/").pop()
  if (!cmd) return []
  if (cmd === "git") return fromGit(words, rawWords)
  if (cmd === "find") return fromFind(words, rawWords)
  if (SHELLS.has(cmd)) {
    const at = words.findIndex((word, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(word))
    return at >= 0 && words[at + 1] !== undefined ? [words[at + 1]] : []
  }
  if (cmd === "ssh") {
    const found: string[] = []
    for (let i = 1; i < words.length; i++) {
      const option = words[i] === "-o" ? words[i + 1] : words[i].startsWith("-o") ? words[i].slice(2) : undefined
      const match = option?.match(/^(ProxyCommand|LocalCommand)[= ](.+)$/i)
      if (match) found.push(match[2])
    }
    return found
  }
  if (WRAPPERS[cmd]) return fromWrapper(cmd, words, rawWords)
  const options = COMMAND_OPTIONS[cmd]
  return options ? fromOptions(words, options) : []
}

/**
 * Every command the given command would run on its behalf, nested launchers
 * included, as command text. `words` are the command's words as the shell
 * parser produced them, quotes still attached.
 */
export function embeddedCommands(words: string[], depth = 0): string[] {
  if (depth >= MAX_DEPTH) return []
  const found: string[] = []
  for (const inner of direct(words)) {
    const text = inner.trim()
    if (!text) continue
    found.push(text)
    found.push(...embeddedCommands(splitWords(text), depth + 1))
  }
  return found
}
