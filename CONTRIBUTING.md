# Contributing to agents-everywhere

Bug reports, fixes and new provider support are welcome. Open an issue before starting anything larger than a bug fix, so we can agree on the shape of it before you spend time on code.

## Choosing an issue

Browse [good first issues](https://github.com/codity-ai/Agents-Everywhere/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22) for a small starting point, or [feature requests](https://github.com/codity-ai/Agents-Everywhere/issues?q=is%3Aissue%20is%3Aopen%20label%3Aenhancement) for larger changes. Advanced tasks are marked `complexity: advanced` and need an agreed design before implementation. Comment on the issue with your proposed approach so maintainers can help clarify scope and avoid overlapping work.

Use the bug report, feature request or documentation form when opening an issue. Include enough detail for another contributor to reproduce the problem or understand who benefits. Keep API keys, admin tokens, install-command credentials and private transcripts out of public issues, logs and screenshots.

## Getting started

Requirements: Bun 1.3.14 (the CI version; build scripts accept compatible newer Bun 1.x versions), and Node.js 18+ for the runner. The runner supports Linux with glibc and macOS on x64 or arm64; Windows and Alpine/musl are unsupported.

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

The GitLab and Poe authentication dependencies are patched to use this fork's plugin types. GitLab stores credentials and logs under the fork's data directory, respecting `XDG_DATA_HOME`. GitLab OAuth needs `GITLAB_OAUTH_CLIENT_ID` for an application with `http://127.0.0.1:8080/callback` registered; personal access token login does not need this variable.

## Tests

Run tests from the package, never from the repository root:

```bash
bun --cwd packages/agents-everywhere test
bun --cwd packages/harness test
bun --cwd packages/control test
bun --cwd packages/http-recorder test
```

Run `bun run typecheck` from each package you change. CI runs on every branch push and pull request, checks every workspace's types, runs lint and all package suites, exercises HTTP API coverage and authentication, verifies the HTTP recorder package, and builds and smoke-tests the native engine. Releases must pass this workflow before publishing binaries.

The permission suites (`packages/agents-everywhere/test/permission/` and `test/tool/`) are the ones that matter most: each case there is an escape that has actually been tried. A change to permission handling should add a case that fails without it.

## Pull requests

- Fill in the pull request template with the problem, approach, linked issue and exact verification commands and results. Say which checks you did not run.
- One logical change per pull request, with a title in the imperative mood ("Fix symlink check on macOS").
- Describe what changed and why in your own words. Link the issue it addresses.
- UI changes need a screenshot. Logic changes need a test, or a note on how you verified them.
- Keep unrelated formatting and refactors out of a fix, so the diff shows the fix.

## Contributions and hiring

Codity might hire talent from open-source contributions made to our repositories. We look for useful work, sound technical judgment, clear communication and follow-through during review. Bug fixes, features, tests, documentation and thoughtful code reviews all count.

Start with an issue that interests you and make the change easy to review. Strong contributions can lead to a hiring conversation with Codity; a contribution does not guarantee a job offer.

## Reporting security issues

Do not open a public issue for a vulnerability. See [`SECURITY.md`](SECURITY.md).
