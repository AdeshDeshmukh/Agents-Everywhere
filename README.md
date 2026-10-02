# agents-everywhere

A coding agent you can run on any machine you control (a VM, a CI runner, a debug pod, a laptop), with permissions that hold and a small control plane you host yourself to create agents, install them, watch what they do and approve what they ask for.

It is a hard fork of [opencode](https://github.com/anomalyco/opencode) (MIT), taken from upstream commit [`e03db9b`](https://github.com/anomalyco/opencode/commit/e03db9bc6908f75c9334d8aa997deeaac81c0298) on 2026-09-16 and maintained by [Codity](https://codity.ai). Upstream changes are not merged back automatically. The engine keeps opencode's config format, so opencode's own documentation for config, agents, commands and providers still applies.

**Status: pre-release.** No binaries or packages are published yet; until the first release, build from source (see Local development).

## What is in this repository

| Part | Where | What it does |
|---|---|---|
| Engine | `packages/agents-everywhere` | The agent itself: the CLI, the TUI, and the HTTP server (`agents-everywhere serve`) that runs sessions and enforces permissions on every tool call. |
| Runner | `packages/harness` | A dependency-free Node script installed on a machine with one `curl` command. It checks in with the control plane, turns the agent's permission rules into the engine's config, runs the engine, and reports every step back. |
| Control plane | `packages/control` | A single process with SQLite and a small web UI. You create agents, mint install commands, read transcripts, approve or refuse what an agent asks for, and stop it. |

The runner and the control plane talk over a small HTTP protocol described in [`docs/runner-protocol.md`](docs/runner-protocol.md). Any server that implements it can drive the runner.

## Quick start

1. Start a control plane. It prints an admin token the first time; keep it.

   ```bash
   agents-everywhere control
   ```

2. Open http://127.0.0.1:4800, sign in with the token, and create an agent: a task, a model, its API key, and the paths and commands it may use.
3. On the agent's page, create an install command and run it on the machine the agent should work on, in the directory it should work in. The machine needs Node.js 18 or newer.

   The agent reads that directory's instruction files (`AGENTS.md`, `CLAUDE.md`) as instructions, the way any coding agent does, so start it where those files say what you want. The rules still apply to whatever they ask for, but an instruction file can make it ask for things you did not intend.
4. Watch the transcript, answer what it asks for under **Waiting on you**, or stop it. For a back-and-forth conversation, set the agent's run mode to **Interactive** and work with it in the terminal where you ran the install command.

To reach the control plane from other machines, and for what protects what, see [Running the control plane](docs/control-plane.md).

## Local development

```
bun install
bun run --cwd packages/agents-everywhere src/index.ts --help
bun run --cwd packages/control dev        # the control plane, building the runner and UI on start
```

No compiled binary is needed for local development. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Changes from upstream

### Permission resolution is by specificity, not declaration order

`packages/agents-everywhere/src/permission/index.ts`'s `evaluate()` used to resolve conflicting rules with `findLast` over declaration order, so `{"*": "deny", "src/*": "allow"}` and `{"src/*": "allow", "*": "deny"}` meant opposite things despite saying the same thing. A generated config cannot control JSON key order, so that turned a correct-looking permission set into a silent deny-everything.

Within one config the most specific matching rule now wins, and order decides only between rules of equal specificity, where later still wins. `test/permission/conformance.test.ts` pins this down, and the upstream tests that asserted pure order were updated to the new semantics.

Across layers, precedence is kept: rulesets are merged in increasing precedence (engine defaults, then the agent, then your config), and a later layer replaces every earlier rule it covers, so a config's `"*": "deny"` means deny whatever the engine's defaults say about particular tools. A session's own approvals ("always allow") are weighed against the config by specificity, so an approval beats an equally vague config rule while a *more specific* config deny still beats a vague approval.

### The permission scan sees more of what a shell command does

`tool/shell.ts` resolved path arguments only for a fixed list of commands (`rm`, `cp`, `mv`, `cat`, ...) and skipped redirection nodes entirely, so `echo x > /etc/y` and `tee /etc/y` walked straight past the filesystem permissions. Every argument that looks like a path is now resolved, whatever the command, and redirection targets are scanned too.

### A shell command's writes are checked against the edit rules

The scan above only ever asked `external_directory`, which by definition looks outside the worktree. A command that wrote *inside* it was checked by nothing: the filesystem tools never see a shell redirect, so `: > logs/worker.log` truncated a file in a directory granted read-only and no rule heard about it. `tool/shell.ts` now separates the arguments a command changes from the ones it reads, and asks `edit` on the worktree-relative path for each of them, in the same pattern space the write and edit tools use. That covers redirection targets (`>` and `>>`, not `<`) and the path arguments of the file-changing commands, with only the destination counted for `cp`, `mv` and `ln`.

It is deliberately not a complete seal, and the UI says so: a command that writes wherever an option points it (`tee`, `dd`, `sed -i`, `curl -o`) cannot be recognised by argument shape, so allowing one of those in the bash rules is still a trust decision.

### A bare redirect is checked like any other write

A line that is only a redirect (`> file`, `>> file`) has no command in it, so the scan above, which walks commands, never saw it, and it created or emptied its target with no question asked. Redirects are now read off the whole line as well as each command, and a line with no command in it is asked about as a whole.

### Searches are checked against the folder they search

`glob` and `grep` asked permission for their search text (`*.ts`, `ERROR`) rather than for where they looked, so path rules never applied to them: a search inside a granted folder asked anyway, and one outside it could be allowed by a rule about a pattern. Both now ask about the directory being searched, so they follow the same path rules as `read`.

### An approval covers what was asked about, not everything

"Allow for the rest of the session" on a read, write, edit, patch or fetch used to approve that tool for every target, because each tool offered `*` as what to remember. It now remembers only the file or URL in the question. A request also names only the targets the rules leave open, so refusing it does not read as refusing something already allowed.

### Symlinks cannot carry an operation out of the worktree

`containsPath` is a string comparison, so a symlink inside the worktree pointing outside it read as inside and skipped the `external_directory` check. `tool/external-directory.ts` now resolves the real destination for the containment decision while still asking about the path as written, so a rule deliberately granted against a symlink keeps working and an escape through one does not.

### Matching is case-insensitive on macOS

`Wildcard.match` was case-insensitive only on Windows, so on macOS's case-insensitive filesystem `SRC/secret` slipped past a rule written for `src/*`.

Regression tests for all of these live in `test/permission/` and `test/tool/`, including `generated-config-escape.test.ts`, which attempts each escape against a runner-generated config and requires it to be refused.

### Nothing trusts a domain this project does not own

Renaming the fork left references to `agents-everywhere.ai`, a domain this project has never owned. The engine's local HTTP server accepted cross-origin requests from any `https://*.agents-everywhere.ai` page, so whoever registered the domain could have driven a local agent from a web page, and the system prompts told the model to fetch its own documentation from there. Cross-origin access is now limited to loopback and the origins passed with `--cors` (`test/server/httpapi-cors.test.ts` refuses the old pattern), and every link the engine publishes about itself, from the config schema to the docs the model reads, points at this repository.

## License

MIT, same as upstream. See [`LICENSE`](LICENSE): the original opencode copyright line is kept as the license requires, and Codity's modifications are copyrighted separately.
