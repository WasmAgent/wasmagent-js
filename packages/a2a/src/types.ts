/**
 * A2A (Agent2Agent) protocol types — v1.0 (Linux Foundation AAIF, 2026-04).
 *
 * Based on the A2A open specification: https://agent2agent.dev
 */

// ── Agent Card ────────────────────────────────────────────────────────────────

/** A2A Agent Card — describes a published agent's capabilities and endpoints. */
export interface A2AAgentCard {
  /** Unique agent identifier (typically a URL or URN). */
  id: string;
  /** Human-readable agent name. */
  name: string;
  /** Short description of what this agent can do. */
  description: string;
  /** A2A protocol version this agent implements. */
  protocolVersion: "1.0";
  /** Capabilities reported by this agent. */
  capabilities: A2ACapabilities;
  /** Endpoint for sending tasks to this agent. */
  taskEndpoint: string;
  /** Optional: Authentication scheme required to call this agent. */
  authentication?: A2AAuthentication;
}

export interface A2ACapabilities {
  /** Named capability strings (e.g. "tool:web_search", "language:python"). */
  skills: string[];
  /** Whether the agent supports streaming responses. */
  streaming: boolean;
  /** Whether the agent supports stateful multi-turn sessions. */
  stateful: boolean;
}

export interface A2AAuthentication {
  scheme: "bearer" | "apiKey" | "none";
  headerName?: string;
}

// ── Task protocol ─────────────────────────────────────────────────────────────

export interface A2ATaskRequest {
  /** Unique task ID (caller-generated). */
  id: string;
  /** Parent task ID for tracing multi-hop chains. */
  parentId?: string;
  /** Task text / instruction. */
  message: string;
  /** Arbitrary caller-provided context. */
  context?: Record<string, unknown>;
}

export interface A2ATaskResponse {
  taskId: string;
  status: "completed" | "failed" | "running";
  /** Final answer / output. Present when status="completed". */
  result?: unknown;
  /** Error message. Present when status="failed". */
  error?: string;
  /** Streaming delta (for streaming responses). */
  delta?: string;
}

// ── A2A Server ────────────────────────────────────────────────────────────────

export interface A2AServerOptions {
  /** Agent ID / URL for the Agent Card. */
  agentId: string;
  /** Human-readable name. */
  name: string;
  /** Short description. */
  description: string;
  /** Port to listen on. Default: 3000. */
  port?: number;
  /** Named capabilities to advertise in the Agent Card. */
  skills?: string[];
}

/** HTTP server that exposes a SubagentRunnable as an A2A-compliant agent. */
export interface A2AServer {
  /** Retrieve the generated Agent Card. */
  agentCard(): A2AAgentCard;
  /** Start listening. Returns the base URL. */
  start(): Promise<string>;
  /** Stop the server. */
  stop(): Promise<void>;
}
