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

  /** JSON schema for all tools — passed to model as tool definitions (E1).
   * Sorted by name for deterministic cache keys across registrations. */
  toJsonSchema(): object[] {
    return [...this.#tools.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
        // Prefer rawInputJsonSchema (e.g. MCP server's own schema) over the Zod-derived
        // schema, which would discard field names and required constraints.
        input_schema: t.rawInputJsonSchema ?? (t.inputSchema ? zodToJsonSchema(t.inputSchema) : {}),
      }));
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

