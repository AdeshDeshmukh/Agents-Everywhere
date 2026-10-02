/** An endpoint for a log line: where it points, without the user, password,
 *  query or fragment a URL can carry credentials in. */
export function describeEndpoint(value: unknown): string {
  try {
    const u = new URL(String(value))
    return `${u.protocol}//${u.host}${u.pathname}`
  } catch {
    return "(not a URL)"
  }
}

/**
 * Removes the machine's own redirection of this provider's API endpoint.
 *
 * The provider SDKs read `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL` and the like
 * from the environment, and the runner hands the agent its whole environment.
 * So a variable set on the machine silently decides where the key the control
 * plane just handed over gets sent: a run configured for OpenAI went to an LLM
 * gateway instead and came back "Invalid API Key", with nothing anywhere
 * saying the request had been redirected. The same mechanism sends the key
 * itself wherever that variable points, which is the part that matters.
 *
 * A machine that genuinely routes through a gateway says so by declaring the
 * variable on the agent. Returns what it removed, so the caller can say so.
 */
export function stripProviderEndpointOverrides(
  env: Record<string, string | undefined>,
  provider: string,
  declared: string[] = [],
): Array<{ name: string; value: string }> {
  if (!provider) return []
  const prefix = String(provider)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_")
  const declaredNames = new Set((declared || []).map((name) => String(name).toUpperCase()))
  const removed: Array<{ name: string; value: string }> = []
  for (const suffix of ["_BASE_URL", "_API_BASE", "_ENDPOINT", "_API_URL"]) {
    const name = `${prefix}${suffix}`
    const value = env[name]
    if (value && !declaredNames.has(name)) {
      removed.push({ name, value })
      delete env[name]
    }
  }
  return removed
}

/**
 * The environment variable a provider's SDK reads its key from. The three
 * large providers get their SDK's own name; anything else follows the
 * `<PROVIDER>_API_KEY` convention nearly every other provider uses.
 */
export function providerKeyEnvVar(provider: string): string {
  if (provider === "anthropic") return "ANTHROPIC_API_KEY"
  if (provider === "openai") return "OPENAI_API_KEY"
  if (provider === "google") return "GOOGLE_API_KEY"
  return `${provider.toUpperCase()}_API_KEY`
}
