/**
 * Who may use the admin API: the one person holding the admin token.
 *
 * The token is generated on first start and printed once; only its argon2id
 * hash is stored. A browser exchanges it for a session cookie (HttpOnly,
 * SameSite=Strict) plus a CSRF token that every state-changing request must
 * echo in a header. A script can instead send the token itself as a bearer
 * credential, which a browser never does on its own, so it needs no CSRF check.
 */
import crypto from "crypto"
import { randomToken, sha256Hex } from "./crypto"
import { HttpError, json } from "./http"
import type { Store } from "./store"

export const SESSION_COOKIE = "ae_session"
export const CSRF_HEADER = "x-csrf-token"
const SESSION_SECONDS = 12 * 60 * 60
const ADMIN_TOKEN_PREFIX = "aect_"

// Five tries a minute per address: plenty for a person, useless for guessing a
// 256-bit token, and it keeps a flood from spending the server on argon2.
const LOGIN_ATTEMPTS = 5
const LOGIN_WINDOW_MS = 60_000
const MAX_TRACKED_ADDRESSES = 10_000

export class AdminAuth {
  private attempts = new Map<string, { count: number; resetAt: number }>()
  // Digest of the last bearer token that verified, so a script polling the API
  // pays for argon2 once rather than on every call.
  private verifiedBearer: Buffer | null = null

  constructor(
    private readonly store: Store,
    private readonly secureCookies: boolean,
  ) {}

  /** Creates the admin token on first start. Returns it when new, so it can be shown once. */
  async ensureAdminToken(): Promise<string | null> {
    if (this.store.adminTokenHash()) return null
    return this.rotateAdminToken()
  }

  /** Replaces the admin token and signs out every session. */
  async rotateAdminToken(): Promise<string> {
    const token = randomToken(ADMIN_TOKEN_PREFIX)
    this.store.setAdminTokenHash(await Bun.password.hash(token, { algorithm: "argon2id" }))
    this.store.deleteAllSessions()
    this.verifiedBearer = null
    return token
  }

  private async tokenMatches(token: string): Promise<boolean> {
    const hash = this.store.adminTokenHash()
    if (!hash || !token.startsWith(ADMIN_TOKEN_PREFIX)) return false
    return Bun.password.verify(token, hash)
  }

  private rateLimit(address: string) {
    const now = Date.now()
    if (this.attempts.size > MAX_TRACKED_ADDRESSES) {
      for (const [key, entry] of this.attempts) if (entry.resetAt <= now) this.attempts.delete(key)
    }
    const entry = this.attempts.get(address)
    if (!entry || entry.resetAt <= now) {
      this.attempts.set(address, { count: 1, resetAt: now + LOGIN_WINDOW_MS })
      return
    }
    entry.count++
    if (entry.count > LOGIN_ATTEMPTS) {
      throw new HttpError(429, "Too many sign-in attempts. Wait a minute and try again.")
    }
  }

  async login(token: string, address: string): Promise<Response> {
    this.rateLimit(address)
    if (!(await this.tokenMatches(token))) throw new HttpError(401, "That admin token is not valid.")
    const sessionId = crypto.randomBytes(32).toString("base64url")
    const csrfToken = crypto.randomBytes(32).toString("base64url")
    this.store.createSession(sha256Hex(sessionId), csrfToken, new Date(Date.now() + SESSION_SECONDS * 1000))
    return json({ csrf_token: csrfToken }, 200, { "Set-Cookie": this.cookie(sessionId, SESSION_SECONDS) })
  }

  logout(req: Request): Response {
    const id = this.sessionId(req)
    if (id) this.store.deleteSession(sha256Hex(id))
    return json({ ok: true }, 200, { "Set-Cookie": this.cookie("", 0) })
  }

  private cookie(value: string, maxAge: number): string {
    return [
      `${SESSION_COOKIE}=${value}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${maxAge}`,
      ...(this.secureCookies ? ["Secure"] : []),
    ].join("; ")
  }

  private sessionId(req: Request): string | null {
    const cookies = req.headers.get("cookie") || ""
    for (const part of cookies.split(";")) {
      const [name, ...rest] = part.trim().split("=")
      if (name === SESSION_COOKIE) return rest.join("=") || null
    }
    return null
  }

  /** Session state for the UI, or null when signed out. */
  current(req: Request): { csrfToken: string } | null {
    const id = this.sessionId(req)
    if (!id) return null
    const session = this.store.session(sha256Hex(id))
    return session ? { csrfToken: session.csrf_token } : null
  }

  /**
   * Admits a request to the admin API or throws 401/403. A cookie session must
   * also carry the CSRF token on anything that changes state, and come from
   * this server's own origin when the browser says where it came from.
   */
  async require(req: Request, publicOrigin: string, address: string) {
    const auth = req.headers.get("authorization") || ""
    const bearerToken = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
    if (bearerToken) {
      const digest = Buffer.from(sha256Hex(bearerToken), "hex")
      if (this.verifiedBearer && crypto.timingSafeEqual(digest, this.verifiedBearer)) return
      // Limited like sign-in: each guess costs an argon2 verification.
      this.rateLimit(address)
      if (!(await this.tokenMatches(bearerToken))) throw new HttpError(401, "That admin token is not valid.")
      this.verifiedBearer = digest
      return
    }

    const session = this.current(req)
    if (!session) throw new HttpError(401, "Sign in first.")
    if (req.method === "GET" || req.method === "HEAD") return

    const origin = req.headers.get("origin")
    if (origin && origin !== publicOrigin && origin !== new URL(req.url).origin) {
      throw new HttpError(403, "Cross-origin request refused.")
    }
    const given = Buffer.from(req.headers.get(CSRF_HEADER) || "")
    const expected = Buffer.from(session.csrfToken)
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      throw new HttpError(403, "Missing or stale CSRF token. Reload the page.")
    }
  }
}
