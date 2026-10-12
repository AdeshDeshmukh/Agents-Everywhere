# Using the harness

The harness, also called the runner, connects a machine to your control plane and runs the engine with that agent's task, model and permissions. It lives in [`packages/harness`](../packages/harness) and bundles into a dependency-free Node.js script. The engine, runner and SQLite control plane in this repository form a self-hosted system.

The control plane manages agents and install tokens. The runner checks in, downloads the engine when needed, translates rules into its configuration, starts it and reports activity. The engine performs model requests and checks tool permissions on the machine. The runner makes outbound requests; the control plane does not connect into the machine.

## Requirements

| Machine | Requirements |
|---|---|
| Build machine | Bun 1.3.14 (the CI version; compatible newer Bun 1.x versions are accepted) and this repository's dependencies installed with `bun install`. |
| Control-plane host | The compiled engine's `control` command, or Bun to run `packages/control` from source. |
| Agent machine | Node.js 18 or newer, Bash and curl for the installer, a writable home directory and outbound access to the control plane and model provider. Interactive mode also needs a terminal. |

The runner supports Linux with glibc and macOS on x64 or arm64. Its downloader does not support Windows or Alpine/musl. You supply the selected model provider's API key when creating an agent.

## Start the control plane

From the repository root, build for the current machine:

```bash
bun install
bun run packages/agents-everywhere/script/build.ts --single
```

On Linux x64, start the resulting binary:

```bash
./packages/agents-everywhere/dist/agents-everywhere-linux-x64/bin/agents-everywhere control
```

Use the corresponding `agents-everywhere-linux-arm64`, `agents-everywhere-darwin-x64` or `agents-everywhere-darwin-arm64` directory on another supported platform. Open `http://127.0.0.1:4800` and sign in with the admin token printed on first start. Keep the control plane running while agents work.

That compiled control plane can serve its own executable to an agent on the same platform. Provide binaries for each additional agent platform with `--binaries <dir>` and the layout `<dir>/<platform>/agents-everywhere`. The full build command without `--single` produces the other targets. See [Running the control plane](control-plane.md) for TLS, remote machines and data backups.

When developing the control plane from source, you must supply engine binaries separately. For example, after the Linux x64 build above:

```bash
mkdir -p /tmp/agents-everywhere-binaries/linux-x64
cp packages/agents-everywhere/dist/agents-everywhere-linux-x64/bin/agents-everywhere /tmp/agents-everywhere-binaries/linux-x64/agents-everywhere
bun run --cwd packages/control dev --binaries /tmp/agents-everywhere-binaries
```

Source startup builds the runner and web UI automatically. Building the runner alone does not build an engine binary.

## Create and run an example agent

Prepare a small workspace on the agent machine:

```bash
mkdir -p /tmp/agents-everywhere-demo/logs /tmp/agents-everywhere-demo/reports /tmp/agents-everywhere-demo/scratch
printf 'INFO service started\nERROR database timeout\nERROR upstream unavailable\n' > /tmp/agents-everywhere-demo/logs/app.log
printf 'Demo notes for a permission request.\n' > /tmp/agents-everywhere-demo/scratch/notes.txt
cd /tmp/agents-everywhere-demo
```

In the control plane, create an agent with these values:

| Field | Value |
|---|---|
| Name | `log-summary-demo` |
| Task | `Read ./logs/app.log with the read tool. Count ERROR lines and write their count and messages to ./reports/summary.md using file tools. Do not run shell commands.` |
| Runs on | The agent machine's operating system. |
| Model | Choose a provider and an available model, then enter that provider's API key. |
| Run mode | Headless. |
| Unlisted actions | Refuse. |
| Paths | `./logs/**` with Read; `./reports/**` with Read and write. |
| Commands and URLs | Leave empty for this task. |
| Never allowed | Keep the default credential and destructive-command denials. |
| Secrets and environment variables | Leave empty for this task. |

This control plane requires a nonempty name, task, model and provider key in its creation form. The task is required in Interactive mode too; enter the working prompt in the terminal after the TUI opens, because this runner does not automatically submit the configured task to the TUI.

Create an install command on the agent's page and run it from `/tmp/agents-everywhere-demo`. Use the install token in that command, not the control plane's admin token. An install token works once and expires after five minutes; request a fresh command for another run.

The command downloads the installer from `/agent/install.sh`, which fetches `/agent/harness.js` and saves it locally as `harness.cjs`. The runner exchanges the install token for a run token and downloads the matching engine from `/agent/bin/<platform>/agents-everywhere`. Neither Bun nor this repository's source is required on the agent machine.

Expect handshake, model and permission-configuration messages, then real tool activity in the terminal and the control plane. A headless session may remain open for about a minute after its work completes to receive follow-up messages. Check the result yourself:

```bash
cat /tmp/agents-everywhere-demo/reports/summary.md
```

The report should count two errors and include `database timeout` and `upstream unavailable`. An install message or a succeeded run alone does not verify the report's contents.

### Try permission decisions

For a second headless run, change the task to `Read ./scratch/notes.txt with the read tool and summarize it. Do not use shell commands.` Keep the same grants and generate a fresh install command.

- In Refuse mode, the read should be denied and no approval request should be offered.
- In Ask me mode, the headless runner should show a pending read under **Waiting on you**. Choose Allow once to let that call proceed, or Refuse to deny it. An unanswered request expires at the configured timeout.
- To test an explicit denial, add `./scratch/**` to Never allowed and run again in Ask me mode. That denial should refuse the call without asking.

In Interactive mode, the engine presents permission questions in the terminal. This runner does not apply dashboard permission decisions to interactive sessions; answer the terminal's own prompts. Configured denials still refuse matching calls.

Relative paths are based on the directory where you run the installer. The runner translates them to the engine's project root, which is the Git worktree when one exists and the filesystem root otherwise. Start every run in the intended workspace, and quote paths containing spaces.

## Build or run the harness separately

The built-in control plane already serves the runner. Build it independently when testing a runner change or implementing another control plane:

```bash
bun run --cwd packages/harness build
```

This creates `packages/harness/dist/harness.js` and a rendered `packages/harness/dist/install.sh`. The tracked `packages/harness/install.sh` is a template with placeholders; use the rendered file when installing.

From the repository root, use your local bundle with the installer:

```bash
AGENTS_EVERYWHERE_RUNNER_SOURCE="$PWD/packages/harness/dist/harness.js" \
  bash packages/harness/dist/install.sh --preflight --api-url=http://127.0.0.1:4800
```

Preflight needs no install token. It checks Node, platform, local write access, control-plane health, engine availability and terminal availability. A terminal warning is expected when checking a headless machine. Preflight does not validate a provider key, exercise model calls or test the agent's permissions.

To perform a real run against that same control plane, supply a fresh install token in an environment variable and use:

```bash
AGENTS_EVERYWHERE_RUNNER_SOURCE="$PWD/packages/harness/dist/harness.js" \
  bash packages/harness/dist/install.sh --token="$AGENT_INSTALL_TOKEN" --api-url=http://127.0.0.1:4800
```

Run that command in the agent's workspace, using absolute paths to the bundle and installer if you have changed directories. Keep tokens out of checked-in files and shared logs. The installer stores the CommonJS bundle with a `.cjs` extension so it also works beneath a directory containing a `package.json` with `"type": "module"`.

### Runner options and environment

| Option or variable | Purpose |
|---|---|
| `--api-url=<url>` | Control-plane URL. The runner also accepts `--api-url <url>`. |
| `--token=<token>` | Single-use install token; the spaced form is also accepted. Required for a real run. |
| `--preflight` | Check the machine without claiming a run. |
| `AGENTS_EVERYWHERE_CONTROL_URL` | Default control-plane URL for direct runner invocation; otherwise `http://localhost:4800`. The installer needs `--api-url` or an explicit runner source to locate its download. |
| `AGENTS_EVERYWHERE_RUNNER_SOURCE` | Installer override for the runner bundle's local path or HTTP(S) URL. |
| `AGENTS_EVERYWHERE_RUNNER_HOME` | Installer override for where it saves `harness.cjs`. Engine cache, run configurations and logs still use `~/.agents-everywhere-runner`; this variable does not relocate those files. |
| `AGENTS_EVERYWHERE_RUNNER_DRY_RUN=1` | Simulate a headless task to exercise control-plane reporting. It performs no agent work and does not verify model access, tools or permission enforcement. Interactive mode always runs the engine. |

Provider credentials and fetched secrets are supplied to the engine through its inherited environment. The runner removes undeclared provider endpoint overrides such as `OPENAI_BASE_URL`; declare the variable on the agent if an intentional gateway should receive that provider's requests. The declaration is a variable name, and its value must already exist on the machine.

Secret references support AWS Secrets Manager, GCP Secret Manager, Vault KV v2 and existing environment variables. Set up the machine's identity and access first. A failed secret lookup is logged and skipped, so verify that credentials needed by your task are available before relying on its result.

## Files, stopping and new runs

| Local path | Contents |
|---|---|
| `~/.agents-everywhere-runner/harness.cjs` | Installed runner, unless the installer directory was overridden. |
| `~/.agents-everywhere-runner/bin/agents-everywhere` | Downloaded engine, with a `.meta.json` cache-identity file beside it. |
| `~/.agents-everywhere-runner/run-<run-id>.json` | Temporary engine permission configuration, removed when the runner cleans up. |
| `~/.agents-everywhere-runner/run-<run-id>.log` | Runner messages while the TUI owns the terminal. |

The engine maintains its own local session storage separately. The runner checks cached engine identity against the control plane and updates stale binaries. A download is verified when a valid checksum is published beside it; if none is available, the runner logs that verification was unavailable.

Stop a run from its control-plane page, or revoke the agent to stop its live runs and prevent new handshakes. Stop instructions arrive on the next heartbeat, normally within ten seconds. A SIGINT or SIGTERM delivered to the runner finishes the run as `killed`; a TUI exit can instead finish normally.

This standalone harness has no `resume` or `sessions` subcommand and no centralized recovery/checkpoint API. Rerunning a consumed install command does not resume it. Create a fresh install command to start a new managed run. An engine's local session continuation command is separate from the control plane's run identity and reporting lifecycle.

## Troubleshooting

| Symptom | Check |
|---|---|
| Handshake fails with 401 or 409 | Confirm the command targets the control plane that minted it; generate a fresh token if it expired, was consumed or belongs to a revoked agent. |
| Engine download returns 404 | Supply a built engine for the machine's platform through `--binaries`. A source-run control plane cannot serve Bun itself as the agent engine. |
| Checksum mismatch | The runner refuses the download. Correct the binary/checksum pair on the serving control plane, then retry with a fresh install command if the handshake already claimed the previous run. |
| Files are refused unexpectedly | Check the install working directory and the exact read/write grants. A deny also blocks writes; a read grant does not permit an edit. |
| Interactive mode fails or shows no runner messages | Use a real terminal and inspect the printed `run-<run-id>.log` path. |
| Model authentication fails | Use the selected provider's key and review any declared endpoint override. Preflight does not check provider authentication. |
| A report takes time to finish | Headless sessions keep a roughly 60-second idle window for follow-up messages. Outstanding permission requests may also keep work waiting. |

Run preflight again after correcting a machine or download problem:

```bash
node "$HOME/.agents-everywhere-runner/harness.cjs" --preflight --api-url=http://127.0.0.1:4800
```

For limits of command and path enforcement, read [SECURITY.md](../SECURITY.md).

## Use another control plane or runner distribution

A compatible server implements the handshake, heartbeat, events, permission-request and finish endpoints, and serves the installer, runner, platform binaries and health endpoint. See [Runner protocol](runner-protocol.md) for the request bodies and token lifecycle. The built-in control plane's `/api/agents/...` routes are its admin interface, separate from the runner's `/agents/runtime/...` routes.

For a custom runner distribution, create an entry point that calls `configureBrand` with its `Brand` before `runRunner`, then bundle it with `bundleRunner({ entry, outDir, brand })`. The bundler renders the matching installer names and checks that the output requires only Node built-ins. [`RunnerExtension`](../packages/harness/src/extension.ts) supports extra handshake capabilities, initial headless prompt context and accepted-heartbeat handling; it does not replace permission or lifecycle enforcement. Changes to entry points and extensions require bundling and serving a new runner for subsequent installs.

The public types and implementation are in [`protocol.ts`](../packages/harness/src/protocol.ts), [`brand.ts`](../packages/harness/src/brand.ts), [`run.ts`](../packages/harness/src/run.ts) and [`bundle.ts`](../packages/harness/script/bundle.ts). Server authors can also use the existing [`control-plane conformance suite`](../packages/control/test/conformance/suite.ts).
