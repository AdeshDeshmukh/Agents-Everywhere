import { expect, test } from "bun:test"
import assert from "node:assert"
import http from "http"
import net from "net"
import { parseArgs } from "../src/args"
import { binaryIsCurrent, detectPlatform } from "../src/binary"
import { DECISION_REPLIES } from "../src/engine"
import { describeEndpoint, stripProviderEndpointOverrides } from "../src/environment"
import { request } from "../src/http"
import {
  createTranscript,
  describeToolCall,
  engineErrorMessage,
  errorEntry,
  safeToolInput,
  tokenCounts,
  transcriptEntry,
} from "../src/transcript"

test("parseArgs reads both the spaced and equals forms, and the preflight flag", () => {
  assert.strictEqual(parseArgs(["--token", "abc"]).token, "abc")
  assert.strictEqual(parseArgs(["--token=abc"]).token, "abc")
  assert.strictEqual(parseArgs(["--api-url", "https://x.test"]).apiUrl, "https://x.test")
  assert.strictEqual(parseArgs(["--api-url=https://x.test"]).apiUrl, "https://x.test")
  assert.strictEqual(parseArgs(["--preflight"]).preflight, true)
  assert.strictEqual(parseArgs([]).preflight, undefined)
})

test("detectPlatform only claims platforms the build matrix covers", () => {
  const detected = detectPlatform()
  if (detected !== null) assert.match(detected, /^(linux|darwin)-(x64|arm64)$/)
})

test("every decision maps to a reply the engine understands", () => {
  // "for this run" and "permanently" are the same instruction to the engine;
  // they differ only in whether the control plane also writes the rule back.
  assert.strictEqual(DECISION_REPLIES.approved_once, "once")
  assert.strictEqual(DECISION_REPLIES.approved_run, "always")
  assert.strictEqual(DECISION_REPLIES.approved_permanent, "always")
  assert.strictEqual(DECISION_REPLIES.denied, "reject")
  // An expired request is a refusal, not a silent pass.
  assert.strictEqual(DECISION_REPLIES.expired, "reject")
})

// ── Provider endpoint overrides ──────────────────────────────────────────────

test("a machine's own endpoint override does not redirect the run", () => {
  // The provider SDKs read this from the environment, and the harness hands the
  // agent its whole environment, so without this the machine decides where the
  // key the control plane handed over gets sent. A run configured for OpenAI went to a
  // gateway and came back "Invalid API Key", with nothing saying why.
  const env = {
    OPENAI_BASE_URL: "https://api.portkey.ai/v1",
    OPENAI_API_KEY: "sk-from-control-plane",
    PATH: "/usr/bin",
  }
  const removed = stripProviderEndpointOverrides(env, "openai", [])

  assert.deepStrictEqual(
    removed.map((r) => r.name),
    ["OPENAI_BASE_URL"],
  )
  assert.strictEqual(env.OPENAI_BASE_URL, undefined)
  // The key and everything unrelated are left exactly as they were.
  assert.strictEqual(env.OPENAI_API_KEY, "sk-from-control-plane")
  assert.strictEqual(env.PATH, "/usr/bin")
})

test("only the provider in use is touched", () => {
  const env = {
    OPENAI_BASE_URL: "https://gateway.test/v1",
    ANTHROPIC_BASE_URL: "https://other.test/v1",
  }
  stripProviderEndpointOverrides(env, "anthropic", [])

  assert.strictEqual(env.ANTHROPIC_BASE_URL, undefined)
  // Another provider's variable is none of this run's business.
  assert.strictEqual(env.OPENAI_BASE_URL, "https://gateway.test/v1")
})

test("every spelling the SDKs accept is covered", () => {
  const env = {
    OPENAI_BASE_URL: "a",
    OPENAI_API_BASE: "b",
    OPENAI_ENDPOINT: "c",
    OPENAI_API_URL: "d",
  }
  const removed = stripProviderEndpointOverrides(env, "openai", []).map((r) => r.name)
  assert.deepStrictEqual(removed.sort(), ["OPENAI_API_BASE", "OPENAI_API_URL", "OPENAI_BASE_URL", "OPENAI_ENDPOINT"])
})

test("a declared gateway is deliberate and is kept", () => {
  // Declaring the variable on the agent is how someone says "this machine
  // routes through a gateway and I mean it".
  const env = { OPENAI_BASE_URL: "https://api.portkey.ai/v1" }
  const removed = stripProviderEndpointOverrides(env, "openai", ["OPENAI_BASE_URL"])

  assert.deepStrictEqual(removed, [])
  assert.strictEqual(env.OPENAI_BASE_URL, "https://api.portkey.ai/v1")
})

test("a provider with no override set is left alone", () => {
  const env = { PATH: "/usr/bin" }
  assert.deepStrictEqual(stripProviderEndpointOverrides(env, "anthropic", []), [])
  assert.deepStrictEqual(Object.keys(env), ["PATH"])
})

// A cached engine binary used to be trusted forever, so a machine that had run
// once could never receive a fix. These pin the comparison that decides whether
// the copy on disk is still the one the service is serving.
test("a cached binary matching the served etag is current", () => {
  assert.equal(binaryIsCurrent({ etag: '"abc"', length: "10" }, { etag: '"abc"', length: "10" }), true)
})

test("a cached binary with a stale etag is not current", () => {
  assert.equal(binaryIsCurrent({ etag: '"abc"', length: "10" }, { etag: '"def"', length: "11" }), false)
})

test("last-modified decides when no etag is served", () => {
  const meta = { etag: "", lastModified: "Mon, 22 Sep 2026 04:23:00 GMT", length: "10" }
  assert.equal(binaryIsCurrent(meta, { etag: "", lastModified: meta.lastModified, length: "10" }), true)
  assert.equal(binaryIsCurrent(meta, { etag: "", lastModified: "Tue, 23 Sep 2026 04:23:00 GMT", length: "10" }), false)
})

test("a binary cached before any note was kept is not assumed current", () => {
  // Every machine installed before this check existed is in exactly this state,
  // so it has to mean "download once", not "trust it".
  assert.equal(binaryIsCurrent(null, { etag: '"abc"', length: "10" }), false)
})

test("an unreachable service never marks the cache stale", () => {
  // headBinary returns null when it cannot ask, and the caller keeps running
  // on the copy it has rather than failing the run.
  assert.equal(binaryIsCurrent({ etag: '"abc"' }, null), false)
})

// The engine's listening socket accepts a connection a moment before its HTTP
// layer will answer on it. Without a timeout that one request hung forever,
// the interactive poll loop awaiting it never advanced, and every interactive
// run lost its cost, its tokens and every refusal it recorded. A server that
// accepts and then says nothing reproduces exactly that.
test("a request to a server that never answers gives up instead of hanging", async () => {
  const held: net.Socket[] = []
  const server = net.createServer((socket) => held.push(socket))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as net.AddressInfo

  const started = Date.now()
  await assert.rejects(
    () => request("GET", `http://127.0.0.1:${port}/session`, undefined, {}, 400),
    (err: any) => err.code === "ETIMEDOUT",
  )
  const elapsed = Date.now() - started
  assert.ok(elapsed < 3000, `gave up after ${elapsed}ms, so it was still waiting on the socket`)

  for (const socket of held) socket.destroy()
  await new Promise((resolve) => server.close(resolve))
})

test("a normal request still succeeds and is not cut short", async () => {
  const server = http.createServer((req, res) => {
    // Slower than a trivial reply, well inside the timeout: a fix that simply
    // capped every request too aggressively would fail here.
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: true }))
    }, 150)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as net.AddressInfo

  const res = await request("GET", `http://127.0.0.1:${port}/session`, undefined, {}, 2000)
  assert.equal(res.status, 200)
  assert.deepEqual(res.data, { ok: true })

  await new Promise((resolve) => server.close(resolve))
})

// The engine splits a step's tokens so it can price each kind at its own rate.
// Counting only the headline fields reported 18 tokens in for a step that cost
// five cents, because with prompt caching nearly all the input is a cache read.
test("token counts include cached input and reasoning", () => {
  const step = { input: 18, output: 40, reasoning: 120, cache: { read: 14200, write: 900 } }
  assert.deepEqual(tokenCounts(step), { in: 18 + 14200 + 900, out: 40 + 120 })
})

test("token counts tolerate a provider that reports no cache or reasoning", () => {
  assert.deepEqual(tokenCounts({ input: 1200, output: 340 }), { in: 1200, out: 340 })
  assert.deepEqual(tokenCounts(undefined), { in: 0, out: 0 })
})

// The run transcript said "Step finished" and nothing else. It now says what
// was asked and what was done, and it must never carry what was seen: a file's
// contents or a command's output from the customer's machine.
const RUN_DIR = "/tmp/agent-demo"
const tool = (name: string, status: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: `prt_${name}_${status}`,
  type: "tool",
  tool: name,
  state: { status, input, output: "SECRET FILE CONTENTS", ...extra },
})

test("a finished tool call becomes a line saying what it did", () => {
  assert.deepEqual(
    transcriptEntry(tool("read", "completed", { filePath: `${RUN_DIR}/logs/app.log` }), "assistant", RUN_DIR),
    {
      kind: "tool",
      tool: "read",
      status: "done",
      verb: "Read",
      target: "./logs/app.log",
      message: "Read ./logs/app.log",
    },
  )
  assert.equal(
    transcriptEntry(tool("bash", "completed", { command: "git status" }), "assistant", RUN_DIR)!.message,
    "Ran git status",
  )
  assert.equal(
    transcriptEntry(tool("read", "completed", { filePath: "/etc/hostname" }), "assistant", RUN_DIR)!.message,
    "Read /etc/hostname",
  )
})

test("the transcript never carries what the agent read or wrote", () => {
  const write = transcriptEntry(
    tool("write", "completed", { filePath: `${RUN_DIR}/out/summary.txt`, content: "SECRET FILE CONTENTS" }),
    "assistant",
    RUN_DIR,
  )
  assert.equal(write!.message, "Wrote ./out/summary.txt")
  assert.ok(!JSON.stringify(write).includes("SECRET"), JSON.stringify(write))
  const read = transcriptEntry(tool("read", "completed", { filePath: `${RUN_DIR}/logs/app.log` }), "assistant", RUN_DIR)
  assert.ok(!JSON.stringify(read).includes("SECRET"), JSON.stringify(read))
})

test("a refused call's input keeps its target and loses its contents", () => {
  const input = safeToolInput({
    filePath: "./out/secrets/x.txt",
    content: "SECRET",
    oldString: "SECRET",
    newString: "SECRET",
  })
  assert.deepEqual(input, { filePath: "./out/secrets/x.txt" })
})

test("a failed call says so, and a refused one is left to its own event", () => {
  const failed = transcriptEntry(
    tool("bash", "error", { command: "git status" }, { error: "fatal: not a git repository" }),
    "assistant",
    RUN_DIR,
  )
  assert.equal(failed!.status, "failed")
  assert.equal(failed!.detail, "fatal: not a git repository")
  const refused = transcriptEntry(
    tool(
      "read",
      "error",
      { filePath: "/etc/hostname" },
      { error: "The user has specified a rule which prevents you from using this specific tool call" },
    ),
    "assistant",
    RUN_DIR,
  )
  assert.equal(refused, null)
})

test("unfinished calls and bookkeeping tools are not lines", () => {
  assert.equal(transcriptEntry(tool("bash", "running", { command: "sleep 5" }), "assistant", RUN_DIR), null)
  assert.equal(transcriptEntry(tool("bash", "pending", {}), "assistant", RUN_DIR), null)
  assert.equal(transcriptEntry(tool("todowrite", "completed", { todos: [] }), "assistant", RUN_DIR), null)
})

test("a typed prompt is recorded only where a person typed it", () => {
  const prompt = { id: "prt_u", type: "text", text: "Read ./logs/app.log" }
  assert.deepEqual(transcriptEntry(prompt, "user", RUN_DIR, { prompts: true }), {
    kind: "prompt",
    message: "Read ./logs/app.log",
  })
  assert.equal(transcriptEntry(prompt, "user", RUN_DIR, { prompts: false }), null)
})

test("a reply is recorded once it has finished streaming", () => {
  const streaming = { id: "prt_a", type: "text", text: "The log has" }
  assert.equal(transcriptEntry(streaming, "assistant", RUN_DIR), null)
  const done = { ...streaming, text: "The log has 3 error lines.", time: { start: 1, end: 2 } }
  assert.deepEqual(transcriptEntry(done, "assistant", RUN_DIR), {
    kind: "reply",
    message: "The log has 3 error lines.",
  })
})

test("a long reply is cut to a bounded length", () => {
  const done = { id: "prt_long", type: "text", text: "x".repeat(10000), time: { end: 1 } }
  assert.ok(transcriptEntry(done, "assistant", RUN_DIR)!.message.length <= 4000)
})

test("the stream is turned into lines once each, with roles learned from it", () => {
  const transcript = createTranscript(RUN_DIR, { prompts: true })
  const out: Array<{ kind: string; message: string }> = []
  const feed = (event: any) => {
    const entry = transcript.observe(event)
    if (entry) out.push(entry)
  }
  feed({ type: "message.updated", properties: { info: { id: "msg_u", role: "user" } } })
  feed({
    type: "message.part.updated",
    properties: { part: { id: "p1", messageID: "msg_u", type: "text", text: "count the errors" } },
  })
  // The same finished call reported again, as the engine does while it settles.
  const read = { ...tool("read", "completed", { filePath: `${RUN_DIR}/logs/app.log` }), id: "p2", messageID: "msg_a" }
  feed({ type: "message.updated", properties: { info: { id: "msg_a", role: "assistant" } } })
  feed({ type: "message.part.updated", properties: { part: read } })
  feed({ type: "message.part.updated", properties: { part: read } })
  feed({
    type: "message.part.updated",
    properties: { part: { id: "p3", messageID: "msg_a", type: "text", text: "3", time: { end: 1 } } },
  })
  assert.deepEqual(
    out.map((e) => `${e.kind}:${e.message}`),
    ["prompt:count the errors", "tool:Read ./logs/app.log", "reply:3"],
  )
})

test("a refused action is described as attempted, not as done", () => {
  // A refused write never happened; saying "Wrote" on the refusal line would
  // put a false statement in the one line a reader most needs to trust.
  assert.deepEqual(
    describeToolCall("write", { filePath: `${RUN_DIR}/out/secrets/x.txt`, content: "SECRET" }, RUN_DIR, true),
    {
      verb: "Write",
      target: "./out/secrets/x.txt",
      message: "Write ./out/secrets/x.txt",
    },
  )
  assert.equal(describeToolCall("bash", { command: "ls -la" }, RUN_DIR, true).message, "Run ls -la")
  assert.equal(describeToolCall("bash", { command: "ls -la" }, RUN_DIR).message, "Ran ls -la")
})

test("an unknown tool is still named rather than dropped", () => {
  assert.deepEqual(describeToolCall("lsp", {}, RUN_DIR), { verb: "Used lsp", target: "", message: "Used lsp" })
})

// A question the model never answered used to sit in the transcript with no
// reason given. The provider's own message says why; its headers do not belong.
test("a failed model call is a line saying why, once", () => {
  const info = {
    id: "msg_err",
    role: "assistant",
    error: {
      name: "APIError",
      data: {
        message: "Project `proj_x` does not have access to model `gpt-6-luna`",
        responseHeaders: { "cf-ray": "abc" },
      },
    },
  }
  assert.deepEqual(errorEntry(info), {
    kind: "error",
    message: "The model returned an error: Project `proj_x` does not have access to model `gpt-6-luna`",
  })
  assert.equal(errorEntry({ ...info, role: "user" }), null)
  assert.equal(errorEntry({ id: "msg_ok", role: "assistant" }), null)

  const transcript = createTranscript(RUN_DIR, { prompts: true })
  const event = { type: "message.updated", properties: { info } }
  assert.equal(transcript.observe(event)!.kind, "error")
  // The engine updates a message several times; the error is said once.
  assert.equal(transcript.observe(event), null)
  assert.ok(!JSON.stringify(errorEntry(info)).includes("cf-ray"))
})

test("an engine error reads as a sentence, never as its response dump", () => {
  const error = {
    name: "APIError",
    data: { message: "API key is invalid.", responseHeaders: { "cf-ray": "abc" }, url: "https://api.example.com/v1/x" },
  }
  assert.equal(engineErrorMessage(error), "API key is invalid.")
  assert.equal(engineErrorMessage({ name: "AbortError" }), "AbortError")
  assert.equal(engineErrorMessage(undefined), "")
})

test("an endpoint in a log line never carries its credentials", () => {
  assert.equal(
    describeEndpoint("https://user:s3cret@gateway.example.com/v1?key=abc#x"),
    "https://gateway.example.com/v1",
  )
  assert.equal(describeEndpoint("not a url"), "(not a URL)")
})

// A published checksum settles the question when both sides have one: the
// HTTP validators can disagree about the same file across a CDN, and agree
// about different ones after a redeploy that kept the length.
test("a published checksum decides over the HTTP validators", () => {
  const meta = { etag: '"abc"', length: "10", sha256: "a".repeat(64) }
  assert.equal(binaryIsCurrent(meta, { etag: '"other"', length: "11", sha256: "a".repeat(64) }), true)
  assert.equal(binaryIsCurrent(meta, { etag: '"abc"', length: "10", sha256: "b".repeat(64) }), false)
})

test("a binary installed before checksums existed falls back to the etag", () => {
  assert.equal(binaryIsCurrent({ etag: '"abc"' }, { etag: '"abc"', sha256: "a".repeat(64) }), true)
})
