export const go = {
  left: ["    ", "█▀▀▀", "█_^█", "▀▀▀▀"],
  right: ["    ", "█▀▀█", "█__█", "▀▀▀▀"],
}

export const WORDMARK = "AgentsEverywhere"

// Small inline wordmark for the exit-splash / session-continuation banners
// (packages/agents-everywhere/src/cli/cmd/run/splash.ts and
// packages/tui/src/util/presentation.ts), which render into terminal
// scrollback a line at a time rather than as an OpenTUI component — so they
// can't use the ascii_font renderable the big home-screen logo (component/
// logo.tsx) does. Plain text, no icon glyph.
export const logo = {
  left: ["", "", "", ""],
  right: ["", "", WORDMARK, ""],
}

export const marks = "_^~,"
