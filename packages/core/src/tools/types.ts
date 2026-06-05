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
  forward(input: TInput): Promise<TOutput>;
}

/** Validated tool call descriptor emitted by the agent step parser. */
export interface ToolCall {
  toolName: string;
  args: Record<string, unknown>;
  callId: string;
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
