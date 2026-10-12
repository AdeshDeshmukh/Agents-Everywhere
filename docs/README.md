# agents-everywhere documentation

agents-everywhere is a fork of opencode. The engine keeps opencode's configuration format, so opencode's documentation at https://opencode.ai/docs still describes config files, agents, commands, providers, MCP servers and plugins. The pages here cover what this fork adds.

- [Running the control plane](control-plane.md): start `agents-everywhere control`, reach it from other machines, install an agent, and what protects what.
- [Using the harness](harness.md): create an example agent, install and check the runner, build its bundle, inspect logs, stop runs and connect another control plane.
- [Runner protocol](runner-protocol.md): how a runner and a control plane talk, for anyone writing their own control plane.
- Config schema: [`schema/config.json`](../schema/config.json) and [`schema/tui.json`](../schema/tui.json).
- Changes from upstream, including the permission hardening: the main [README](../README.md#changes-from-upstream).
