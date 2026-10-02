/**
 * The models an agent can be given, from the same models.dev catalog the
 * engine prices runs with. Offering only models listed there with prices is
 * what keeps spend honest: a typed name the catalog does not know still runs,
 * but every run of it reports $0.
 */
import { z } from "zod"
import { HttpError, json } from "./http"
import { MODEL_PROVIDER_IDS } from "./model-providers"

const CACHE_TTL_MS = 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000
const DEFAULT_SOURCE = "https://models.dev"

export interface ModelOption {
  id: string
  name: string
  cost_input: number
  cost_output: number
  context_limit: number | null
}

interface CatalogModel {
  id: string
  name: string
  tool_call?: boolean
  modalities?: { output?: string[] }
  cost?: { input?: number; output?: number }
  limit?: { context?: number }
  release_date?: string
}

type Catalog = Record<string, { models?: Record<string, CatalogModel> }>

const ModelsQuery = z.object({ provider: z.enum(MODEL_PROVIDER_IDS) })

export class ModelCatalog {
  private cached: { data: Catalog; fetchedAt: number } | null = null
  private inflight: Promise<Catalog> | null = null
  private readonly url: string

  /** `source` follows the engine's AGENTS_EVERYWHERE_MODELS_URL, so an offline mirror serves both. */
  constructor(
    source: string | undefined,
    private readonly log: (line: string) => void,
  ) {
    this.url = `${(source || DEFAULT_SOURCE).replace(/\/$/, "")}/api.json`
  }

  private async fetchCatalog(): Promise<Catalog> {
    const res = await fetch(this.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as Catalog
    this.cached = { data, fetchedAt: Date.now() }
    return data
  }

  private async catalog(): Promise<Catalog> {
    if (this.cached && Date.now() - this.cached.fetchedAt < CACHE_TTL_MS) return this.cached.data
    this.inflight ??= this.fetchCatalog().finally(() => (this.inflight = null))
    try {
      return await this.inflight
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      if (this.cached) {
        this.log(`Couldn't refresh the model list from ${this.url} (${reason}); serving the copy from earlier.`)
        return this.cached.data
      }
      throw new HttpError(502, `Couldn't load the model list from ${this.url}: ${reason}. Type the model id instead.`)
    }
  }

  /**
   * Models that can drive an agent: they call tools (every file edit and
   * command goes through one), they answer in text, and they are priced.
   * Newest first.
   */
  async models(provider: string): Promise<ModelOption[]> {
    const models = (await this.catalog())[provider]?.models ?? {}
    return Object.values(models)
      .filter(
        (m) =>
          m.tool_call === true &&
          m.modalities?.output?.includes("text") === true &&
          typeof m.cost?.input === "number" &&
          typeof m.cost?.output === "number",
      )
      .sort((a, b) => (b.release_date ?? "").localeCompare(a.release_date ?? ""))
      .map((m) => ({
        id: m.id,
        name: m.name,
        cost_input: m.cost!.input!,
        cost_output: m.cost!.output!,
        context_limit: m.limit?.context ?? null,
      }))
  }

  list = async (req: Request): Promise<Response> => {
    const query = ModelsQuery.safeParse(Object.fromEntries(new URL(req.url).searchParams))
    if (!query.success) throw new HttpError(400, `provider must be one of ${MODEL_PROVIDER_IDS.join(", ")}`)
    return json({ models: await this.models(query.data.provider) })
  }
}
