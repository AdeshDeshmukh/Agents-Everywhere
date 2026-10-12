# Harness package

The dependency-free Node.js runner used by the self-hosted Agents Everywhere control plane. It exchanges an install token for a run, translates permission rules into engine configuration, starts the engine and reports activity to the control plane.

Read [Using the harness](../../docs/harness.md) for setup, an example agent, independent bundling, options, troubleshooting and custom control-plane integration. The [runner protocol](../../docs/runner-protocol.md) documents the runtime API.

From the repository root, build the runner and rendered installer with:

```bash
bun run --cwd packages/harness build
```

The output is `dist/harness.js` and `dist/install.sh` inside this package. The installer saves the CommonJS bundle as `harness.cjs` on the agent machine. The tracked `install.sh` is a template; use the generated installer.
