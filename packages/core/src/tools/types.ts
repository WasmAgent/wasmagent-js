import type { ZodSchema } from "zod";

/**
 * Typed tool interface (D2) — replaces smolagents' runtime-only tool_validation.py.
 *
 * Every tool MUST declare:
 *  - readOnly: safe for speculative execution (C3 barrier)
 *  - idempotent: may be called multiple times with same result
 *
 * These are enforced at tool registration time, not just runtime.
 */
export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  /** Zod schema — compile-time + call-time validation (replaces _function_type_hints_utils.py). */
  inputSchema: ZodSchema<TInput>;
  outputSchema: ZodSchema<TOutput>;
  /** True = safe for speculative pre-execution (C3). */
  readOnly: boolean;
  /** True = calling multiple times with same args is safe (C3 + C4 caching). */
  idempotent: boolean;
  /**
   * Named capability required to call this tool (A2 extraCapabilities).
   * If set, the agent must grant this capability in its CapabilityManifest.extraCapabilities
   * for the call to proceed; otherwise ToolRegistry returns a capability_denied error.
   * Example: "tool:web_search", "tool:file_write"
   */
  requiredCapability?: string;
  /**
   * Raw JSON Schema for this tool's input, preferred over zodToJsonSchema(inputSchema)
   * when present. Used by McpToolCollection to pass through the MCP server's own schema
   * without round-tripping through Zod (which would discard properties/required).
   */
  rawInputJsonSchema?: object;
  /**
   * Whether to pause and wait for human approval before executing this tool.
   * Can be a static boolean or a dynamic predicate on the tool input.
   * When true/truthy, the agent emits an "await_human_input" event and suspends
   * until a response is provided via Checkpointer.respond().
   */
  needsApproval?: boolean | ((input: never) => boolean | Promise<boolean>);
  forward(input: TInput, signal?: AbortSignal): Promise<TOutput>;
}

/** Validated tool call descriptor emitted by the agent step parser. */
export interface ToolCall {
  toolName: string;
  args: Record<string, unknown>;
  callId: string;
  /** AbortSignal forwarded from the Scheduler — best-effort cancellation. */
  signal?: AbortSignal;
}

/** Result of a tool execution, including structured feedback for error loops (D2). */
export interface ToolResult {
  callId: string;
  toolName: string;
  output: unknown;
  error?: {
    code: "validation_error" | "capability_denied" | "execution_error";
    message: string;
    /** Structured partial to retry only the failing part (D2 error feedback loop). */
    retryHint?: string;
  };
}
