import { zodToJsonSchema as zodToJsonSchemaLib } from "zod-to-json-schema";
import type { ToolCall, ToolDefinition, ToolResult } from "./types.js";

/** Converts a Zod schema to a JSON Schema object (OpenAPI 3.0 compatible). */
export function zodToJsonSchema(schema: import("zod").ZodSchema): object {
  return zodToJsonSchemaLib(schema, { target: "openApi3", $refStrategy: "none" });
}

/**
 * Registry that holds all tools available to an agent.
 *
 * Validates side-effect metadata at registration (D2) — a tool without
 * explicit readOnly/idempotent declarations is rejected so C3 speculative
 * execution always has accurate barrier data.
 */
export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): this {
    if (this.#tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    // D2: enforce explicit side-effect declarations at registration time.
    // TypeScript enforces this at compile time, but plain-JS callers bypass it.
    const toolAny = tool as unknown as Record<string, unknown>;
    if (typeof toolAny["readOnly"] !== "boolean") {
      throw new Error(
        `Tool "${tool.name}" must declare readOnly: boolean (required for C3 speculative execution)`
      );
    }
    if (typeof toolAny["idempotent"] !== "boolean") {
      throw new Error(
        `Tool "${tool.name}" must declare idempotent: boolean (required for C3/C4 caching)`
      );
    }
    if (!toolAny["inputSchema"] || typeof (toolAny["inputSchema"] as Record<string, unknown>)["safeParse"] !== "function") {
      throw new Error(
        `Tool "${tool.name}" must declare a Zod inputSchema with a safeParse method`
      );
    }
    this.#tools.set(tool.name, tool);
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.#tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.#tools.values()];
  }

  /**
   * JSON schema for all non-deferred tools — passed to model as tool definitions.
   * Deferred tools (deferLoading: true) are excluded; they are loaded on-demand.
   * Sorted by name for deterministic cache keys across registrations.
   */
  toJsonSchema(): object[] {
    return [...this.#tools.values()]
      .filter((t) => !t.deferLoading)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => {
        const schema: Record<string, unknown> = {
          name: t.name,
          description: t.description,
          input_schema: t.rawInputJsonSchema ?? (t.inputSchema ? zodToJsonSchema(t.inputSchema) : {}),
        };
        // L1-2: include few-shot examples when provided.
        if (t.inputExamples && t.inputExamples.length > 0) {
          schema["input_examples"] = t.inputExamples;
        }
        // L1-3: include allowed_callers for PTC when provided.
        if (t.allowedCallers && t.allowedCallers.length > 0) {
          schema["allowed_callers"] = t.allowedCallers;
        }
        return schema;
      });
  }

  /**
   * L1-1: JSON schema for deferred tools only.
   * Used by AnthropicModel to inject tool_search_tool_regex when deferLoading tools exist.
   */
  toDeferredJsonSchema(): object[] {
    return [...this.#tools.values()]
      .filter((t) => t.deferLoading)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.rawInputJsonSchema ?? (t.inputSchema ? zodToJsonSchema(t.inputSchema) : {}),
      }));
  }

  /** True when any registered tool has deferLoading: true. */
  get hasDeferred(): boolean {
    return [...this.#tools.values()].some((t) => t.deferLoading);
  }

  /** True when any registered tool has allowedCallers set (PTC mode). */
  get hasProgrammaticCallers(): boolean {
    return [...this.#tools.values()].some((t) => t.allowedCallers && t.allowedCallers.length > 0);
  }

  async call(toolCall: ToolCall, grantedCapabilities?: string[]): Promise<ToolResult> {
    const tool = this.#tools.get(toolCall.toolName);
    if (!tool) {
      return {
        callId: toolCall.callId,
        toolName: toolCall.toolName,
        output: null,
        error: {
          code: "execution_error",
          message: `Unknown tool: ${toolCall.toolName}`,
          retryHint: `Available tools: ${[...this.#tools.keys()].join(", ")}`,
        },
      };
    }

    // A2: check extraCapabilities if the tool declares a requirement.
    if (tool.requiredCapability) {
      const granted = grantedCapabilities ?? [];
      if (!granted.includes(tool.requiredCapability)) {
        return {
          callId: toolCall.callId,
          toolName: toolCall.toolName,
          output: null,
          error: {
            code: "capability_denied",
            message: `Tool "${tool.name}" requires capability "${tool.requiredCapability}" which has not been granted`,
            retryHint: `Grant the capability "${tool.requiredCapability}" in the agent's CapabilityManifest.extraCapabilities`,
          },
        };
      }
    }

    // Validate input with zod (D2 — replaces AgentParsingError retry loop).
    const parsed = tool.inputSchema.safeParse(toolCall.args);
    if (!parsed.success) {
      return {
        callId: toolCall.callId,
        toolName: toolCall.toolName,
        output: null,
        error: {
          code: "validation_error",
          message: parsed.error.message,
          retryHint: `Fix the arguments: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`,
        },
      };
    }

    try {
      const output = await tool.forward(parsed.data, toolCall.signal);
      return { callId: toolCall.callId, toolName: toolCall.toolName, output };
    } catch (err) {
      return {
        callId: toolCall.callId,
        toolName: toolCall.toolName,
        output: null,
        error: {
          code: "execution_error",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
}

