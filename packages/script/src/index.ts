import { $ } from "bun"
import semver from "semver"
import path from "path"

const rootPkgPath = path.resolve(import.meta.dir, "../../../package.json")
const rootPkg = await Bun.file(rootPkgPath).json()
const expectedBunVersion = rootPkg.packageManager?.split("@")[1]

if (!expectedBunVersion) {
  throw new Error("packageManager field not found in root package.json")
}

// relax version requirement
const expectedBunVersionRange = `^${expectedBunVersion}`

if (!semver.satisfies(process.versions.bun, expectedBunVersionRange)) {
  throw new Error(`This script requires bun@${expectedBunVersionRange}, but you are using bun@${process.versions.bun}`)
}

const env = {
  AGENTS_EVERYWHERE_CHANNEL: process.env["AGENTS_EVERYWHERE_CHANNEL"],
  AGENTS_EVERYWHERE_VERSION: process.env["AGENTS_EVERYWHERE_VERSION"],
  AGENTS_EVERYWHERE_RELEASE: process.env["AGENTS_EVERYWHERE_RELEASE"],
}
const CHANNEL = await (async () => {
  if (env.AGENTS_EVERYWHERE_CHANNEL) return env.AGENTS_EVERYWHERE_CHANNEL
  if (env.AGENTS_EVERYWHERE_VERSION && !env.AGENTS_EVERYWHERE_VERSION.startsWith("0.0.0-")) return "latest"
  return await $`git branch --show-current`.text().then((x) => x.trim())
})()
const IS_PREVIEW = CHANNEL !== "latest"

const VERSION = (() => {
  if (env.AGENTS_EVERYWHERE_VERSION) return env.AGENTS_EVERYWHERE_VERSION
  if (IS_PREVIEW) return `0.0.0-${CHANNEL}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`
  // A release names its version: deriving it from a registry would let whoever
  // publishes under that name decide what this build calls itself.
  throw new Error("A release build needs AGENTS_EVERYWHERE_VERSION, for example 1.2.0")
})()

export const Script = {
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
  get preview() {
    return IS_PREVIEW
  },
  get release(): boolean {
    return !!env.AGENTS_EVERYWHERE_RELEASE
  },
}
console.log(`agents-everywhere script`, JSON.stringify(Script, null, 2))
