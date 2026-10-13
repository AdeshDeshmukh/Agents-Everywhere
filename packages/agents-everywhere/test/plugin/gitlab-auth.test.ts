import { expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"

test.each([true, false])(
  "GitLab PAT auth shares the engine data path with XDG_DATA_HOME configured: %s",
  async (configured) => {
    await using tmp = await tmpdir()
    const dataHome = path.join(tmp.path, "share")
    const userHome = path.join(tmp.path, "home")
    const token = "test-only-gitlab-token"
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (
          new URL(request.url).pathname !== "/api/v4/user" ||
          request.headers.get("authorization") !== `Bearer ${token}`
        )
          return new Response("Unauthorized", { status: 401 })
        return Response.json({ id: 1 })
      },
    })
    try {
      const script = `
      import plugin from "opencode-gitlab-auth"
      import { Global } from "@agents-everywhere/core/global"
      import path from "path"
      import fs from "fs/promises"
      process.env.XDG_DATA_HOME = path.join(process.argv[3], "changed-data")
      const hooks = await plugin({})
      const result = await hooks.auth.methods[1].authorize({ instanceUrl: process.argv[1], token: process.argv[2] })
      if (result.type !== "success") throw new Error("PAT authorization failed")
      const authPath = path.join(Global.Path.data, "auth.json")
      const stored = await Bun.file(authPath).json()
      if (stored.gitlab.key !== process.argv[2]) throw new Error("Credential was not saved at the engine auth path")
      if (stored.gitlab.enterpriseUrl !== process.argv[1]) throw new Error("Instance URL was not saved")
      console.log(JSON.stringify({ data: Global.Path.data, mode: (await fs.stat(authPath)).mode & 0o777, log: await Bun.file(path.join(Global.Path.log, "gitlab-auth.log")).exists() }))
    `
      const child = Bun.spawn([process.execPath, "-e", script, server.url.origin, token, tmp.path], {
        cwd: path.resolve(import.meta.dir, "../.."),
        env: {
          ...process.env,
          // Give this child its own home so the default XDG path cannot touch real credentials.
          HOME: userHome,
          USERPROFILE: userHome,
          XDG_DATA_HOME: configured ? dataHome : undefined,
          XDG_CACHE_HOME: path.join(tmp.path, "cache"),
          XDG_CONFIG_HOME: path.join(tmp.path, "config"),
          XDG_STATE_HOME: path.join(tmp.path, "state"),
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(code, stderr).toBe(0)
      const result = JSON.parse(stdout)
      expect(result).toMatchObject({
        data: path.join(configured ? dataHome : path.join(userHome, ".local", "share"), "agents-everywhere"),
        log: true,
      })
      if (process.platform !== "win32") expect(result.mode).toBe(0o600)
    } finally {
      await server.stop(true)
    }
  },
  30_000,
)
