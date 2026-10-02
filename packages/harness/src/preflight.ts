import fs from "fs"
import { brand } from "./brand"
import { detectPlatform, engineBinaryUrl, engineBinDir, engineBinPath, hasEngineBinary } from "./binary"
import { request } from "./http"

const MIN_NODE_MAJOR = 18

interface Check {
  name: string
  ok: boolean
  detail: string
  /** A check that is not required is reported but does not fail preflight. */
  required: boolean
}

/**
 * Checks everything a run needs from the machine itself, before any token is
 * involved, and says which part is missing rather than failing later as a
 * generic install error. Run it first on a machine that is not behaving:
 *
 *   node harness.js --preflight --api-url=https://control.example.com
 */
export async function runPreflight(apiUrl: string): Promise<boolean> {
  const checks: Check[] = []
  const add = (name: string, ok: boolean, detail: string, required = true) =>
    checks.push({ name, ok, detail, required })

  const nodeMajor = Number(process.versions.node.split(".")[0])
  add(
    "Node.js",
    nodeMajor >= MIN_NODE_MAJOR,
    nodeMajor >= MIN_NODE_MAJOR
      ? `v${process.versions.node}`
      : `v${process.versions.node}, needs v${MIN_NODE_MAJOR}+ (Amazon Linux 2023: dnf install -y nodejs)`,
  )

  const platform = detectPlatform()
  add("Platform", Boolean(platform), platform || `${process.platform}/${process.arch} has no agents-everywhere build`)

  try {
    fs.mkdirSync(engineBinDir(), { recursive: true })
    fs.accessSync(engineBinDir(), fs.constants.W_OK)
    add("Install dir", true, engineBinDir())
  } catch (err: any) {
    add("Install dir", false, `${engineBinDir()} is not writable (${err.code || err})`)
  }

  try {
    const res = await request("GET", `${apiUrl}/health`)
    add("Control plane reachable", res.status >= 200 && res.status < 400, `GET ${apiUrl}/health -> HTTP ${res.status}`)
  } catch (err: any) {
    add(
      "Control plane reachable",
      false,
      `GET ${apiUrl}/health failed (${err.code || err}), check egress, security groups, and proxy settings`,
    )
  }

  if (hasEngineBinary()) {
    add("Agent binary", true, `already cached at ${engineBinPath()}`)
  } else if (!platform) {
    add("Agent binary", false, "skipped, no build exists for this platform")
  } else {
    const url = engineBinaryUrl(apiUrl, platform)
    try {
      const res = await request("HEAD", url)
      add(
        "Agent binary",
        res.status === 200,
        res.status === 200
          ? `downloadable from ${url}`
          : `HTTP ${res.status} from ${url}, no build published for ${platform}`,
      )
    } catch (err: any) {
      add("Agent binary", false, `${url} unreachable (${err.code || err})`)
    }
  }

  const hasTty = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  add(
    "Terminal (interactive mode only)",
    hasTty,
    hasTty ? `TERM=${process.env.TERM || "(unset)"}` : "no TTY on stdin/stdout, interactive mode needs one",
    false,
  )

  const width = Math.max(...checks.map((c) => c.name.length))
  process.stdout.write(`\n${brand().name} preflight\n\n`)
  for (const c of checks) {
    const mark = c.ok ? "ok  " : c.required ? "FAIL" : "warn"
    process.stdout.write(`  [${mark}] ${c.name.padEnd(width)}  ${c.detail}\n`)
  }
  const failed = checks.filter((c) => c.required && !c.ok)
  process.stdout.write(
    failed.length === 0
      ? "\nAll required checks passed.\n\n"
      : `\n${failed.length} required check(s) failed: ${failed.map((c) => c.name).join(", ")}\n\n`,
  )
  return failed.length === 0
}
