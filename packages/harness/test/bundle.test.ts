import { afterAll, expect, test } from "bun:test"
import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { bundleRunner } from "../script/bundle"
import { OPEN_SOURCE_BRAND } from "../src/brand"

// The install contract is one file that runs on a machine with nothing but
// Node. These build it and run it the way a machine would.
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-bundle-"))
afterAll(() => fs.rmSync(outDir, { recursive: true, force: true }))

const built = bundleRunner({
  entry: path.join(import.meta.dir, "..", "src", "index.ts"),
  outDir,
  brand: OPEN_SOURCE_BRAND,
})

test("the bundle runs under plain node without a token and says what is missing", async () => {
  const { runnerPath } = await built
  let stderr = ""
  let status = 0
  try {
    execFileSync("node", [runnerPath], { cwd: outDir, env: { PATH: process.env.PATH, HOME: outDir }, stdio: "pipe" })
  } catch (err: any) {
    status = err.status
    stderr = String(err.stderr)
  }
  expect(status).toBe(1)
  expect(stderr).toContain("[agents-everywhere-runner] Missing --token")
})

test("install.sh has every placeholder filled and is valid bash", async () => {
  const { installPath } = await built
  const script = fs.readFileSync(installPath, "utf8")
  expect(script).not.toMatch(/\{\{[A-Z_]+\}\}/)
  expect(script).toContain('RUNNER_URL="${AGENTS_EVERYWHERE_RUNNER_SOURCE:-${API_URL:+$API_URL/agent/harness.js}}"')
  execFileSync("bash", ["-n", installPath])
})

// A package.json with "type": "module" anywhere above the install directory
// used to make Node load the runner as an ES module, which fails on `require`.
test("the installed runner still loads under an ES-module package", async () => {
  const { runnerPath } = await built
  const home = fs.mkdtempSync(path.join(outDir, "home-"))
  fs.writeFileSync(path.join(home, "package.json"), JSON.stringify({ type: "module" }))
  const installed = path.join(home, ".agents-everywhere-runner", "harness.cjs")
  fs.mkdirSync(path.dirname(installed), { recursive: true })
  fs.copyFileSync(runnerPath, installed)
  let stderr = ""
  try {
    execFileSync("node", [installed], { cwd: home, env: { PATH: process.env.PATH, HOME: home }, stdio: "pipe" })
  } catch (err: any) {
    stderr = String(err.stderr)
  }
  expect(stderr).toContain("Missing --token")
})

test("install.sh refuses to guess a control plane", async () => {
  const { installPath } = await built
  let stderr = ""
  try {
    execFileSync("bash", [installPath, "--token=x"], { env: { PATH: process.env.PATH, HOME: outDir }, stdio: "pipe" })
  } catch (err: any) {
    stderr = String(err.stderr)
  }
  expect(stderr).toContain("missing --api-url")
})
