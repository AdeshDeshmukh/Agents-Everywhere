// Every URL the engine publishes about itself. They point at the project's own
// repository rather than a domain: a link the model is told to fetch, or a
// schema an editor downloads, must resolve to something this project controls.
export const REPOSITORY_URL = "https://github.com/codity-ai/agents-everywhere"

const RAW_URL = "https://raw.githubusercontent.com/codity-ai/agents-everywhere/main"

export const DOCS_URL = `${RAW_URL}/docs/README.md`
export const CONFIG_SCHEMA_URL = `${RAW_URL}/schema/config.json`
export const TUI_SCHEMA_URL = `${RAW_URL}/schema/tui.json`

// Where the curl-installed binary and its checksums are published.
export const RELEASES_URL = `${REPOSITORY_URL}/releases`
