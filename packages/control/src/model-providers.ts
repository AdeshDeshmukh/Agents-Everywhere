/**
 * The providers an agent can run on. The runner hands the stored key to the
 * engine under the variable each provider's SDK reads, and the engine prices a
 * run from the models.dev entry for the model, so both sides need the same list.
 */
export const MODEL_PROVIDERS = [
  { id: "anthropic", label: "Anthropic" },
  { id: "openai", label: "OpenAI" },
  { id: "google", label: "Google" },
  { id: "openrouter", label: "OpenRouter" },
] as const

export type ModelProviderId = (typeof MODEL_PROVIDERS)[number]["id"]

export const MODEL_PROVIDER_IDS = MODEL_PROVIDERS.map((p) => p.id) as [ModelProviderId, ...ModelProviderId[]]
