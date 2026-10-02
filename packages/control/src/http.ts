import type { z } from "zod"

/** A failure the caller can act on, answered as `{ "detail": message }`. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
}

export function withSecurityHeaders(res: Response, tls: boolean): Response {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!res.headers.has(name)) res.headers.set(name, value)
  }
  if (tls) res.headers.set("Strict-Transport-Security", "max-age=31536000")
  return res
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  })
}

export function errorResponse(err: unknown, log: (line: string) => void): Response {
  if (err instanceof HttpError) return json({ detail: err.message }, err.status)
  // Unexpected: logged with its stack for whoever runs the server, and answered
  // without internals for whoever called it.
  log(`Unhandled error: ${err instanceof Error ? err.stack || err.message : String(err)}`)
  return json({ detail: "Internal error" }, 500)
}

/** Reads and validates a JSON body, refusing anything larger than `maxBytes`. */
export async function readBody<S extends z.ZodType>(
  req: Request,
  schema: S,
  maxBytes: number,
  optional = false,
): Promise<z.infer<S>> {
  const declared = Number(req.headers.get("content-length") || "0")
  if (declared > maxBytes) throw new HttpError(413, `Request body is larger than ${maxBytes} bytes`)
  const text = await req.text()
  if (Buffer.byteLength(text) > maxBytes) throw new HttpError(413, `Request body is larger than ${maxBytes} bytes`)
  let value: unknown
  if (!text.trim()) {
    if (!optional) throw new HttpError(422, "Request body is required")
    value = {}
  } else {
    try {
      value = JSON.parse(text)
    } catch {
      throw new HttpError(400, "Request body is not valid JSON")
    }
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue.path.length ? `${issue.path.join(".")}: ` : ""
    throw new HttpError(422, `${where}${issue.message}`)
  }
  return parsed.data
}

export function bearer(req: Request): string | null {
  const header = req.headers.get("authorization") || ""
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : null
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

export function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}
