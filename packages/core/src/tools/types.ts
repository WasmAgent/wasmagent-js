import type { ZodSchema } from "zod";

/**
 * Typed tool interface — replaces smolagents' runtime-only tool_validation.py.
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
  /** Zod schema — compile-time + call-time validation. */
  inputSchema: ZodSchema<TInput>;
  outputSchema: ZodSchema<TOutput>;
  /** True = safe for speculative pre-execution. */
  readOnly: boolean;
  /** True = calling multiple times with same args is safe. */
  idempotent: boolean;
  /**
   * Named capability required to call this tool.
   * If set, the agent must grant this capability in its CapabilityManifest.extraCapabilities.
   */
  requiredCapability?: string;
  /**
   * Raw JSON Schema for this tool's input, preferred over zodToJsonSchema(inputSchema)
   * when present. Used by McpToolCollection to pass through the MCP server's own schema.
   */
  rawInputJsonSchema?: object;
  /**
   * Whether to pause and wait for human approval before executing this tool.
   */
  needsApproval?: boolean | ((input: never) => boolean | Promise<boolean>);
  /**
   * L1-1: Deferred loading — when true, this tool's schema is excluded from the
   * system prompt prefix and loaded on-demand via the Tool Search mechanism.
   * Reduces context token usage for large MCP server collections (55K→8.7K tokens).
   * Requires AnthropicModel with advanced-tool-use-2025-11-20 beta header.
   */
  deferLoading?: boolean;
  /**
   * L1-2: Few-shot input examples for this tool.
   * Providing 1–5 examples improves parameter accuracy from ~72% to ~90%.
   * Maps to Anthropic API's input_examples field (advanced-tool-use-2025-11-20).
   */
  inputExamples?: Partial<TInput>[];
  /**
   * L1-3: Allowed callers for Programmatic Tool Calling (PTC).
   * Maps to Anthropic API's allowed_callers field — lets model-generated code
   * call this tool directly inside the sandbox, keeping intermediate results
   * out of the context window.
   */
  allowedCallers?: string[];
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

/** Result of a tool execution, including structured feedback for error loops. */
export interface ToolResult {
  callId: string;
  toolName: string;
  output: unknown;
  error?: {
    code: "validation_error" | "capability_denied" | "execution_error";
    message: string;
    /** Structured partial to retry only the failing part. */
    retryHint?: string;
  };
}
