# Contributing to agents-everywhere

Bug reports, fixes and new provider support are welcome. Open an issue before starting anything larger than a bug fix, so we can agree on the shape of it before you spend time on code.

## Getting started

Requirements: Bun 1.3+, and Node.js 18+ for the runner.

```bash
bun install
bun dev --help          # the engine CLI, same as the built `agents-everywhere` binary
bun dev serve           # the engine's HTTP server, on port 4096 by default
bun dev <directory>     # the TUI, in another directory
```

To build a standalone engine binary for your own platform:

```bash
./packages/agents-everywhere/script/build.ts --single
./packages/agents-everywhere/dist/agents-everywhere-<platform>/bin/agents-everywhere --help
```

## Where things live

| Package | What it is |
|---|---|
| `packages/agents-everywhere` | The engine: CLI, sessions, tools, permission checks, HTTP server |
| `packages/core` | Shared engine internals: config, providers, storage |
| `packages/tui` | The terminal UI (SolidJS on [opentui](https://github.com/anomalyco/opentui)) |
| `packages/harness` | The runner installed on a machine by the install command |
| `packages/control` | The self-hosted control plane: API, SQLite store and web UI |
| `packages/plugin` | `@agents-everywhere/plugin`, for writing plugins and custom tools |
| `docs/` | The runner protocol and user documentation |

New model providers come from [models.dev](https://github.com/anomalyco/models.dev), so a provider that is missing usually belongs there first.

## Tests

Run tests from the package, never from the repository root:

```bash
bun --cwd packages/agents-everywhere test
bun --cwd packages/harness test
bun --cwd packages/control test
```

The permission suites (`packages/agents-everywhere/test/permission/` and `test/tool/`) are the ones that matter most: each case there is an escape that has actually been tried. A change to permission handling should add a case that fails without it.

## Pull requests

- One logical change per pull request, with a title in the imperative mood ("Fix symlink check on macOS").
- Describe what changed and why in your own words. Link the issue it addresses.
- UI changes need a screenshot. Logic changes need a test, or a note on how you verified them.
- Keep unrelated formatting and refactors out of a fix, so the diff shows the fix.

## Reporting security issues

Do not open a public issue for a vulnerability. See [`SECURITY.md`](SECURITY.md).
