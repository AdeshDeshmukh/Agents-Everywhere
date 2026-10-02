import type { AgentSpec, ControlPlaneAdapter } from "./suite"

/** Drives this repository's control plane through its admin API with the admin token. */
export class OpenSourceAdapter implements ControlPlaneAdapter {
  readonly name = "agents-everywhere control"

  constructor(
    readonly baseUrl: string,
    private readonly adminToken: string,
  ) {}

  private async call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.adminToken}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, data: (await res.json().catch(() => ({}))) as any }
  }

  async createAgent(spec: AgentSpec) {
    const res = await this.call("POST", "/api/agents", {
      label: `conformance ${spec.mode}`,
      task: "Conformance check: this agent is never run.",
      model_provider: "anthropic",
      model_name: "claude-haiku-4-5",
      permission_mode: spec.mode,
      permission_request_timeout_seconds: spec.timeoutSeconds ?? 900,
      permissions: spec.rules ?? [],
      acknowledge_bash_gateways: spec.acknowledgeGateways ?? false,
    })
    return { status: res.status, agentId: res.status === 201 ? (res.data.id as string) : undefined }
  }

  async mintInstallToken(agentId: string) {
    const res = await this.call("POST", `/api/agents/${agentId}/install-command`, {})
    if (res.status !== 200) throw new Error(`minting an install command answered ${res.status}`)
    const token = String(res.data.command).match(/--token=(\S+)/)?.[1]
    if (!token) throw new Error("the install command carries no token")
    return token
  }

  async sendMessage(agentId: string, runId: string, message: string) {
    const res = await this.call("POST", `/api/agents/${agentId}/runs/${runId}/messages`, { message })
    if (res.status !== 201) throw new Error(`sending a message answered ${res.status}`)
  }

  async pendingRequests(agentId: string) {
    const res = await this.call("GET", `/api/agents/${agentId}/permission-requests?pending=1`)
    return (res.data as Array<{ id: string }>).map((r) => r.id)
  }

  async decide(agentId: string, requestId: string, decision: string) {
    return (await this.call("POST", `/api/agents/${agentId}/permission-requests/${requestId}/decision`, { decision }))
      .status
  }

  async stopRun(agentId: string, runId: string) {
    const res = await this.call("POST", `/api/agents/${agentId}/runs/${runId}/kill`, {})
    if (res.status !== 200) throw new Error(`stopping the run answered ${res.status}`)
  }
}
