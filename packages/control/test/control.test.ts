import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "fs"
import os from "os"
import path from "path"
import { resolveOptions } from "../src/cli"
import { sweep } from "../src/reaper"
import { startControl, type RunningControl } from "../src/server"
import { OpenSourceAdapter } from "./conformance/adapter"
import { CHECKS } from "./conformance/suite"

let control: RunningControl
let base: string
let adminToken: string
let dataDir: string
let binariesDir: string
const FAKE_BINARY = "#!/bin/sh\necho fake engine\n"

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-test-"))
  binariesDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-bin-"))
  fs.mkdirSync(path.join(binariesDir, "linux-x64"))
  fs.writeFileSync(path.join(binariesDir, "linux-x64", "agents-everywhere"), FAKE_BINARY)
  control = await startControl({
    port: 0,
    hostname: "127.0.0.1",
    dataDir,
    publicUrl: "http://127.0.0.1:0",
    binariesDir,
    tls: null,
    log: () => {},
  })
  base = `http://127.0.0.1:${control.server.port}`
  adminToken = control.newAdminToken!
})

afterAll(async () => {
  await control.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(binariesDir, { recursive: true, force: true })
})

const admin = (method: string, p: string, body?: unknown) =>
  fetch(`${base}${p}`, {
    method,
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

describe("runner protocol conformance", () => {
  for (const check of CHECKS) {
    test(check.name, () => check.run(new OpenSourceAdapter(base, adminToken)))
  }
})

describe("admin sign-in", () => {
  test("a wrong token is refused and a right one opens a session", async () => {
    const wrong = await fetch(`${base}/api/session`, {
      method: "POST",
      body: JSON.stringify({ token: "aect_wrong" }),
      headers: { "Content-Type": "application/json" },
    })
    expect(wrong.status).toBe(401)
    const right = await fetch(`${base}/api/session`, {
      method: "POST",
      body: JSON.stringify({ token: adminToken }),
      headers: { "Content-Type": "application/json" },
    })
    expect(right.status).toBe(200)
    const cookie = right.headers.get("set-cookie")!
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("SameSite=Strict")
  })

  test("a session cannot change anything without its CSRF token", async () => {
    const login = await fetch(`${base}/api/session`, {
      method: "POST",
      body: JSON.stringify({ token: adminToken }),
      headers: { "Content-Type": "application/json" },
    })
    const cookie = login.headers.get("set-cookie")!.split(";")[0]
    const { csrf_token } = (await login.json()) as { csrf_token: string }
    const body = JSON.stringify({ label: "csrf", task: "t", model_provider: "anthropic", model_name: "m" })

    const read = await fetch(`${base}/api/agents`, { headers: { Cookie: cookie } })
    expect(read.status).toBe(200)
    const forged = await fetch(`${base}/api/agents`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body,
    })
    expect(forged.status).toBe(403)
    const crossOrigin = await fetch(`${base}/api/agents`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf_token,
        Origin: "https://evil.example",
      },
      body,
    })
    expect(crossOrigin.status).toBe(403)
    const allowed = await fetch(`${base}/api/agents`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf_token },
      body,
    })
    expect(allowed.status).toBe(201)
  })

  test("the admin API refuses a request with no credentials", async () => {
    expect((await fetch(`${base}/api/agents`)).status).toBe(401)
  })

  test("sign-in attempts are rate limited", async () => {
    let last = 0
    for (let i = 0; i < 8; i++) {
      last = (
        await fetch(`${base}/api/session`, {
          method: "POST",
          body: JSON.stringify({ token: "aect_guess" }),
          headers: { "Content-Type": "application/json" },
        })
      ).status
    }
    expect(last).toBe(429)
  })
})

describe("what the server exposes", () => {
  test("every response carries the security headers, and the page a strict CSP", async () => {
    const page = await fetch(`${base}/`)
    expect(page.headers.get("x-content-type-options")).toBe("nosniff")
    expect(page.headers.get("x-frame-options")).toBe("DENY")
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'")
    expect(page.headers.get("content-security-policy")).not.toContain("unsafe-inline")
    const api = await fetch(`${base}/api/agents`)
    expect(api.headers.get("x-content-type-options")).toBe("nosniff")
  })

  test("an agent's LLM key is sealed at rest and never returned", async () => {
    const res = await admin("POST", "/api/agents", {
      label: "keyed",
      task: "t",
      model_provider: "anthropic",
      model_name: "m",
      llm_api_key: "sk-test-PLAINTEXT-MARKER",
    })
    const created = (await res.json()) as any
    expect(created.has_llm_api_key).toBe(true)
    expect(JSON.stringify(created)).not.toContain("PLAINTEXT-MARKER")
    const db = new Database(path.join(dataDir, "control.db"), { readonly: true })
    const row = db
      .query<{ llm_api_key_sealed: string }, [string]>("SELECT llm_api_key_sealed FROM agents WHERE id = ?")
      .get(created.id)!
    db.close()
    expect(row.llm_api_key_sealed).not.toContain("PLAINTEXT")
  })

  test("the install assets are served, and the runner is the dependency-free bundle", async () => {
    const install = await fetch(`${base}/agent/install.sh`)
    expect(install.status).toBe(200)
    expect(await install.text()).toContain("--api-url")
    const runner = await (await fetch(`${base}/agent/harness.js`)).text()
    expect(runner.startsWith("#!/usr/bin/env node")).toBe(true)
  })

  test("an engine binary is served with a checksum that matches it", async () => {
    const bin = await fetch(`${base}/agent/bin/linux-x64/agents-everywhere`)
    expect(bin.status).toBe(200)
    const bytes = Buffer.from(await bin.arrayBuffer())
    const sum = (await (await fetch(`${base}/agent/bin/linux-x64/agents-everywhere.sha256`)).text()).split(/\s+/)[0]
    expect(sum).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"))
    // Reaches the route as a platform of ".."; only named platforms are served.
    expect((await fetch(`${base}/agent/bin/%2E%2E/agents-everywhere`)).status).toBe(404)
    expect((await fetch(`${base}/agent/bin/linux-x64/secret.key`)).status).toBe(404)
    expect((await fetch(`${base}/agent/bin/windows-x64/agents-everywhere`)).status).toBe(404)
  })

  test("an install command carries a token and names this server", async () => {
    const created = (await (
      await admin("POST", "/api/agents", { label: "cmd", task: "t", model_provider: "anthropic", model_name: "m" })
    ).json()) as any
    const minted = (await (await admin("POST", `/api/agents/${created.id}/install-command`)).json()) as any
    expect(minted.command).toContain("/agent/install.sh | bash -s -- --token=")
  })
})

describe("stopping", () => {
  test("revoking stops live runs, removes unused commands and refuses new ones", async () => {
    const created = (await (
      await admin("POST", "/api/agents", { label: "revoke", task: "t", model_provider: "anthropic", model_name: "m" })
    ).json()) as any
    const unused = (await (await admin("POST", `/api/agents/${created.id}/install-command`)).json()) as any
    const revoked = (await (await admin("POST", `/api/agents/${created.id}/revoke`)).json()) as any
    expect(revoked.status).toBe("revoked")
    const token = String(unused.command).match(/--token=(\S+)/)![1]
    const hs = await fetch(`${base}/agents/runtime/handshake`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: "{}",
    })
    expect(hs.status).toBe(409)
    expect((await admin("POST", `/api/agents/${created.id}/install-command`)).status).toBe(409)
  })

  test("the sweep ends runs that stopped reporting and removes stale install commands", async () => {
    const created = (await (
      await admin("POST", "/api/agents", { label: "sweep", task: "t", model_provider: "anthropic", model_name: "m" })
    ).json()) as any
    await admin("POST", `/api/agents/${created.id}/install-command`)
    const future = Date.now() + 60 * 60_000
    const result = sweep(control.store, future)
    expect(result.unclaimed).toBeGreaterThan(0)
    expect(result.lost).toBeGreaterThan(0)
  })
})

describe("listening safely", () => {
  test("refuses to listen beyond this machine without TLS unless told it is behind a proxy", () => {
    expect(() => resolveOptions({ hostname: "0.0.0.0", publicUrl: "https://x.example" }, () => {})).toThrow(
      /without TLS/,
    )
    expect(
      resolveOptions({ hostname: "0.0.0.0", publicUrl: "https://x.example", insecure: true }, () => {}).publicUrl,
    ).toBe("https://x.example")
    expect(() => resolveOptions({ hostname: "0.0.0.0", insecure: true }, () => {})).toThrow(/--public-url/)
  })
})
