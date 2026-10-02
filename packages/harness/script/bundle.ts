/**
 * Builds the two files a control plane serves for installing a runner: the
 * runner itself, bundled into one dependency-free CommonJS script for Node 18+,
 * and install.sh with the distribution's names filled in.
 *
 * Exported so another distribution can bundle its own entry file the same way.
 */
import fs from "fs"
import path from "path"
import type { Brand } from "../src/brand"

const MIN_NODE = "node18"
const INSTALL_TEMPLATE = path.join(import.meta.dir, "..", "install.sh")

export async function bundleRunner(input: { entry: string; outDir: string; brand: Brand }) {
  fs.mkdirSync(input.outDir, { recursive: true })

  const result = await Bun.build({
    entrypoints: [input.entry],
    target: "node",
    format: "cjs",
    minify: false,
    sourcemap: "none",
    define: { "process.env.NODE_ENV": '"production"' },
  })
  if (!result.success) throw new AggregateError(result.logs, "runner bundle failed")
  const [output] = result.outputs
  const code = await output.text()
  // A bundle that imports anything outside Node's own modules would fail on a
  // machine that has only Node, which is the whole point of this file.
  const foreign = [...code.matchAll(/require\(["']([^"']+)["']\)/g)]
    .map((m) => m[1])
    .filter((name) => !name.startsWith("node:") && !BUILTINS.has(name))
  if (foreign.length > 0)
    throw new Error(`runner bundle requires non-builtin modules: ${[...new Set(foreign)].join(", ")}`)

  const runnerPath = path.join(input.outDir, "harness.js")
  fs.writeFileSync(runnerPath, `#!/usr/bin/env node\n// Built for ${MIN_NODE}+ with no dependencies.\n${code}`, {
    mode: 0o755,
  })

  let script = fs.readFileSync(INSTALL_TEMPLATE, "utf8")
  const values: Record<string, string> = {
    NAME: input.brand.name,
    HOME_DIR_NAME: input.brand.homeDirName,
    INSTALL_HOME_ENV: input.brand.installHomeEnv,
    RUNNER_SOURCE_ENV: input.brand.runnerSourceEnv,
  }
  for (const [key, value] of Object.entries(values)) script = script.replaceAll(`{{${key}}}`, value)
  const unfilled = script.match(/\{\{[A-Z_]+\}\}/)
  if (unfilled) throw new Error(`install.sh template has an unfilled placeholder: ${unfilled[0]}`)
  fs.writeFileSync(path.join(input.outDir, "install.sh"), script, { mode: 0o755 })

  return { runnerPath, installPath: path.join(input.outDir, "install.sh") }
}

const BUILTINS = new Set((await import("module")).builtinModules.flatMap((name) => [name, `node:${name}`]))

if (import.meta.main) {
  const { OPEN_SOURCE_BRAND } = await import("../src/brand")
  const outDir = process.argv[2] ?? path.join(import.meta.dir, "..", "dist")
  const built = await bundleRunner({
    entry: path.join(import.meta.dir, "..", "src", "index.ts"),
    outDir,
    brand: OPEN_SOURCE_BRAND,
  })
  console.log(built.runnerPath)
  console.log(built.installPath)
}
