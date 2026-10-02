import fs from "fs"
import http from "http"
import https from "https"

export interface JsonResponse<T = any> {
  status: number
  data: T
}

export class HttpError extends Error {
  code?: string
  statusCode?: number
}

// A request that never answers used to wait forever. The interactive path
// polls the engine's server the moment it is spawned, and a listening socket
// accepts a connection slightly before the HTTP layer will answer on it: that
// one request hung, the poll loop awaiting it never advanced, and the run
// silently lost its cost, its token counts and every refusal it recorded.
// Nothing here is long-lived enough to want an unbounded wait; the SSE stream
// has its own request and is untouched by this.
export const REQUEST_TIMEOUT_MS = 30000

function transport(u: URL) {
  return u.protocol === "https:" ? https : http
}

/** A JSON request. Resolves with any status; rejects only when no answer came. */
export function request<T = any>(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<JsonResponse<T>> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const payload = body !== undefined ? JSON.stringify(body) : undefined
    const req = transport(u).request(
      u,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = ""
        res.on("data", (chunk) => {
          data += chunk
        })
        res.on("end", () => {
          clearTimeout(deadline)
          let parsed: any
          try {
            parsed = data ? JSON.parse(data) : {}
          } catch {
            parsed = { raw: data }
          }
          resolve({ status: res.statusCode || 0, data: parsed })
        })
      },
    )
    // A deadline for the whole exchange rather than the socket's idle timeout,
    // which not every runtime fires for a connection that was accepted and
    // then left silent, the exact case this guards.
    // It rejects by itself as well as destroying the request, because not every
    // runtime reports a destroyed request that never got a response as an error.
    const deadline =
      timeoutMs > 0
        ? setTimeout(() => {
            const err = new HttpError(`request timed out after ${timeoutMs}ms: ${method} ${url}`)
            err.code = "ETIMEDOUT"
            req.destroy(err)
            reject(err)
          }, timeoutMs)
        : undefined
    req.on("error", (err) => {
      clearTimeout(deadline)
      reject(err)
    })
    if (payload) req.write(payload)
    req.end()
  })
}

export interface RawResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

/** A request whose body is text, for services that do not speak JSON. */
export function rawRequest(
  url: string,
  {
    method = "GET",
    headers = {},
    body,
    timeoutMs = 8000,
  }: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = transport(u).request(u, { method, headers }, (res) => {
      let data = ""
      res.on("data", (chunk) => (data += chunk))
      res.on("end", () => {
        clearTimeout(deadline)
        resolve({ status: res.statusCode || 0, headers: res.headers, body: data })
      })
    })
    const deadline = setTimeout(() => {
      const err = new Error(`Request to ${url} timed out after ${timeoutMs}ms`)
      req.destroy(err)
      reject(err)
    }, timeoutMs)
    req.on("error", (err) => {
      clearTimeout(deadline)
      reject(err)
    })
    if (body) req.write(body)
    req.end()
  })
}

// Enough for a control plane that redirects to a release host that redirects
// to its storage; a loop is refused rather than followed forever.
const MAX_REDIRECTS = 5

function redirectTarget(res: http.IncomingMessage, from: URL): string | null {
  if (!res.statusCode || res.statusCode < 300 || res.statusCode >= 400 || !res.headers.location) return null
  return new URL(res.headers.location, from).toString()
}

/** Streams a download to disk: request() buffers whole responses as JSON,
 *  which is not right for a binary of about 100MB. Follows redirects. */
export function downloadFile(url: string, destPath: string, redirects = MAX_REDIRECTS): Promise<void> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = transport(u).get(u, (res) => {
      const next = redirectTarget(res, u)
      if (next) {
        res.resume()
        if (redirects <= 0) return reject(new HttpError(`too many redirects downloading ${url}`))
        downloadFile(next, destPath, redirects - 1).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        // statusCode is carried on the error so the caller can tell "this
        // build was never published" (404) from "this machine can't reach
        // the service": one is the deployment's fault, the other is the
        // machine's network, and they need different instructions.
        const err = new HttpError(`download failed (HTTP ${res.statusCode})`)
        err.statusCode = res.statusCode
        reject(err)
        return
      }
      const file = fs.createWriteStream(destPath, { mode: 0o755 })
      res.pipe(file)
      file.on("finish", () => file.close(() => resolve()))
      file.on("error", reject)
    })
    req.on("error", reject)
  })
}

export interface ServedFile {
  etag: string
  lastModified: string
  length: string
}

/** One small request that follows redirects and never throws: null when the
 *  URL cannot be reached, answers something other than 200, or times out. */
function probe<T>(
  url: string,
  method: "HEAD" | "GET",
  timeoutMs: number,
  read: (res: http.IncomingMessage, body: string) => T,
  redirects = MAX_REDIRECTS,
): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: T | null) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      resolve(value)
    }
    let req: http.ClientRequest | undefined
    const deadline = setTimeout(() => {
      req?.destroy()
      done(null)
    }, timeoutMs)
    try {
      const u = new URL(url)
      req = transport(u).request(u, { method }, (res) => {
        const next = redirectTarget(res, u)
        if (next) {
          res.resume()
          if (redirects <= 0) return done(null)
          probe(next, method, timeoutMs, read, redirects - 1).then(done)
          return
        }
        if (res.statusCode !== 200) {
          res.resume()
          return done(null)
        }
        let body = ""
        res.setEncoding("utf8")
        res.on("data", (chunk) => {
          // A checksum is 64 characters; anything this large is not one.
          if (body.length < 4096) body += chunk
        })
        res.on("end", () => done(read(res, body)))
      })
      req.on("error", () => done(null))
      req.end()
    } catch {
      done(null)
    }
  })
}

/** What a server currently serves at a URL, as cheaply as it can be asked. */
export function headFile(url: string, timeoutMs: number): Promise<ServedFile | null> {
  return probe(url, "HEAD", timeoutMs, (res) => ({
    etag: String(res.headers.etag || ""),
    lastModified: String(res.headers["last-modified"] || ""),
    length: String(res.headers["content-length"] || ""),
  }))
}

/** A small text file, or null when it cannot be had. */
export function fetchSmallText(url: string, timeoutMs: number): Promise<string | null> {
  return probe(url, "GET", timeoutMs, (_res, body) => body)
}
