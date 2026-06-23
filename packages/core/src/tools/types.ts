import type { ZodSchema } from "zod";

/**
 * B2: Agent identity and granted write scopes for least-agency enforcement.
 *
 * Pass a principal to ToolRegistry.call or agent.run() to restrict which
 * write-scoped tools the agent can execute without human approval.
 */
export interface AgentPrincipal {
  /** Stable identifier for this agent/session. Used in OTel span metadata. */
  id: string;
  /**
   * Scopes explicitly granted to this principal for write operations.
   * A !readOnly tool whose writeScope is not satisfied will be denied
   * (returns capability_denied) unless RunPolicy.allowWrites=true overrides it.
   */
  grantedScopes: string[];
}

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
  /**
   * Brevity-optimized description for token-constrained contexts.
   * When set, `toJsonSchema()` emits this instead of `description` when
   * the registry is in compact mode (ToolRegistry.toJsonSchema({ compact: true })).
   * Useful when the same tool serves both a detailed system-prompt view and
   * a deferred/search-result view where every token counts.
   *
   * Inspired by elizaOS Action.descriptionCompressed.
   */
  descriptionCompressed?: string;
  /** Zod schema — compile-time + call-time validation. */
  inputSchema: ZodSchema<TInput>;
  outputSchema: ZodSchema<TOutput>;
  /** True = safe for speculative pre-execution. */
  readOnly: boolean;
  /** True = calling multiple times with same args is safe. */
  idempotent: boolean;
  /**
   * 2026-06-18 (axis 9, L1 — adaptive execution).
   *
   * Names of registered tools the framework should suggest as
   * alternatives when this tool's `forward()` throws or returns a
   * `tool_result.error`. The framework does NOT auto-call them — it
   * surfaces them to the model in the next turn as "the tool you
   * tried failed; here are tools the registry says are alternatives.
   * You may pick one, retry the failed tool with different args, or
   * use `execute_code` to synthesise a one-off tool."
   *
   * Why model picks instead of framework: tool semantics differ
   * (an `append_file` is not a drop-in for `write_file`); silently
   * substituting would be a sharper footgun than not surfacing the
   * candidates at all.
   *
   * Resolution rules:
   * - Names that don't resolve in the same `ToolRegistry` are
   *   silently dropped (fail-closed; no exception).
   * - The framework caps the candidate set at 3 per failure even if
   *   more are listed (token budget hygiene).
   *
   * See `docs/strategy/2026-06-18-adaptive-execution.md` and
   * `docs/rfcs/adaptive-execution.md`.
   */
  alternatives?: string[];
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
   * C1: Raw JSON Schema for this tool's output (MCP 2025-06-18 structuredContent).
   * When present, the tool's result may be returned as typed structured data.
   */
  rawOutputJsonSchema?: object;
  /**
   * D2: Custom tool grammar for OpenAI GPT-5+ models.
   * Constrains the tool's arguments to a specific syntax (Lark grammar or regex).
   * Ignored by adapters that do not support custom tool grammars.
   */
  customToolGrammar?: {
    syntax: "lark" | "regex";
    definition: string;
  };
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
   *
   * ⚠️  Mutually exclusive with deferLoading:true — Tool Search does not support
   * input_examples on deferred tools (Anthropic docs 2026-03).
   * ToolRegistry.register() throws if both are set.
   */
  inputExamples?: Partial<TInput>[];
  /**
   * L1-3: Allowed callers for Programmatic Tool Calling (PTC).
   * Maps to Anthropic API's allowed_callers field — lets model-generated code
   * call this tool directly inside the sandbox, keeping intermediate results
   * out of the context window.
   */
  allowedCallers?: string[];
  /**
   * Trust level of outputs from this tool.
   * - "trusted" (default): tool output is treated as instructions/data from the agent framework.
   * - "untrusted": tool output comes from external/user-controlled content (e.g. web fetch, MCP).
   *   Untrusted outputs are wrapped in <untrusted_tool_output> delimiters by MessageAssembler
   *   to prevent indirect prompt injection (OWASP ASI01/ASI02).
   */
  trust?: "trusted" | "untrusted";
  /**
   * Optional sanitization hook called on the raw string output of this tool before it
   * enters the message context. Use to integrate Prompt Shields / LLM-Guard scanners.
   * Only called when trust is "untrusted" or the output is otherwise flagged.
   *
   * @param text  Raw string output from the tool.
   * @param ctx   Tool call context (toolName, callId, input args).
   * @returns     Sanitized string (may be the same as input).
   */
  sanitizeToolResult?: (
    text: string,
    ctx: { toolName: string; callId: string; input: unknown }
  ) => string | Promise<string>;
  /**
   * B2: Required write scopes for this tool (OWASP least-agency principle).
   * Only relevant when readOnly=false. If set, the calling principal must have
   * all listed scopes in grantedScopes, otherwise the call returns capability_denied.
   * Leave undefined to allow any caller (no scope restriction beyond readOnly).
   *
   * Example: writeScope: ["files:write"] to require an explicit files write grant.
   */
  writeScope?: string[];
  /**
   * C3: Optional hook to compress large tool results before they enter the context window.
   * Called on the raw output before stringification. Return a concise string representation.
   * Useful for tools returning large objects (e.g. search results with many fields).
   *
   * When set, the compressed string is used as the tool result in the message context.
   * The original output is still available in ToolResult.output for downstream processing.
   *
   * Receives result typed as `never` to allow assignment to any ToolDefinition<T, U>.
   */
  toModelOutput?: (result: never) => string;
  forward(input: TInput, signal?: AbortSignal): Promise<TOutput>;
  /**
   * A4: Optional resource key for conflict serialization.
   * Two !readOnly tools sharing the same resourceKey are automatically
   * serialized by the Scheduler (implicit dependsOn barrier).
   * Use this to prevent concurrent writes to the same external resource
   * (same file, same API endpoint, same DB row) without requiring callers
   * to manually wire dependsOn edges.
   *
   * Can be a static string or a function of the input (for per-call disambiguation).
   * The function receives input typed as `never` to allow assignment to any ToolDefinition<T>.
   */
  resourceKey?: string | ((input: never) => string);
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
  /**
   * Trust level of the tool output.
   * - "trusted": internal/first-party tools whose output is treated as instructions.
   * - "untrusted": external or MCP tools whose output is data, not instructions.
   *   MessageAssembler wraps untrusted outputs in <untrusted_tool_output> delimiters
   *   to prevent indirect prompt injection (OWASP ASI01/ASI02).
   */
  trust?: "trusted" | "untrusted";
  error?: {
    code: "validation_error" | "capability_denied" | "execution_error";
    message: string;
    /** Structured partial to retry only the failing part. */
    retryHint?: string;
  };
}
