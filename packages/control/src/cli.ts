import os from "os"
import path from "path"
import { startControl, type ControlOptions, type RunningControl } from "./server"

export const DEFAULT_PORT = 4800

export interface CliOptions {
  port?: number
  hostname?: string
  data?: string
  publicUrl?: string
  binaries?: string
  tlsCert?: string
  tlsKey?: string
  insecure?: boolean
  rotateAdminToken?: boolean
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"])

export function defaultDataDir(): string {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(base, "agents-everywhere-control")
}

/**
 * Turns command-line options into a server configuration, refusing the ones
 * that would expose the admin token and every agent's LLM key in cleartext:
 * binding beyond this machine without TLS needs an explicit --insecure, meant
 * for a server behind a TLS-terminating proxy.
 */
export function resolveOptions(cli: CliOptions, log: (line: string) => void): ControlOptions {
  const port = cli.port ?? DEFAULT_PORT
  const hostname = cli.hostname ?? "127.0.0.1"
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port must be 0-65535, got ${cli.port}`)
  if (Boolean(cli.tlsCert) !== Boolean(cli.tlsKey)) throw new Error("--tls-cert and --tls-key go together")
  const tls = cli.tlsCert && cli.tlsKey ? { cert: cli.tlsCert, key: cli.tlsKey } : null

  if (!LOOPBACK.has(hostname) && !tls && !cli.insecure) {
    throw new Error(
      `Refusing to listen on ${hostname} without TLS: the admin token, sessions and every agent's LLM key would cross the ` +
        "network unencrypted. Pass --tls-cert and --tls-key, or --insecure if a TLS-terminating proxy sits in front.",
    )
  }

  let publicUrl = cli.publicUrl?.replace(/\/+$/, "")
  if (!publicUrl) {
    if (hostname === "0.0.0.0" || hostname === "::") {
      throw new Error(
        `Listening on ${hostname}: pass --public-url with the address machines should use to reach this server`,
      )
    }
    publicUrl = `${tls ? "https" : "http"}://${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`
  }
  const parsed = new URL(publicUrl)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("--public-url must be http(s)")
  if (parsed.protocol === "http:" && !LOOPBACK.has(parsed.hostname)) {
    log(`Warning: install commands will send tokens to ${publicUrl} over plain HTTP.`)
  }

  return {
    port,
    hostname,
    dataDir: cli.data ?? defaultDataDir(),
    publicUrl,
    binariesDir: cli.binaries ?? null,
    tls,
    log,
  }
}

export async function runControl(cli: CliOptions): Promise<RunningControl> {
  const log = (line: string) => process.stderr.write(`[control] ${line}\n`)
  const options = resolveOptions(cli, log)
  const control = await startControl(options)

  let adminToken = control.newAdminToken
  if (cli.rotateAdminToken && !adminToken) adminToken = await control.auth.rotateAdminToken()

  process.stderr.write(
    `\nagents-everywhere control plane\n\n  UI and API:   ${options.publicUrl}\n  Data:         ${options.dataDir}\n`,
  )
  if (adminToken) {
    process.stderr.write(
      `\n  Admin token (shown once, store it somewhere safe):\n\n    ${adminToken}\n\n` +
        "  Lost it? Restart with --rotate-admin-token to issue a new one; that signs out every session.\n\n",
    )
  } else {
    process.stderr.write("\n  Sign in with the admin token printed on first start.\n\n")
  }
  return control
}

/** Parses `--flag value` and `--flag=value` forms. */
export function parseCli(argv: string[]): CliOptions {
  const out: CliOptions = {}
  const take = (i: number, name: string): [string, number] => {
    const arg = argv[i]
    if (arg.includes("=")) return [arg.slice(arg.indexOf("=") + 1), i]
    const value = argv[i + 1]
    if (value === undefined) throw new Error(`${name} needs a value`)
    return [value, i + 1]
  }
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].split("=")[0]
    let value: string
    switch (name) {
      case "--port":
        ;[value, i] = take(i, name)
        out.port = Number(value)
        break
      case "--hostname":
        ;[value, i] = take(i, name)
        out.hostname = value
        break
      case "--data":
        ;[value, i] = take(i, name)
        out.data = value
        break
      case "--public-url":
        ;[value, i] = take(i, name)
        out.publicUrl = value
        break
      case "--binaries":
        ;[value, i] = take(i, name)
        out.binaries = value
        break
      case "--tls-cert":
        ;[value, i] = take(i, name)
        out.tlsCert = value
        break
      case "--tls-key":
        ;[value, i] = take(i, name)
        out.tlsKey = value
        break
      case "--insecure":
        out.insecure = true
        break
      case "--rotate-admin-token":
        out.rotateAdminToken = true
        break
      default:
        throw new Error(`Unknown option ${argv[i]}`)
    }
  }
  return out
}

if (import.meta.main) {
  try {
    const control = await runControl(parseCli(process.argv.slice(2)))
    const stop = () => void control.stop().then(() => process.exit(0))
    process.on("SIGINT", stop)
    process.on("SIGTERM", stop)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : err}\n`)
    process.exit(1)
  }
}
