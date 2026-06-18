/**
 * F1 — Public types for the MCP server. Kept in their own file so test code
 * and adapters can import them without pulling the implementation surface.
 */

import type { AgentEvent, SubagentRunnable } from "@wasmagent/core";

// ── JSON-RPC primitives ─────────────────────────────────────────────────────

export type McpJsonRpcId = string | number | null;

export interface McpJsonRpcRequest {
  jsonrpc: "2.0";
  id?: McpJsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpJsonRpcResponse {
  jsonrpc: "2.0";
  id: McpJsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ── Server-level shape ─────────────────────────────────────────────────────

export interface McpServerInfo {
  /** Stable name (shown in host UIs as the server's identity). */
  name: string;
  /** Server-defined version string. Bump on incompatible behavior changes. */
  version: string;
  /**
   * Optional one-line description shown to the host. Keep short — hosts may
   * truncate. Default is empty.
   */
  description?: string;
}

/**
 * One advertised tool. By default the server publishes a single
 * `run_agent` tool that wraps the underlying agent's `run(task)`; callers
 * may also publish narrower tools (one per skill / per subtask) by listing
 * them explicitly.
 */
export interface McpToolEntry {
  name: string;
  description: string;
  /**
   * JSON Schema describing the tool's inputs. The MCP spec mandates this
   * field; the server passes it through verbatim — no Zod conversion. When
   * the agent has a structured input schema, encode it here.
   */
  inputSchema: object;
  /**
   * Hint to the host: if true, the tool's `forward()` may take a long time
   * and the host SHOULD use the Tasks API instead of waiting on the
   * synchronous `tools/call` response.
   *
   * The 2025-11 spec field is `_meta.longRunning`; we surface it here as a
   * top-level boolean for ergonomics and place it correctly in the wire
   * payload during `tools/list`.
   */
  longRunning?: boolean;
  /**
   * Resolver: turn the host-supplied input object into a task string for
   * the agent. Defaults to `JSON.stringify(input)` for non-`run_agent`
   * names; for `run_agent` it expects `{ task: string }`.
   */
  resolveTask?: (input: Record<string, unknown>) => string;
}

// ── Tasks store ─────────────────────────────────────────────────────────────

export type McpTaskState = "pending" | "running" | "awaiting-input" | "complete" | "failed";

/**
 * Persistent task record. The store is responsible for serialisation; the
 * server only ever reads/writes whole records. Keep this shape stable —
 * backwards compat for older Workers reading newer records.
 */
export interface McpTaskRecord {
  id: string;
  toolName: string;
  /** Caller-supplied input to the tool. */
  input: Record<string, unknown>;
  state: McpTaskState;
  /**
   * Streamed events that have been observed so far. Bounded to a reasonable
   * tail; the implementation MAY truncate, but MUST keep the final event
   * (`final_answer` or `error`) when present.
   */
  events: AgentEvent[];
  /** Set on state="complete". */
  result?: unknown;
  /** Set on state="failed". */
  error?: string;
  /** Set on state="awaiting-input"; cleared once the host responds. */
  pendingElicitation?: { promptId: string; prompt: string };
  /**
   * Monotonically incremented every time the record is persisted. Used
   * defensively when KVs return slightly stale reads.
   */
  version: number;
}

export interface McpTaskStore {
  /** Read a task by id, or null if absent. */
  get(id: string): Promise<McpTaskRecord | null>;
  /** Persist a task record (overwriting any existing one by the same id). */
  put(record: McpTaskRecord): Promise<void>;
  /** Delete a task. No-ops on missing ids. */
  delete(id: string): Promise<void>;
  /** Optional: enumerate task ids — used by `tasks/list`. */
  list?(): Promise<string[]>;
}

// ── Server options ──────────────────────────────────────────────────────────

export interface McpAgentServerOptions {
  /** Identity advertised in the `initialize` response. */
  serverInfo: McpServerInfo;
  /**
   * The agent to expose. Must implement `SubagentRunnable.run(task)`. Both
   * `ToolCallingAgent` and `CodeAgent` from core satisfy this; so does any
   * caller-built generator.
   */
  agent: SubagentRunnable;
  /**
   * Tools to advertise. Defaults to a single `run_agent` entry that
   * forwards the input's `task` field to `agent.run()`.
   */
  tools?: McpToolEntry[];
  /**
   * Persistence for long tasks. Defaults to `InMemoryTaskStore` — fine for
   * a single-process node host, NOT enough for a CF Worker that may recycle
   * between poll requests. Pass a KV-backed adapter for those.
   */
  taskStore?: McpTaskStore;
  /**
   * Maximum number of streamed events kept on disk per task. The latest
   * `final_answer` / `error` is always preserved regardless. Default 200.
   */
  maxEventsPerTask?: number;
  /**
   * If true, every `tools/call` runs synchronously — short tasks finish
   * inside one HTTP round-trip. Long tasks (or tools marked `longRunning`)
   * are still routed to `tasks/create`. Default true.
   */
  allowSyncCalls?: boolean;
  /**
   * Hard wall-clock cap for synchronous calls in milliseconds. After the
   * cap, the in-flight run is converted to a task automatically and the
   * response carries `_meta.taskId` for the host to poll. Default 25000ms.
   */
  syncTimeoutMs?: number;
}

// ── handle() return shape ───────────────────────────────────────────────────

export interface McpHandleResult {
  /** The wire response to send back to the caller. */
  response: McpJsonRpcResponse;
  /**
   * Optional task id — set when a synchronous call escalated to a task or
   * when the request created one. Hosts can echo this back via `_meta`.
   */
  taskId?: string;
}
