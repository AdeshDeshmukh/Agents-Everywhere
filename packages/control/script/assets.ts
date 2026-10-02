/**
 * Builds what the control plane serves: the runner and its install script, and
 * the web UI. `buildAssets` is used when running from source; a release build
 * of the engine embeds the output of `assetsModule` instead, so the binary
 * needs nothing beside it.
 */
import fs from "fs"
import os from "os"
import path from "path"
import { bundleRunner } from "@agents-everywhere/harness/bundle"
import { OPEN_SOURCE_BRAND } from "@agents-everywhere/harness/brand"
import type { Assets } from "../src/assets"

const UI_DIR = path.join(import.meta.dir, "..", "ui")
const RUNNER_ENTRY = path.join(import.meta.dir, "..", "..", "harness", "src", "index.ts")

// Archivo and JetBrains Mono, both SIL Open Font License 1.1 (see ui/fonts).
const font = (name: string) => ({
  body: fs.readFileSync(path.join(UI_DIR, "fonts", name)).toString("base64"),
  type: "font/woff2",
  encoding: "base64" as const,
})

async function buildUiScript(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [path.join(UI_DIR, "app.ts")],
    target: "browser",
    format: "esm",
    minify: true,
  })
  if (!result.success) throw new AggregateError(result.logs, "control UI build failed")
  return result.outputs[0].text()
}

export async function buildAssets(): Promise<Assets> {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-assets-"))
  try {
    const runner = await bundleRunner({ entry: RUNNER_ENTRY, outDir, brand: OPEN_SOURCE_BRAND })
    return {
      runner: fs.readFileSync(runner.runnerPath, "utf8"),
      install: fs.readFileSync(runner.installPath, "utf8"),
      ui: {
        "index.html": {
          body: fs.readFileSync(path.join(UI_DIR, "index.html"), "utf8"),
          type: "text/html; charset=utf-8",
        },
        "styles.css": {
          body: fs.readFileSync(path.join(UI_DIR, "styles.css"), "utf8"),
          type: "text/css; charset=utf-8",
        },
        "logo.svg": { body: fs.readFileSync(path.join(UI_DIR, "logo.svg"), "utf8"), type: "image/svg+xml" },
        "fonts/archivo.woff2": font("archivo.woff2"),
        "fonts/jetbrains-mono.woff2": font("jetbrains-mono.woff2"),
        "app.js": { body: await buildUiScript(), type: "application/javascript; charset=utf-8" },
      },
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true })
  }
}

/** The source of a module that exports the built assets, for embedding. */
export async function assetsModule(): Promise<string> {
  return `export default ${JSON.stringify(await buildAssets())}\n`
}
