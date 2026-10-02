import { Config, ConfigProvider, Context, Effect, Layer, Option } from "effect"
import { ConfigService } from "@/effect/config-service"

const bool = (name: string) => Config.boolean(name).pipe(Config.withDefault(false))
const positiveInteger = (name: string) =>
  Config.number(name).pipe(
    Config.map((value) => (Number.isInteger(value) && value > 0 ? value : undefined)),
    Config.orElse(() => Config.succeed(undefined)),
  )
const experimental = bool("AGENTS_EVERYWHERE_EXPERIMENTAL")
const enabledByExperimental = (name: string) =>
  Config.all({ experimental, enabled: Config.boolean(name).pipe(Config.option) }).pipe(
    Config.map((flags) => Option.getOrElse(flags.enabled, () => flags.experimental)),
  )

export class Service extends ConfigService.Service<Service>()("@agents-everywhere/RuntimeFlags", {
  autoShare: bool("AGENTS_EVERYWHERE_AUTO_SHARE"),
  pure: bool("AGENTS_EVERYWHERE_PURE"),
  disableDefaultPlugins: bool("AGENTS_EVERYWHERE_DISABLE_DEFAULT_PLUGINS"),
  disableEmbeddedWebUi: bool("AGENTS_EVERYWHERE_DISABLE_EMBEDDED_WEB_UI"),
  disableExternalSkills: bool("AGENTS_EVERYWHERE_DISABLE_EXTERNAL_SKILLS"),
  disableLspDownload: bool("AGENTS_EVERYWHERE_DISABLE_LSP_DOWNLOAD"),
  disableClaudeCodePrompt: Config.all({
    broad: bool("AGENTS_EVERYWHERE_DISABLE_CLAUDE_CODE"),
    direct: bool("AGENTS_EVERYWHERE_DISABLE_CLAUDE_CODE_PROMPT"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  disableClaudeCodeSkills: Config.all({
    broad: bool("AGENTS_EVERYWHERE_DISABLE_CLAUDE_CODE"),
    direct: bool("AGENTS_EVERYWHERE_DISABLE_CLAUDE_CODE_SKILLS"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  enableExa: Config.all({
    experimental,
    enabled: bool("AGENTS_EVERYWHERE_ENABLE_EXA"),
    legacy: bool("AGENTS_EVERYWHERE_EXPERIMENTAL_EXA"),
  }).pipe(Config.map((flags) => flags.experimental || flags.enabled || flags.legacy)),
  enableParallel: Config.all({
    enabled: bool("AGENTS_EVERYWHERE_ENABLE_PARALLEL"),
    legacy: bool("AGENTS_EVERYWHERE_EXPERIMENTAL_PARALLEL"),
  }).pipe(Config.map((flags) => flags.enabled || flags.legacy)),
  enableExperimentalModels: bool("AGENTS_EVERYWHERE_ENABLE_EXPERIMENTAL_MODELS"),
  enableQuestionTool: bool("AGENTS_EVERYWHERE_ENABLE_QUESTION_TOOL"),
  experimentalReferences: enabledByExperimental("AGENTS_EVERYWHERE_EXPERIMENTAL_REFERENCES"),
  experimentalBackgroundSubagents: enabledByExperimental("AGENTS_EVERYWHERE_EXPERIMENTAL_BACKGROUND_SUBAGENTS"),
  experimentalLspTy: bool("AGENTS_EVERYWHERE_EXPERIMENTAL_LSP_TY"),
  experimentalLspTool: enabledByExperimental("AGENTS_EVERYWHERE_EXPERIMENTAL_LSP_TOOL"),
  experimentalOxfmt: enabledByExperimental("AGENTS_EVERYWHERE_EXPERIMENTAL_OXFMT"),
  experimentalPlanMode: enabledByExperimental("AGENTS_EVERYWHERE_EXPERIMENTAL_PLAN_MODE"),
  experimentalCodeMode: enabledByExperimental("AGENTS_EVERYWHERE_EXPERIMENTAL_CODE_MODE"),
  experimentalEventSystem: enabledByExperimental("AGENTS_EVERYWHERE_EXPERIMENTAL_EVENT_SYSTEM"),
  experimentalWorkspaces: enabledByExperimental("AGENTS_EVERYWHERE_EXPERIMENTAL_WORKSPACES"),
  experimentalIconDiscovery: enabledByExperimental("AGENTS_EVERYWHERE_EXPERIMENTAL_ICON_DISCOVERY"),
  outputTokenMax: positiveInteger("AGENTS_EVERYWHERE_EXPERIMENTAL_OUTPUT_TOKEN_MAX"),
  bashDefaultTimeoutMs: positiveInteger("AGENTS_EVERYWHERE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"),
  experimentalNativeLlm: bool("AGENTS_EVERYWHERE_EXPERIMENTAL_NATIVE_LLM"),
  experimentalWebSockets: bool("AGENTS_EVERYWHERE_EXPERIMENTAL_WEBSOCKETS"),
  client: Config.string("AGENTS_EVERYWHERE_CLIENT").pipe(Config.withDefault("cli")),
}) {}

export type Info = Context.Service.Shape<typeof Service>

const emptyConfigLayer = Service.layer.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
  Layer.orDie,
)

export const layer = (overrides: Partial<Info> = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const flags = yield* Service
      return Service.of({ ...flags, ...overrides })
    }),
  ).pipe(Layer.provide(emptyConfigLayer))

export const node = LayerNode.make({ service: Service, layer: Service.layer.pipe(Layer.orDie), deps: [] })

export * as RuntimeFlags from "./runtime-flags"
import { LayerNode } from "@agents-everywhere/core/effect/layer-node"
