/**
 * The admin API the web UI (or a script holding the admin token) uses to
 * create agents, mint install commands, read transcripts, talk to a running
 * agent, decide its permission requests and stop it.
 */
import { z } from "zod"
import {
  DECISIONS,
  LIVE_RUN_STATUSES,
  OS_SHELLS,
  PERMISSION_ACCESS,
  PERMISSION_EFFECTS,
  PERMISSION_KINDS,
  PERMISSION_MODES,
  SECRET_PROVIDERS,
  TERMINAL_RUN_STATUSES,
  type Decision,
} from "@agents-everywhere/harness/protocol"
import { createBootstrapToken, seal, type Keys } from "./crypto"
import { HttpError, json, parseJson, readBody } from "./http"
import { MODEL_PROVIDER_IDS } from "./model-providers"
import {
  dedupeRules,
  defaultDenyRules,
  permanentRulesFor,
  PolicyError,
  toRule,
  validatePermissions,
  type Rule,
} from "./policy"
import type { AgentRow, RunRow, SecretInput, Store } from "./store"

const MAX_ADMIN_BODY_BYTES = 1024 * 1024
const RUNS_SHOWN = 50
const EVENTS_PAGE = 1000

const ENV_VAR_NAME = /^[A-Z_][A-Z0-9_]*$/
const AWS_SECRET_ARN = /^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:.+$/

const Permission = z.object({
  path_pattern: z.string().trim().min(1).max(1000),
  access: z.enum(PERMISSION_ACCESS),
  kind: z.enum(PERMISSION_KINDS).default("filesystem"),
  effect: z.enum(PERMISSION_EFFECTS).default("allow"),
})

const Secret = z
  .object({
    provider: z.enum(SECRET_PROVIDERS).default("aws"),
    // A reference, never a value: an ARN, a GCP resource name, a Vault path, or an env var name.
    reference: z.string().trim().min(1).max(2048),
    key_to_env_var: z
      .record(z.string().min(1).max(200), z.string().regex(ENV_VAR_NAME, "must be an environment variable name"))
      .refine((m) => Object.keys(m).length > 0, "map at least one key to an environment variable"),
    provider_config: z.record(z.string(), z.unknown()).default({}),
  })
  .superRefine((s, ctx) => {
    if (s.provider === "aws" && !AWS_SECRET_ARN.test(s.reference)) {
      ctx.addIssue({ code: "custom", path: ["reference"], message: "doesn't look like an AWS Secrets Manager ARN" })
    }
    if (s.provider === "env" && !ENV_VAR_NAME.test(s.reference)) {
      ctx.addIssue({ code: "custom", path: ["reference"], message: "isn't a valid environment variable name" })
    }
  })

const AgentFields = {
  label: z.string().trim().min(1).max(255),
  location_label: z.string().trim().max(120).nullable().optional(),
  task: z.string().trim().min(1).max(20_000),
  model_provider: z.enum(MODEL_PROVIDER_IDS),
  model_name: z.string().trim().min(1).max(200),
  llm_api_key: z.string().min(1).max(4096).optional(),
  interactive: z.boolean().optional(),
  permission_mode: z.enum(PERMISSION_MODES).optional(),
  permission_request_timeout_seconds: z.number().int().min(30).max(86_400).optional(),
  declared_env_vars: z
    .array(z.string().regex(ENV_VAR_NAME, "must be an environment variable name"))
    .max(100)
    .optional(),
  secrets: z.array(Secret).max(50).optional(),
}

const CreateAgent = z.object({
  ...AgentFields,
  os_shell: z.enum(OS_SHELLS).default("linux_bash"),
  permissions: z.array(Permission).default([]),
  acknowledge_bash_gateways: z.boolean().default(false),
  // The standard deny rules, seeded as real, editable rows.
  seed_default_denies: z.boolean().default(true),
})

const UpdateAgent = z.object({
  label: AgentFields.label.optional(),
  location_label: AgentFields.location_label,
  task: AgentFields.task.optional(),
  model_provider: AgentFields.model_provider.optional(),
  model_name: AgentFields.model_name.optional(),
  llm_api_key: AgentFields.llm_api_key,
  clear_llm_api_key: z.boolean().optional(),
  interactive: AgentFields.interactive,
  permission_mode: AgentFields.permission_mode,
  permission_request_timeout_seconds: AgentFields.permission_request_timeout_seconds,
  declared_env_vars: AgentFields.declared_env_vars,
  secrets: AgentFields.secrets,
})

const ReplacePermissions = z.object({
  permissions: z.array(Permission),
  acknowledge_bash_gateways: z.boolean().default(false),
})

const MessageBody = z.object({ message: z.string().trim().min(1).max(8000) })
const DecisionBody = z.object({ decision: z.enum(DECISIONS) })
const LoginBody = z.object({ token: z.string().min(1).max(200) })

function policy<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    if (err instanceof PolicyError) throw new HttpError(400, err.message)
    throw err
  }
}

function toSecretInputs(secrets: z.infer<typeof Secret>[] | undefined): SecretInput[] {
  return (secrets ?? []).map((s) => ({
    provider: s.provider,
    reference: s.reference,
    key_to_env_var: s.key_to_env_var,
    provider_config: s.provider_config,
  }))
}

function runOut(run: RunRow) {
  return {
    id: run.id,
    status: run.status,
    hostname: run.hostname,
    run_env: parseJson(run.run_env, {}),
    kill_requested: run.kill_requested_at !== null,
    started_at: run.started_at,
    ended_at: run.ended_at,
    last_heartbeat_at: run.last_heartbeat_at,
    created_at: run.created_at,
  }
}

function agentOut(agent: AgentRow) {
  return {
    id: agent.id,
    label: agent.label,
    os_shell: agent.os_shell,
    location_label: agent.location_label,
    status: agent.status,
    task: agent.task,
    model_provider: agent.model_provider,
    model_name: agent.model_name,
    // Never the key itself: it is sealed at rest and leaves only in a handshake.
    has_llm_api_key: agent.llm_api_key_sealed !== null,
    interactive: agent.interactive === 1,
    permission_mode: agent.permission_mode,
    permission_request_timeout_seconds: agent.permission_request_timeout_seconds,
    declared_env_vars: parseJson<string[]>(agent.declared_env_vars, []),
    created_at: agent.created_at,
    updated_at: agent.updated_at,
  }
}

export class AdminApi {
  constructor(
    private readonly store: Store,
    private readonly keys: Keys,
    private readonly publicUrl: string,
    private readonly log: (line: string) => void,
  ) {}

  private agentOr404(id: string): AgentRow {
    const agent = this.store.getAgent(id)
    if (!agent) throw new HttpError(404, "Agent not found")
    return agent
  }

  /** The run must belong to the agent in the path; a run id alone reaches nothing. */
  private runOr404(agentId: string, runId: string): RunRow {
    const run = this.store.getRun(runId)
    if (!run || run.agent_id !== agentId) throw new HttpError(404, "Run not found on this agent")
    return run
  }

  private detail(agent: AgentRow) {
    const usage = this.store.agentUsage(agent.id)
    return {
      ...agentOut(agent),
      permissions: this.store.rules(agent.id),
      secrets: this.store.secrets(agent.id).map((s) => ({
        id: s.id,
        provider: s.provider,
        reference: s.reference,
        key_to_env_var: parseJson(s.key_to_env_var, {}),
        provider_config: parseJson(s.provider_config, {}),
      })),
      runs: this.store.runs(agent.id, RUNS_SHOWN).map(runOut),
      pending_permission_requests: this.store.requests(agent.id, true, 500).length,
      total_cost_usd: usage.cost ?? 0,
      total_tokens_in: usage.tokens_in ?? 0,
      total_tokens_out: usage.tokens_out ?? 0,
    }
  }

  loginBody = (req: Request) => readBody(req, LoginBody, 4096)

  listAgents = async (): Promise<Response> =>
    json(
      this.store.listAgents().map((a) => ({
        ...agentOut(a),
        latest_run_id: a.latest_run_id,
        latest_run_status: a.latest_run_status,
        latest_run_last_heartbeat_at: a.latest_run_last_heartbeat_at,
        total_cost_usd: a.total_cost_usd ?? 0,
        total_tokens_in: a.total_tokens_in ?? 0,
        total_tokens_out: a.total_tokens_out ?? 0,
        pending_permission_requests: a.pending_requests,
      })),
    )

  createAgent = async (req: Request): Promise<Response> => {
    const body = await readBody(req, CreateAgent, MAX_ADMIN_BODY_BYTES)
    // Seeded first so an explicit row for the same pattern wins the dedupe.
    const requested: Rule[] = [...(body.seed_default_denies ? defaultDenyRules() : []), ...body.permissions.map(toRule)]
    policy(() => validatePermissions(requested, body.acknowledge_bash_gateways))
    const id = this.store.createAgent(
      {
        label: body.label,
        os_shell: body.os_shell,
        location_label: body.location_label ?? null,
        task: body.task,
        model_provider: body.model_provider,
        model_name: body.model_name,
        llm_api_key_sealed: body.llm_api_key ? seal(this.keys, body.llm_api_key) : null,
        interactive: body.interactive ?? false,
        permission_mode: body.permission_mode ?? "strict",
        permission_request_timeout_seconds: body.permission_request_timeout_seconds ?? 900,
        declared_env_vars: body.declared_env_vars ?? [],
      },
      dedupeRules(requested),
      toSecretInputs(body.secrets),
    )
    this.log(`Agent created: ${body.label}`)
    return json(this.detail(this.store.getAgent(id)!), 201)
  }

  getAgent = async (_req: Request, id: string): Promise<Response> => json(this.detail(this.agentOr404(id)))

  updateAgent = async (req: Request, id: string): Promise<Response> => {
    const agent = this.agentOr404(id)
    if (agent.status === "revoked") throw new HttpError(409, "Cannot edit a revoked agent")
    const body = await readBody(req, UpdateAgent, MAX_ADMIN_BODY_BYTES)
    if (body.llm_api_key && body.clear_llm_api_key) throw new HttpError(422, "Set a new key or clear it, not both")
    this.store.transaction(() => {
      this.store.updateAgent(id, {
        label: body.label,
        location_label: body.location_label,
        task: body.task,
        model_provider: body.model_provider,
        model_name: body.model_name,
        llm_api_key_sealed: body.llm_api_key ? seal(this.keys, body.llm_api_key) : undefined,
        clear_llm_api_key: body.clear_llm_api_key,
        interactive: body.interactive,
        permission_mode: body.permission_mode,
        permission_request_timeout_seconds: body.permission_request_timeout_seconds,
        declared_env_vars: body.declared_env_vars,
      })
      if (body.secrets) this.store.replaceSecrets(id, toSecretInputs(body.secrets))
    })
    return json(this.detail(this.store.getAgent(id)!))
  }

  /** Takes effect on the next run: a live runner holds the rules it was handed. */
  replacePermissions = async (req: Request, id: string): Promise<Response> => {
    const agent = this.agentOr404(id)
    if (agent.status === "revoked") throw new HttpError(409, "Cannot edit the permissions of a revoked agent")
    const body = await readBody(req, ReplacePermissions, MAX_ADMIN_BODY_BYTES)
    const rules = body.permissions.map(toRule)
    policy(() => validatePermissions(rules, body.acknowledge_bash_gateways))
    this.store.replaceRules(id, dedupeRules(rules))
    return json(this.detail(this.store.getAgent(id)!))
  }

  /**
   * Mints a fresh single-use install command: a pending run and a bootstrap
   * token for it that expires in five minutes and is spent on first use.
   */
  installCommand = async (_req: Request, id: string): Promise<Response> => {
    const agent = this.agentOr404(id)
    if (agent.status === "revoked") throw new HttpError(409, "Cannot install a revoked agent")
    const runId = this.store.transaction(() => {
      const created = this.store.createPendingRun(id)
      this.store.activateAgent(id)
      return created
    })
    const { token, expiresAt } = createBootstrapToken(this.keys, id, runId)
    return json({
      run_id: runId,
      command: installCommand(this.publicUrl, token, agent.interactive === 1),
      expires_at: expiresAt.toISOString(),
    })
  }

  revoke = async (_req: Request, id: string): Promise<Response> => {
    this.agentOr404(id)
    const runsSignaled = this.store.revokeAgent(id)
    this.log(`Agent ${id} revoked; ${runsSignaled} run(s) told to stop`)
    return json({ status: "revoked", runs_signaled: runsSignaled })
  }

  runEvents = async (req: Request, id: string, runId: string): Promise<Response> => {
    this.agentOr404(id)
    this.runOr404(id, runId)
    const after = Number(new URL(req.url).searchParams.get("after") || "0")
    const events = this.store.events(runId, Number.isFinite(after) && after > 0 ? after : 0, EVENTS_PAGE)
    return json(
      events.map((e) => ({
        id: e.id,
        seq: e.seq,
        event_type: e.event_type,
        // Written by the agent's model and the machine it ran on: data to show, never markup to render.
        payload: parseJson(e.payload, {}),
        tokens_in: e.tokens_in,
        tokens_out: e.tokens_out,
        cost_usd: e.cost_usd,
        created_at: e.created_at,
      })),
    )
  }

  /** Delivered on the run's next heartbeat, into the same session, as a follow-up turn. */
  sendMessage = async (req: Request, id: string, runId: string): Promise<Response> => {
    this.agentOr404(id)
    const run = this.runOr404(id, runId)
    if (!LIVE_RUN_STATUSES.includes(run.status))
      throw new HttpError(409, `The run is ${run.status}, so nothing would receive the message`)
    const body = await readBody(req, MessageBody, 64 * 1024)
    const event = this.store.addEvent(runId, "user_message", { message: body.message })
    return json({ id: event.id, created_at: event.created_at }, 201)
  }

  killRun = async (_req: Request, id: string, runId: string): Promise<Response> => {
    this.agentOr404(id)
    const run = this.runOr404(id, runId)
    if (TERMINAL_RUN_STATUSES.includes(run.status)) throw new HttpError(409, `The run is already ${run.status}`)
    return json({ result: this.store.requestKill(runId) })
  }

  permissionRequests = async (req: Request, id: string): Promise<Response> => {
    this.agentOr404(id)
    const pendingOnly = new URL(req.url).searchParams.get("pending") === "1"
    return json(
      this.store.requests(id, pendingOnly, 200).map((r) => ({
        id: r.id,
        run_id: r.run_id,
        run_hostname: r.run_hostname,
        permission: r.permission,
        patterns: parseJson(r.patterns, []),
        // Model-influenced text from the agent's own tool call: data, never markup.
        metadata: parseJson(r.metadata, {}),
        status: r.status,
        created_at: r.created_at,
        expires_at: r.expires_at,
        decided_at: r.decided_at,
      })),
    )
  }

  /**
   * The agent's tool call is blocked inside the engine while this is pending,
   * so the decision reaches it on the next heartbeat. A permanent approval
   * also writes the rule into the agent, so the next run starts with it.
   */
  decide = async (req: Request, id: string, requestId: string): Promise<Response> => {
    const agent = this.agentOr404(id)
    const body = await readBody(req, DecisionBody, 4096)
    const decision = body.decision as Decision
    const row = this.store.getRequest(requestId)
    if (!row || row.agent_id !== agent.id) throw new HttpError(404, "Permission request not found on this agent")
    if (row.status !== "pending") throw new HttpError(409, `This request was already ${row.status}`)

    const permanent =
      decision === "approved_permanent"
        ? policy(() => permanentRulesFor(row.permission, parseJson(row.patterns, []), this.store.rules(agent.id)))
        : []

    // Claimed atomically: two people clicking at once must not produce two
    // decisions for one blocked call.
    const decided = this.store.transaction(() => {
      if (!this.store.decideRequest(requestId, agent.id, decision)) return false
      if (permanent.length) this.store.addRules(agent.id, permanent)
      this.store.addEvent(row.run_id, "permission_request", {
        request_id: row.id,
        decision,
        permission: row.permission,
        patterns: parseJson(row.patterns, []),
      })
      return true
    })
    if (!decided) throw new HttpError(409, `This request was already ${this.store.getRequest(requestId)!.status}`)
    return json({ id: requestId, status: decision })
  }
}

/**
 * The command a person pastes, shaped for how it will run. Interactive mode
 * cannot be piped: `curl ... | bash` hands bash's stdin to the pipe, leaving no
 * terminal for the TUI to read keystrokes from, so it downloads first, to a
 * fresh mktemp file: a fixed name in /tmp could be planted by another local user
 * and swapped between the download and the run.
 */
export function installCommand(publicUrl: string, token: string, interactive: boolean): string {
  const script = `${publicUrl}/agent/install.sh`
  if (interactive) {
    return `f="$(mktemp)" && curl -fsSL ${script} -o "$f" && bash "$f" --token=${token} --api-url=${publicUrl} ; rm -f "$f"`
  }
  return `curl -fsSL ${script} | bash -s -- --token=${token} --api-url=${publicUrl}`
}
