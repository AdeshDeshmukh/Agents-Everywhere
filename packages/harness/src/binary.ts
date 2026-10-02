import crypto from "crypto"
import fs from "fs"
import path from "path"
import { runnerHome } from "./brand"
import { downloadFile, fetchSmallText, headFile, HttpError, type ServedFile } from "./http"

// A cached binary is revalidated against the service before it is trusted, but
// not at the cost of the run: a machine that cannot reach the service keeps
// running the copy it has.
const BINARY_CHECK_TIMEOUT_MS = 5000

export function engineBinDir(): string {
  return path.join(runnerHome(), "bin")
}

export function engineBinPath(): string {
  return path.join(engineBinDir(), process.platform === "win32" ? "agents-everywhere.exe" : "agents-everywhere")
}

function metaPath(): string {
  return `${engineBinPath()}.meta.json`
}

/**
 * Maps Node's own platform and arch names to the build matrix's naming (see
 * packages/agents-everywhere/script/build.ts), limited to what is actually
 * built and published: linux and darwin, x64 and arm64, glibc only.
 */
export function detectPlatform(): string | null {
  const osName = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null
  if (!osName || !arch) return null
  return `${osName}-${arch}`
}

/** Where a control plane serves the engine for one platform. */
export function engineBinaryUrl(apiUrl: string, platform: string): string {
  return `${apiUrl}/agent/bin/${platform}/agents-everywhere`
}

export function hasEngineBinary(): boolean {
  return fs.existsSync(engineBinPath())
}

/** What is known about the binary on disk, and about one being served. */
export interface BinaryIdentity extends Partial<ServedFile> {
  sha256?: string
}

function readMeta(): BinaryIdentity | null {
  try {
    return JSON.parse(fs.readFileSync(metaPath(), "utf8"))
  } catch {
    return null
  }
}

function writeMeta(meta: BinaryIdentity) {
  try {
    fs.writeFileSync(metaPath(), JSON.stringify(meta), { mode: 0o600 })
  } catch {
    // A missing note means the next run re-downloads once. Losing a run over
    // it would be the worse trade.
  }
}

/**
 * Whether the binary on disk is the one being served. A published checksum is
 * the answer when both sides have one; otherwise the HTTP validators decide,
 * etag first, then last-modified, then length.
 */
export function binaryIsCurrent(meta: BinaryIdentity | null, served: BinaryIdentity | null): boolean {
  if (!meta || !served) return false
  if (served.sha256 && meta.sha256) return served.sha256 === meta.sha256
  if (served.etag && meta.etag) return served.etag === meta.etag
  if (served.lastModified && meta.lastModified) return served.lastModified === meta.lastModified
  return Boolean(served.length) && served.length === meta.length
}

/**
 * The checksum published beside a binary at `<url>.sha256`, in the
 * `sha256sum` format (the digest, optionally followed by a file name). Null
 * when none is published or it cannot be read.
 *
 * It comes from the same server as the binary, so it catches a truncated or
 * corrupted download and a cache serving a stale file, not a compromised
 * server. That trust is the TLS connection's job.
 */
export async function publishedChecksum(url: string): Promise<string | null> {
  const text = await fetchSmallText(`${url}.sha256`, BINARY_CHECK_TIMEOUT_MS)
  const digest = text?.trim().split(/\s+/)[0]?.toLowerCase() ?? ""
  return /^[0-9a-f]{64}$/.test(digest) ? digest : null
}

export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256")
    fs.createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject)
  })
}

async function servedIdentity(url: string): Promise<BinaryIdentity | null> {
  const served = await headFile(url, BINARY_CHECK_TIMEOUT_MS)
  if (!served) return null
  const sha256 = await publishedChecksum(url)
  return sha256 ? { ...served, sha256 } : served
}

export type InstallResult =
  | { ok: true; reason: "cached" | "cached_unverified" | "downloaded" }
  | {
      ok: false
      reason:
        | "unsupported_platform"
        | "binary_not_published"
        | "network_unreachable"
        | "download_failed"
        | "checksum_mismatch"
    }

/**
 * The point of a curl-and-run install command is that nobody separately
 * installs a coding agent first, so when the engine is not cached it is
 * fetched from the same control plane the install command came from.
 */
export async function ensureEngineInstalled(apiUrl: string, onLine: (line: string) => void): Promise<InstallResult> {
  const platform = detectPlatform()
  if (!platform) {
    onLine(
      `Unsupported platform (${process.platform}/${process.arch}): agents-everywhere has no build for this machine yet.`,
    )
    return { ok: false, reason: "unsupported_platform" }
  }

  const url = engineBinaryUrl(apiUrl, platform)

  // A cached binary used to be trusted forever, so a machine that had run once
  // never saw another build: an engine fix, including a permission fix, could
  // not reach it. One HEAD per run settles it.
  if (hasEngineBinary()) {
    const served = await servedIdentity(url)
    if (!served) return { ok: true, reason: "cached_unverified" }
    if (binaryIsCurrent(readMeta(), served)) return { ok: true, reason: "cached" }
    onLine("A newer agents-everywhere build is available, updating...")
  } else {
    onLine(`agents-everywhere not found, installing from ${url} (one-time download)...`)
  }

  fs.mkdirSync(engineBinDir(), { recursive: true })
  const tmpPath = `${engineBinPath()}.download`
  const discard = () => {
    try {
      fs.unlinkSync(tmpPath)
    } catch {
      /* best-effort cleanup */
    }
  }
  try {
    await downloadFile(url, tmpPath)
  } catch (err) {
    discard()
    const e = err as HttpError
    if (e && e.statusCode === 404) {
      onLine(
        `No agents-everywhere build is published for ${platform} at ${url} (HTTP 404). ` +
          "This is a gap on the control plane's side, not a problem with this machine: it serves the " +
          "install script but not the agent binary it needs. Report it rather than retrying.",
      )
      return { ok: false, reason: "binary_not_published" }
    }
    if (e && (e.code === "ENOTFOUND" || e.code === "ECONNREFUSED" || e.code === "ETIMEDOUT")) {
      onLine(
        `Could not reach ${url} from this machine (${e.code}). Check outbound HTTPS egress, ` +
          "security-group rules, and any proxy this host requires.",
      )
      return { ok: false, reason: "network_unreachable" }
    }
    onLine(`agents-everywhere installation failed: ${err}`)
    return { ok: false, reason: "download_failed" }
  }

  const expected = await publishedChecksum(url)
  const actual = await sha256File(tmpPath)
  if (expected && expected !== actual) {
    discard()
    onLine(
      `The downloaded agent does not match its published checksum (expected ${expected}, got ${actual}). ` +
        "Not installing it. Try again; if it keeps happening, the control plane is serving a damaged file.",
    )
    return { ok: false, reason: "checksum_mismatch" }
  }
  if (!expected) onLine(`No checksum is published at ${url}.sha256, so the download could not be verified.`)

  fs.chmodSync(tmpPath, 0o755)
  fs.renameSync(tmpPath, engineBinPath())

  const served = await headFile(url, BINARY_CHECK_TIMEOUT_MS)
  writeMeta({ ...(served || {}), sha256: actual })
  onLine("agents-everywhere installed successfully.")
  return { ok: true, reason: "downloaded" }
}
