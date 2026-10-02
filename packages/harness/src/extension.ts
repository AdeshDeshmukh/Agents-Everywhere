import type { SessionHandle } from "./engine"
import type { HandshakeResponse, HeartbeatResponse } from "./protocol"

/**
 * Behaviour a distribution adds on top of the protocol, for fields a server
 * sends beyond the core ones. An extension sees the same handshake and
 * heartbeat replies the runner does and can add context to the conversation;
 * it cannot change permissions, the task or the run's lifecycle.
 */
export interface RunnerExtension {
  readonly name: string
  /** Capabilities announced to the control plane at handshake. */
  readonly capabilities?: readonly string[]
  /** Context to append to the first prompt, or null for none. */
  initialContext?(handshake: HandshakeResponse, log: (line: string) => void): string | null
  /** Called after every accepted heartbeat, once a session exists. */
  onHeartbeat?(heartbeat: HeartbeatResponse, session: SessionHandle): Promise<void>
}
