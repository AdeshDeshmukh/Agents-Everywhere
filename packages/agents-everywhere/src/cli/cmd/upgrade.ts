import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"

export const UpgradeCommand = {
  command: "upgrade [target]",
  describe: "upgrade agents-everywhere to the latest or a specific version",
  builder: (yargs: Argv) => {
    return yargs
      .positional("target", {
        describe: "version to upgrade to, for ex '0.1.48' or 'v0.1.48'",
        type: "string",
      })
      .option("method", {
        alias: "m",
        describe: "installation method to use",
        type: "string",
        choices: ["curl", "npm", "pnpm", "bun", "brew", "choco", "scoop"],
      })
  },
  // Every distribution channel this used to support (curl install script,
  // npm, brew tap, choco, scoop, GitHub releases) points at a package/repo
  // that doesn't exist yet for this fork — none of it has been published
  // anywhere. Fail closed rather than 404ing against opencode.ai or a
  // nonexistent package, until a real release pipeline exists.
  handler: async () => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Upgrade")
    prompts.log.error("Self-update isn't available yet in this build — no release channel has been published.")
    prompts.outro("Done")
  },
}
