/**
 * What a machine downloads to become a runner, and the web UI's files.
 *
 * A release build of the engine embeds these (see script/assets.ts), so the
 * one binary serves everything. Running from source, they are built on first
 * start instead.
 */
import crypto from "crypto"
import fs from "fs"
import path from "path"
import { detectPlatform } from "@agents-everywhere/harness/binary"
import { InstallationVersion } from "@agents-everywhere/core/installation/version"
import { RELEASES_URL } from "@agents-everywhere/core/project-links"
import { json } from "./http"

export interface StaticFile {
  body: string
  type: string
  /** Set for binary files (fonts), which travel as base64 so they can be embedded. */
  encoding?: "base64"
}

export interface Assets {
  runner: string
  install: string
  ui: Record<string, StaticFile>
}

const PLATFORMS = new Set(["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"])
const BINARY_NAME = "agents-everywhere"

export async function loadAssets(): Promise<Assets> {
  try {
    // @ts-expect-error generated at release build time; absent when running from source
    const embedded = await import("agents-everywhere-control-assets.gen.ts")
    return embedded.default as Assets
  } catch {
    const { buildAssets } = await import("../script/assets")
    return buildAssets()
  }
}

interface Digest {
  sha256: string
  mtimeMs: number
  size: number
}

/**
 * Serves the engine binary a runner asks for, with its checksum beside it at
 * `<url>.sha256`. In order: a directory given with --binaries, then this
 * process's own executable when it is the engine and the platform matches,
 * then a redirect to the release that matches this server's version.
 */
export class BinaryServer {
  private digests = new Map<string, Digest>()

  constructor(private readonly binariesDir: string | null) {}

  private localFile(platform: string): string | null {
    if (this.binariesDir) {
      const file = path.join(this.binariesDir, platform, BINARY_NAME)
      return fs.existsSync(file) ? file : null
    }
    const self = process.execPath
    if (path.basename(self) === BINARY_NAME && detectPlatform() === platform) return self
    return null
  }

  private async digest(file: string): Promise<string> {
    const stat = fs.statSync(file)
    const cached = this.digests.get(file)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.sha256
    const hash = crypto.createHash("sha256")
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
    const sha256 = hash.digest("hex")
    this.digests.set(file, { sha256, mtimeMs: stat.mtimeMs, size: stat.size })
    return sha256
  }

  async serve(req: Request, platform: string, checksum: boolean): Promise<Response> {
    if (!PLATFORMS.has(platform)) return json({ detail: `No agents-everywhere build exists for ${platform}` }, 404)
    const file = this.localFile(platform)
    if (file) {
      const sha256 = await this.digest(file)
      if (checksum) return new Response(`${sha256}  ${BINARY_NAME}\n`, { headers: { "Content-Type": "text/plain" } })
      const stat = fs.statSync(file)
      return new Response(req.method === "HEAD" ? null : Bun.file(file), {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(stat.size),
          ETag: `"${sha256}"`,
          "Last-Modified": stat.mtime.toUTCString(),
        },
      })
    }
    if (InstallationVersion === "local") {
      return json(
        {
          detail:
            `No engine binary for ${platform} is available here. This control plane is running from source, so pass ` +
            "--binaries <dir> with <dir>/<platform>/agents-everywhere built by packages/agents-everywhere/script/build.ts.",
        },
        404,
      )
    }
    const asset = `${RELEASES_URL}/download/v${InstallationVersion}/${BINARY_NAME}-${platform}${checksum ? ".sha256" : ""}`
    return new Response(null, { status: 302, headers: { Location: asset } })
  }
}
