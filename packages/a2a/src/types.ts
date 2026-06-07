/**
 * A2A (Agent2Agent) protocol types.
 *
 * Based on the A2A open specification: https://agent2agent.dev
 * Current supported version: "1.0" (Linux Foundation AAIF, 2026-04).
 * Use A2A_PROTOCOL_VERSION constant for the current default; pass a custom
 * version via A2AServerOptions.protocolVersion when the spec evolves.
 */

/** Current default A2A protocol version. Update here when the spec increments. */
export const A2A_PROTOCOL_VERSION = "1.0" as const;

// ── Agent Card ────────────────────────────────────────────────────────────────

export interface A2AAgentCard {
  id: string;
  name: string;
  description: string;
  /** A2A protocol version — configurable, defaults to A2A_PROTOCOL_VERSION. */
  protocolVersion: string;
  capabilities: A2ACapabilities;
  taskEndpoint: string;
  authentication?: A2AAuthentication;
}

export interface A2ACapabilities {
  skills: string[];
  streaming: boolean;
  stateful: boolean;
}

export interface A2AAuthentication {
  scheme: "bearer" | "apiKey" | "none";
  headerName?: string;
}

// ── Task protocol ─────────────────────────────────────────────────────────────

export interface A2ATaskRequest {
  id: string;
  parentId?: string;
  message: string;
  context?: Record<string, unknown>;
}

export interface A2ATaskResponse {
  taskId: string;
  status: "completed" | "failed" | "running";
  result?: unknown;
  error?: string;
  delta?: string;
}

// ── A2A Server ────────────────────────────────────────────────────────────────

export interface A2AServerOptions {
  agentId: string;
  name: string;
  description: string;
  port?: number;
  skills?: string[];
  /**
   * A2A protocol version to advertise in the Agent Card.
   * Defaults to A2A_PROTOCOL_VERSION ("1.0").
   * Override when targeting a specific spec revision.
   */
  protocolVersion?: string;
}

export interface A2AServer {
  agentCard(): A2AAgentCard;
  start(): Promise<string>;
  stop(): Promise<void>;
}
